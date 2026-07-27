/**
 * Heuristic handwriting detection and removal.
 *
 * Detection is per connected ink component, using shape statistics that
 * separate machine-printed glyphs from pen strokes:
 *
 *   - extent = area / bboxArea. Printed glyphs fill a good share of their
 *     own bounding box; a looping pen stroke sweeps a large box while
 *     covering little of it. This also keeps printed rules and table
 *     borders safe: a perfectly straight line has extent near 1.0, while a
 *     hand-drawn line wobbles and scores far lower.
 *   - circularity = 4*pi*area / boundary^2. Printed glyphs are compact;
 *     handwriting is long, thin and meandering, so it scores much lower.
 *   - colored fraction. Pen ink in a color other than the printed text is
 *     handwriting regardless of shape, but only when the *component* is
 *     mostly colored - judging per pixel would trip on JPEG color fringing
 *     around ordinary black text.
 *
 * A component is erased when it looks like a pen stroke by shape, or when
 * it is predominantly colored ink and is not a compact printed glyph.
 *
 * `createProcessor()` is the entry point used in production: it allocates
 * its scratch buffers once and reuses them across every page, which is what
 * makes processing hundreds of pages on a phone viable. The standalone
 * `detectHandwritingMask` / `removeHandwriting` wrappers below are
 * convenience entry points for tests and one-off use.
 */

import {
  computeGrayColorHist,
  otsuFromHistogram,
  thresholdInk,
  computeRunLengths,
  labelComponents,
  paintComponent,
  expandMaskThroughNonBackground,
  dilateBinary,
  inpaintMasked,
} from './imageProc.js';

export const DEFAULTS = {
  // Saturation a pixel needs to count as colored ink. Only the saturated
  // *core* of a pen stroke has to clear this - the halo is picked up later
  // by the non-background expansion - so it can stay high enough to ignore
  // compression color fringing around ordinary black text.
  colorSaturationThreshold: 60,
  // Fraction of a component's pixels that must be colored for the color
  // rule to fire.
  coloredFraction: 0.35,
  minComponentArea: 12,
  // Measured against rendered fixtures: printed glyphs never drop below
  // ~0.34 extent, while pen strokes sit at 0.08-0.21. Anything this sparse
  // is a stroke, whatever its circularity (thick straight-ish marks like a
  // hand-drawn check are sparse but not especially meandering).
  sparseExtentThreshold: 0.25,
  // The sparse-extent rule only applies to marks of a meaningful size: thin
  // diagonal glyphs and punctuation can be sparse too, and erasing printed
  // text is a worse failure than leaving a small pen dot behind. Expressed
  // as a fraction of page area so it tracks the render resolution.
  sparseMinAreaFraction: 0.00021,
  sparseMinAreaFloor: 100,
  extentThreshold: 0.32,
  circularityThreshold: 0.15,
  // A component containing an axis-aligned run this long, and spanning this
  // much of its own bounding box, is a printed rule / table border.
  straightRunMin: 30,
  straightRunFraction: 0.55,
  // Ink covering more than this share of the page means the "page" is
  // mostly dark (a photo, an inverted scan); the printed/handwritten
  // distinction is meaningless there, so detection is skipped.
  maxInkFraction: 0.55,
  // How far a stroke's halo is followed out through non-background pixels,
  // and how much darker than the page background a pixel must be to count
  // as part of that halo.
  //
  // The margin has to be tight. An anti-aliased stroke fades all the way up
  // to the background level, so a generous margin leaves exactly the
  // faintest ring behind: at margin 4 a test page kept ~15k pixels in the
  // 245-252 range - invisible per pixel, but plainly a ghost in aggregate -
  // against 838 at margin 1. Expansion is bounded by depth and starts only
  // from flagged strokes, so a near-background threshold cannot run away
  // across the page.
  haloDepth: 8,
  backgroundMargin: 1,
  // How close an inpainted pixel must land to the paper colour before it is
  // snapped to exactly that colour, removing the faint residue that
  // neighbour-averaging alone cannot get rid of.
  backgroundSnap: 14,
  dilateRadius: 2,
};

/** Shape/color features for one connected ink component. */
export function componentFeatures(comp) {
  const extent = comp.area / (comp.w * comp.h);
  const circularity = comp.boundary > 0 ? (4 * Math.PI * comp.area) / (comp.boundary * comp.boundary) : 1;
  const coloredFraction = comp.area > 0 ? comp.coloredCount / comp.area : 0;
  return { extent, circularity, coloredFraction };
}

/**
 * True for printed rules, underlines and table borders: one long,
 * perfectly straight axis-aligned run spanning most of the shape.
 */
export function isPrintedRule(comp, opts = DEFAULTS) {
  const h = comp.maxHRun || 0;
  const v = comp.maxVRun || 0;
  return (
    (h >= opts.straightRunMin && h >= opts.straightRunFraction * comp.w) ||
    (v >= opts.straightRunMin && v >= opts.straightRunFraction * comp.h)
  );
}

/** Decide whether a component is handwriting. */
export function isHandwriting(comp, opts = DEFAULTS) {
  if (comp.area < opts.minComponentArea) return false;

  // Document structure is never treated as handwriting. Checked first
  // because table frames are large sparse shapes that every test below
  // would otherwise flag.
  if (isPrintedRule(comp, opts)) return false;

  const { extent, circularity, coloredFraction } = componentFeatures(comp);
  const sparseMinArea = opts.sparseMinArea != null
    ? opts.sparseMinArea
    : opts.sparseMinAreaFloor;

  if (extent < opts.sparseExtentThreshold && comp.area >= sparseMinArea) return true;
  if (extent < opts.extentThreshold && circularity < opts.circularityThreshold) return true;

  // Colored ink shaped like a stroke rather than a glyph. Printed colored
  // headings are compact (circularity ~0.25-0.55), so they survive.
  if (coloredFraction >= opts.coloredFraction && circularity < opts.circularityThreshold) return true;

  return false;
}

/**
 * A reusable page processor. Buffers are allocated on first use and grown
 * only when a larger page arrives.
 */
export function createProcessor() {
  let cap = 0;
  let gray, colored, ink, visited, hwMask, tmp, dilated, scratch32, hRun, vRun;
  const hist = new Uint32Array(256);

  function ensure(n) {
    if (n <= cap) return;
    gray = new Uint8Array(n);
    colored = new Uint8Array(n);
    ink = new Uint8Array(n);
    visited = new Uint8Array(n);
    hwMask = new Uint8Array(n);
    tmp = new Uint8Array(n);
    dilated = new Uint8Array(n);
    scratch32 = new Int32Array(n);
    hRun = new Uint16Array(n);
    vRun = new Uint16Array(n);
    cap = n;
  }

  /**
   * Detect and erase handwriting on one page. `rgba` is modified in place.
   *
   * @returns {{maskedPixels: number, components: number, flagged: number,
   *            mask: Uint8Array|null}} `mask` (when `wantMask`) is the
   *   pre-dilation detection mask, valid only until the next `process` call.
   */
  function process(rgba, width, height, options = {}, wantMask = false) {
    const opts = { ...DEFAULTS, ...options };
    const n = width * height;
    if (opts.sparseMinArea == null) {
      opts.sparseMinArea = Math.max(opts.sparseMinAreaFloor, opts.sparseMinAreaFraction * n);
    }
    ensure(n);

    computeGrayColorHist(rgba, n, opts.colorSaturationThreshold, gray, colored, hist);
    const otsu = otsuFromHistogram(hist, n);
    const inkCount = thresholdInk(gray, n, otsu, ink);

    const empty = { maskedPixels: 0, components: 0, flagged: 0, mask: null };
    if (inkCount === 0 || inkCount > n * opts.maxInkFraction) return empty;

    computeRunLengths(ink, width, height, hRun, vRun);
    const stats = labelComponents(ink, width, height, colored, hRun, vRun, visited, scratch32);

    hwMask.fill(0, 0, n);
    let flagged = 0;
    let maskedPixels = 0;
    for (const comp of stats) {
      if (!isHandwriting(comp, opts)) continue;
      maskedPixels += paintComponent(comp.seed, width, height, visited, scratch32, hwMask);
      flagged++;
    }

    if (flagged === 0) return { ...empty, components: stats.length };

    // Follow each stroke's anti-aliasing/compression halo out to clean
    // paper. The page background is the dominant gray level, so anything
    // meaningfully darker than it still counts as part of the mark.
    let mode = 255;
    let modeCount = 0;
    for (let v = 0; v < 256; v++) {
      if (hist[v] > modeCount) {
        modeCount = hist[v];
        mode = v;
      }
    }
    const bgThreshold = Math.max(otsu + 1, mode - opts.backgroundMargin);
    maskedPixels += expandMaskThroughNonBackground(
      hwMask, gray, width, height, bgThreshold, opts.haloDepth, visited, scratch32
    );

    // Average colour of the paper itself, so erased areas can be filled
    // with it rather than with a slightly-grey diffusion of the halo.
    let bgR = 0;
    let bgG = 0;
    let bgB = 0;
    let bgCount = 0;
    const paperLevel = Math.max(0, mode - 2);
    for (let i = 0; i < n; i++) {
      if (gray[i] < paperLevel) continue;
      const o = i * 4;
      bgR += rgba[o];
      bgG += rgba[o + 1];
      bgB += rgba[o + 2];
      bgCount++;
    }
    const background = bgCount > 0
      ? {
          r: Math.round(bgR / bgCount),
          g: Math.round(bgG / bgCount),
          b: Math.round(bgB / bgCount),
          snap: opts.backgroundSnap,
        }
      : null;

    // Keep a copy of what will actually be erased, for the preview.
    const maskCopy = wantMask ? hwMask.slice(0, n) : null;

    dilateBinary(hwMask, width, height, opts.dilateRadius, tmp, dilated);
    // `visited` is finished with by now, so it doubles as the BFS state map.
    inpaintMasked(rgba, dilated, n, width, height, visited, scratch32, background);

    return { maskedPixels, components: stats.length, flagged, mask: maskCopy };
  }

  return { process };
}

let sharedProcessor = null;
function shared() {
  if (!sharedProcessor) sharedProcessor = createProcessor();
  return sharedProcessor;
}

/**
 * Convenience wrapper: returns the (pre-dilation) handwriting mask for an
 * image, leaving the input untouched.
 */
export function detectHandwritingMask(rgba, width, height, options = {}) {
  const copy = new Uint8ClampedArray(rgba);
  const result = shared().process(copy, width, height, options, true);
  return result.mask || new Uint8Array(width * height);
}

/** Convenience wrapper: returns a cleaned copy of the image. */
export function removeHandwriting(rgba, mask, width, height, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const n = width * height;
  const out = new Uint8ClampedArray(rgba);
  const tmp = new Uint8Array(n);
  const dilated = new Uint8Array(n);
  dilateBinary(mask, width, height, opts.dilateRadius, tmp, dilated);
  inpaintMasked(out, dilated, n, width, height, new Uint8Array(n), new Int32Array(n));
  return out;
}

/** Overlay detected handwriting in red, for the before/after preview. */
export function visualizeMask(rgba, mask, width, height) {
  const out = new Uint8ClampedArray(rgba);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0) continue;
    const o = i * 4;
    out[o] = 128 + (out[o] >> 1);
    out[o + 1] = out[o + 1] >> 1;
    out[o + 2] = out[o + 2] >> 1;
  }
  return out;
}
