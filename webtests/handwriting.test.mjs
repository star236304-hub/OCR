import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { createProcessor, detectHandwritingMask, DEFAULTS, isHandwriting } from '../web/js/handwriting.js';
import {
  computeGrayColorHist,
  otsuFromHistogram,
  thresholdInk,
  computeRunLengths,
  labelComponents,
} from '../web/js/imageProc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const png = PNG.sync.read(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
  return { width: png.width, height: png.height, data: png.data };
}

function countMaskInRegion(mask, width, x0, y0, x1, y1) {
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask[y * width + x] !== 0) count++;
    }
  }
  return count;
}

/** Classify every component of a fixture, grouped by the region it sits in. */
function classifyByRegion(fixture, regionOf) {
  const { width, height, data } = fixture;
  const n = width * height;
  const gray = new Uint8Array(n);
  const colored = new Uint8Array(n);
  const ink = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const hRun = new Uint16Array(n);
  const vRun = new Uint16Array(n);
  const hist = new Uint32Array(256);

  computeGrayColorHist(data, n, DEFAULTS.colorSaturationThreshold, gray, colored, hist);
  thresholdInk(gray, n, otsuFromHistogram(hist, n), ink);
  computeRunLengths(ink, width, height, hRun, vRun);
  const stats = labelComponents(ink, width, height, colored, hRun, vRun, visited, stack);

  const opts = {
    ...DEFAULTS,
    sparseMinArea: Math.max(DEFAULTS.sparseMinAreaFloor, DEFAULTS.sparseMinAreaFraction * n),
  };
  const byRegion = {};
  for (const comp of stats) {
    if (comp.area < DEFAULTS.minComponentArea) continue;
    const region = regionOf(comp);
    byRegion[region] = byRegion[region] || { total: 0, flagged: 0 };
    byRegion[region].total++;
    if (isHandwriting(comp, opts)) byRegion[region].flagged++;
  }
  return byRegion;
}

// mixed_document.png layout (1000x700), by vertical band:
//   y <130 printed black text        y 130-190 printed COLORED heading
//   y 190-340 printed table + text   y 340-470 colored pen marks
//   y >470 black pen marks
const mixedRegion = (comp) => {
  const cy = comp.y + comp.h / 2;
  if (cy < 130) return 'printedText';
  if (cy < 190) return 'printedColorHeading';
  if (cy < 340) return 'printedTable';
  if (cy < 470) return 'coloredHandwriting';
  return 'blackHandwriting';
};

test('printed black text is never flagged as handwriting', () => {
  const r = classifyByRegion(loadFixture('mixed_document.png'), mixedRegion);
  assert.ok(r.printedText.total > 20, 'fixture should contain many printed glyphs');
  assert.equal(r.printedText.flagged, 0);
});

test('printed colored headings survive the colored-ink rule', () => {
  const r = classifyByRegion(loadFixture('mixed_document.png'), mixedRegion);
  assert.ok(r.printedColorHeading.total > 5);
  assert.equal(r.printedColorHeading.flagged, 0);
});

test('table borders and rules are kept, not mistaken for pen strokes', () => {
  const r = classifyByRegion(loadFixture('mixed_document.png'), mixedRegion);
  assert.ok(r.printedTable.total > 10);
  assert.equal(r.printedTable.flagged, 0);
});

test('every colored pen mark is flagged', () => {
  const r = classifyByRegion(loadFixture('mixed_document.png'), mixedRegion);
  assert.ok(r.coloredHandwriting.total >= 2);
  assert.equal(r.coloredHandwriting.flagged, r.coloredHandwriting.total);
});

test('every black pen mark is flagged, including a thick check mark', () => {
  const r = classifyByRegion(loadFixture('mixed_document.png'), mixedRegion);
  assert.ok(r.blackHandwriting.total >= 3);
  assert.equal(r.blackHandwriting.flagged, r.blackHandwriting.total);
});

test('processing erases pen marks and leaves printed content byte-identical', () => {
  const { width, height, data } = loadFixture('mixed_document.png');
  const rgba = new Uint8ClampedArray(data);
  const result = createProcessor().process(rgba, width, height, {}, true);

  assert.equal(result.flagged, 5, 'the fixture has exactly five pen marks');

  // Pen marks are gone: nothing saturated is left in the colored-ink band.
  let coloredRemaining = 0;
  for (let y = 340; y < 470; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) coloredRemaining++;
    }
  }
  assert.equal(coloredRemaining, 0, `${coloredRemaining} colored pixels survived`);

  // ...and no dark ink is left where the black pen marks were.
  let darkRemaining = 0;
  for (let y = 495; y < 600; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (rgba[o] < 128 && rgba[o + 1] < 128 && rgba[o + 2] < 128) darkRemaining++;
    }
  }
  assert.equal(darkRemaining, 0, `${darkRemaining} dark pixels survived`);

  // Printed text, heading and table (everything above y=340) is untouched.
  let maxDiff = 0;
  for (let i = 0; i < 340 * width * 4; i++) {
    const diff = Math.abs(rgba[i] - data[i]);
    if (diff > maxDiff) maxDiff = diff;
  }
  assert.equal(maxDiff, 0, `printed content changed by up to ${maxDiff}`);
});

test('a page with no handwriting is returned untouched', () => {
  const { width, height, data } = loadFixture('mixed_document.png');
  // Crop to the printed-only top band.
  const h = 330;
  const cropped = new Uint8ClampedArray(data.subarray(0, width * h * 4));
  const before = new Uint8ClampedArray(cropped);

  const result = createProcessor().process(cropped, width, h);
  assert.equal(result.flagged, 0);
  assert.equal(result.maskedPixels, 0);
  assert.deepEqual(cropped, before);
});

test('the processor reuses buffers across differently sized pages', () => {
  const processor = createProcessor();
  const big = loadFixture('mixed_document.png');
  processor.process(new Uint8ClampedArray(big.data), big.width, big.height);

  const small = loadFixture('printed_and_scribbles.png');
  const rgba = new Uint8ClampedArray(small.data);
  const result = processor.process(rgba, small.width, small.height);
  assert.ok(result.flagged > 0, 'smaller page still detects its scribbles');
});

// scanned_artifacts.png is mixed_document.png resampled and JPEG-compressed,
// which is what a real scan looks like: every stroke carries an anti-aliased,
// ring-artifacted halo that is too light to threshold as ink but dark enough
// to read as a ghost once the stroke itself is erased.
test('erasing a compressed scan leaves no visible ghost', () => {
  const { width, height, data } = loadFixture('scanned_artifacts.png');
  const rgba = new Uint8ClampedArray(data);
  createProcessor().process(rgba, width, height);

  const countBelow = (buf, threshold, y0, y1) => {
    let count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (Math.min(buf[o], buf[o + 1], buf[o + 2]) < threshold) count++;
      }
    }
    return count;
  };

  // Handwriting band of this fixture is y 420-780.
  const before = countBelow(data, 250, 420, 780);
  const after = countBelow(rgba, 250, 420, 780);
  assert.ok(before > 20000, 'fixture should start with substantial pen ink');
  assert.equal(countBelow(rgba, 235, 420, 780), 0, 'no visible residue may remain');
  assert.ok(
    after < before * 0.05,
    `expected the halo to be cleared too, ${after} of ${before} near-background pixels remain`
  );

  // A band of bare paper stays bare - the halo expansion must not spill.
  assert.equal(countBelow(rgba, 250, 790, 860), 0);
});

test('detectHandwritingMask flags the scribbles but not the printed line', () => {
  const { width, height, data } = loadFixture('printed_and_scribbles.png');
  const mask = detectHandwritingMask(data, width, height);
  assert.equal(countMaskInRegion(mask, width, 20, 20, 700, 130), 0, 'printed text untouched');
  assert.ok(countMaskInRegion(mask, width, 40, 170, 400, 250) > 0, 'red scribble flagged');
  assert.ok(countMaskInRegion(mask, width, 40, 290, 320, 370) > 0, 'black scribble flagged');
});
