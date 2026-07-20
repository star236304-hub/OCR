/**
 * Pure-JS pixel processing primitives (no WASM/OpenCV dependency).
 *
 * Everything here operates on a flat RGBA buffer (Uint8Array or
 * Uint8ClampedArray, 4 bytes/pixel - the same layout as Canvas ImageData)
 * plus width/height, so the same code runs in the browser (fed from
 * canvas.getContext('2d').getImageData) and in Node (fed from a decoded
 * PNG) for testing.
 */

export function toGray(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = (0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]) | 0;
  }
  return gray;
}

export function toSaturation(rgba, width, height) {
  const n = width * height;
  const sat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sat[i] = max === 0 ? 0 : Math.round(((max - min) / max) * 255);
  }
  return sat;
}

export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0, wB = 0, maxVar = -1, threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }
  return threshold;
}

/** Foreground (255) where gray <= threshold (i.e. "ink" on a light page). */
export function binarizeInkFromGray(gray, threshold) {
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] <= threshold ? 255 : 0;
  return out;
}

export function thresholdAbove(values, threshold) {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i] > threshold ? 255 : 0;
  return out;
}

/** a AND NOT(bExclude), both 0/255 masks. */
export function maskAndNot(a, bExclude) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] !== 0 && bExclude[i] === 0 ? 255 : 0;
  return out;
}

export function maskOr(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] !== 0 || b[i] !== 0 ? 255 : 0;
  return out;
}

export function dilate(mask, width, height, radius = 1) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx] !== 0) {
            hit = true;
            break;
          }
        }
      }
      out[y * width + x] = hit ? 255 : 0;
    }
  }
  return out;
}

/**
 * Two-pass chamfer distance transform (3-4 weights): approximate Euclidean
 * distance from each foreground (255) pixel to the nearest background (0)
 * pixel. Stands in for cv2.distanceTransform - good enough to estimate
 * stroke half-width per connected component.
 */
export function chamferDistanceTransform(binary, width, height) {
  const INF = 1e6;
  const dist = new Float32Array(width * height);
  for (let i = 0; i < dist.length; i++) dist[i] = binary[i] !== 0 ? INF : 0;

  const D1 = 1;
  const D2 = Math.SQRT2;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (dist[idx] === 0) continue;
      let best = dist[idx];
      if (x > 0) best = Math.min(best, dist[idx - 1] + D1);
      if (y > 0) best = Math.min(best, dist[idx - width] + D1);
      if (x > 0 && y > 0) best = Math.min(best, dist[idx - width - 1] + D2);
      if (x < width - 1 && y > 0) best = Math.min(best, dist[idx - width + 1] + D2);
      dist[idx] = best;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const idx = row + x;
      if (dist[idx] === 0) continue;
      let best = dist[idx];
      if (x < width - 1) best = Math.min(best, dist[idx + 1] + D1);
      if (y < height - 1) best = Math.min(best, dist[idx + width] + D1);
      if (x < width - 1 && y < height - 1) best = Math.min(best, dist[idx + width + 1] + D2);
      if (x > 0 && y < height - 1) best = Math.min(best, dist[idx + width - 1] + D2);
      dist[idx] = best;
    }
  }
  return dist;
}

/**
 * 8-connectivity connected-components labeling via iterative flood fill
 * (explicit stack, so it can't blow the call stack on large ink regions).
 * Returns 1-based labels (0 = background) plus per-component bounding
 * box + area stats.
 */
export function connectedComponents(binary, width, height) {
  const labels = new Int32Array(width * height);
  const stats = [];
  const stack = new Int32Array(width * height);
  let nextLabel = 1;

  for (let start = 0; start < binary.length; start++) {
    if (binary[start] === 0 || labels[start] !== 0) continue;

    let sp = 0;
    stack[sp++] = start;
    labels[start] = nextLabel;

    let minX = start % width;
    let maxX = minX;
    let minY = (start / width) | 0;
    let maxY = minY;
    let area = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (binary[nIdx] !== 0 && labels[nIdx] === 0) {
            labels[nIdx] = nextLabel;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    stats.push({ label: nextLabel, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
    nextLabel++;
  }

  return { labels, stats };
}

/** Count of a component's pixels that touch the background or image edge. */
export function perimeter(labels, width, height, comp) {
  let p = 0;
  for (let y = comp.y; y < comp.y + comp.h; y++) {
    for (let x = comp.x; x < comp.x + comp.w; x++) {
      const idx = y * width + x;
      if (labels[idx] !== comp.label) continue;
      if (
        x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
        labels[idx - 1] !== comp.label || labels[idx + 1] !== comp.label ||
        labels[idx - width] !== comp.label || labels[idx + width] !== comp.label
      ) {
        p++;
      }
    }
  }
  return p;
}
