/**
 * Heuristic handwriting detection and removal - browser counterpart to the
 * server-side app/handwriting.py, using plain-JS pixel processing instead
 * of OpenCV (see imageProc.js) so it runs anywhere without a WASM payload.
 *
 * Two signals, same spirit as the Python version but re-tuned empirically
 * against rendered test fixtures (see web/js/*.test.mjs):
 *   1. Colored ink (HSV saturation threshold) - catches pen marks in a
 *      different color than printed black text.
 *   2. Black ink shaped like handwriting: printed glyphs are dense and
 *      fairly compact within their own bounding box (high "extent" =
 *      area/bboxArea, and high "circularity" = 4*pi*area/perimeter^2),
 *      while cursive strokes and loops are sparse and elongated (low
 *      extent and circularity). This turned out to separate real vs.
 *      handwritten ink far better than a stroke-width-variance measure
 *      (the Python version's approach) did once ported to JS - printed
 *      multi-letter connected components have just as much stroke-width
 *      variance as handwriting, but nowhere near as much "loopiness".
 */

import {
  toGray,
  toSaturation,
  otsuThreshold,
  binarizeInkFromGray,
  thresholdAbove,
  maskAndNot,
  maskOr,
  dilate,
  connectedComponents,
  perimeter,
} from './imageProc.js';

const DEFAULTS = {
  colorSaturationThreshold: 18,
  minComponentArea: 6,
  extentThreshold: 0.32,
  circularityThreshold: 0.15,
};

export function detectHandwritingMask(rgba, width, height, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  const gray = toGray(rgba, width, height);
  const saturation = toSaturation(rgba, width, height);
  const coloredMask = thresholdAbove(saturation, opts.colorSaturationThreshold);

  const otsu = otsuThreshold(gray);
  const inkMask = binarizeInkFromGray(gray, otsu);
  const blackInk = maskAndNot(inkMask, coloredMask);

  const { labels, stats } = connectedComponents(blackInk, width, height);
  const blackHandwriting = new Uint8Array(width * height);

  for (const comp of stats) {
    if (comp.area < opts.minComponentArea) continue;

    const extent = comp.area / (comp.w * comp.h);
    const p = perimeter(labels, width, height, comp);
    const circularity = p > 0 ? (4 * Math.PI * comp.area) / (p * p) : 1;

    if (extent < opts.extentThreshold && circularity < opts.circularityThreshold) {
      for (let y = comp.y; y < comp.y + comp.h; y++) {
        const row = y * width;
        for (let x = comp.x; x < comp.x + comp.w; x++) {
          const idx = row + x;
          if (labels[idx] === comp.label) blackHandwriting[idx] = 255;
        }
      }
    }
  }

  return maskOr(coloredMask, blackHandwriting);
}

/**
 * Erase masked ink with a boundary-inward fill: each pass, every masked
 * pixel that borders an already-known pixel gets the average color of its
 * known neighbors and is marked known itself, then the next pass fills the
 * next ring inward. This fully resolves a stroke in roughly
 * (stroke width / 2) passes instead of the hundreds of iterations a
 * from-scratch diffusion relaxation would need to converge - important
 * since this runs on-device (including on phones/tablets). Not
 * texture-aware inpainting, but that's not needed for erasing ink off an
 * otherwise plain page.
 */
export function removeHandwriting(rgba, mask, width, height, options = {}) {
  const { dilateRadius = 3, padding = 6 } = options;
  const dilated = dilate(mask, width, height, dilateRadius);
  const out = new Uint8ClampedArray(rgba);

  const { stats } = connectedComponents(dilated, width, height);

  for (const comp of stats) {
    const x0 = Math.max(0, comp.x - padding);
    const y0 = Math.max(0, comp.y - padding);
    const x1 = Math.min(width - 1, comp.x + comp.w - 1 + padding);
    const y1 = Math.min(height - 1, comp.y + comp.h - 1 + padding);
    const rw = x1 - x0 + 1;
    const rh = y1 - y0 + 1;

    const unknown = new Uint8Array(rw * rh);
    let unknownCount = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        if (dilated[(y0 + y) * width + (x0 + x)] !== 0) {
          unknown[y * rw + x] = 1;
          unknownCount++;
        }
      }
    }

    const maxPasses = rw + rh;
    for (let pass = 0; pass < maxPasses && unknownCount > 0; pass++) {
      let resolvedThisPass = 0;
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const li = y * rw + x;
          if (!unknown[li]) continue;

          let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= rh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= rw) continue;
              if (unknown[ny * rw + nx]) continue;
              const o = ((y0 + ny) * width + (x0 + nx)) * 4;
              rSum += out[o];
              gSum += out[o + 1];
              bSum += out[o + 2];
              cnt++;
            }
          }
          if (cnt > 0) {
            const o = ((y0 + y) * width + (x0 + x)) * 4;
            out[o] = rSum / cnt;
            out[o + 1] = gSum / cnt;
            out[o + 2] = bSum / cnt;
            unknown[li] = 0;
            resolvedThisPass++;
          }
        }
      }
      unknownCount -= resolvedThisPass;
      if (resolvedThisPass === 0) break;
    }
  }

  return out;
}

/** Overlay detected handwriting regions in red, for the before/after UI. */
export function visualizeMask(rgba, mask, width, height) {
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < width * height; i++) {
    if (mask[i] === 0) continue;
    const o = i * 4;
    out[o] = Math.round(0.5 * 255 + 0.5 * out[o]);
    out[o + 1] = Math.round(0.5 * out[o + 1]);
    out[o + 2] = Math.round(0.5 * out[o + 2]);
  }
  return out;
}
