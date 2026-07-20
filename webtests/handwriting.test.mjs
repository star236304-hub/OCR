import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

import { detectHandwritingMask, removeHandwriting } from '../web/js/handwriting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  const png = PNG.sync.read(buf);
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

// Fixture layout (1000x500, at CSS-pixel coordinates before any scaling):
//   "PROJECT REPORT 2026" printed at y ~30-75
//   "This document is approved." printed at y ~90-125
//   red pen scribble (colored ink) around y 180-240
//   black wavy scribble (irregular black ink) around y 300-360

test('printed text is not flagged as handwriting', () => {
  const { data, width } = loadFixture('printed_and_scribbles.png');
  const mask = detectHandwritingMask(data, width, 500);
  const hits = countMaskInRegion(mask, width, 20, 20, 700, 130);
  assert.equal(hits, 0, `expected no mask pixels over printed text, got ${hits}`);
});

test('colored pen scribble is flagged as handwriting', () => {
  const { data, width } = loadFixture('printed_and_scribbles.png');
  const mask = detectHandwritingMask(data, width, 500);
  const hits = countMaskInRegion(mask, width, 40, 170, 400, 250);
  assert.ok(hits > 0, 'expected the red scribble region to be flagged');
});

test('irregular black ink scribble is flagged as handwriting', () => {
  const { data, width } = loadFixture('printed_and_scribbles.png');
  const mask = detectHandwritingMask(data, width, 500);
  const hits = countMaskInRegion(mask, width, 40, 290, 320, 370);
  assert.ok(hits > 0, 'expected the black scribble region to be flagged');
});

test('removeHandwriting erases scribbles and keeps printed text pixels intact', () => {
  const { data, width, height } = loadFixture('printed_and_scribbles.png');
  const mask = detectHandwritingMask(data, width, height);
  const cleaned = removeHandwriting(data, mask, width, height);

  // No strongly-colored (red) pixels should remain where the red scribble was.
  let coloredRemaining = 0;
  for (let y = 170; y <= 250; y++) {
    for (let x = 40; x <= 400; x++) {
      const o = (y * width + x) * 4;
      const r = cleaned[o], g = cleaned[o + 1], b = cleaned[o + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) coloredRemaining++;
    }
  }
  assert.equal(coloredRemaining, 0, `expected the red scribble to be fully inpainted, ${coloredRemaining} colored pixels remain`);

  // Printed text pixels should be essentially unchanged (allow minor rounding).
  let maxDiff = 0;
  for (let y = 20; y <= 130; y++) {
    for (let x = 20; x <= 700; x++) {
      const o = (y * width + x) * 4;
      const diff = Math.abs(cleaned[o] - data[o]) + Math.abs(cleaned[o + 1] - data[o + 1]) + Math.abs(cleaned[o + 2] - data[o + 2]);
      if (diff > maxDiff) maxDiff = diff;
    }
  }
  assert.equal(maxDiff, 0, `expected printed text region to be untouched, max channel diff sum was ${maxDiff}`);
});
