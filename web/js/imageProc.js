/**
 * Pixel-processing primitives for handwriting removal.
 *
 * Everything operates on flat typed arrays (RGBA laid out like Canvas
 * ImageData) and takes its scratch buffers as arguments, so the caller can
 * allocate once and reuse across every page of a document. That matters a
 * lot here: a 1240x1754 page is ~2.2M pixels, and re-allocating ~25MB of
 * scratch per page would dominate the runtime (and blow up memory) on a
 * phone processing a few hundred pages.
 */

/**
 * Single fused pass computing luma, a "colored ink" flag, and the luma
 * histogram. Fusing these avoids three separate walks over a multi-megabyte
 * buffer, which is memory-bandwidth bound on mobile.
 *
 * Saturation is compared without dividing: sat > t  <=>  (max-min)*255 > t*max.
 */
export function computeGrayColorHist(rgba, n, satThreshold, gray, colored, hist) {
  hist.fill(0);
  let coloredCount = 0;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];

    // Integer approximation of 0.299R + 0.587G + 0.114B.
    const y = (r * 77 + g * 150 + b * 29) >> 8;
    gray[i] = y;
    hist[y]++;

    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const c = (max - min) * 255 > satThreshold * max ? 1 : 0;
    colored[i] = c;
    coloredCount += c;
  }
  return coloredCount;
}

/** Otsu's threshold straight from a precomputed 256-bin histogram. */
export function otsuFromHistogram(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 0;
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

/** ink[i] = 1 where the pixel is dark enough to be ink (gray <= threshold). */
export function thresholdInk(gray, n, threshold, ink) {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i] <= threshold ? 1 : 0;
    ink[i] = v;
    count += v;
  }
  return count;
}

/**
 * For every ink pixel, the length of the maximal horizontal and vertical
 * run of ink it belongs to.
 *
 * This is what tells a printed rule or table border apart from a pen
 * stroke: a printed line is a single long axis-aligned run, while even a
 * deliberately straight hand-drawn line wobbles by a pixel or two and so
 * breaks into short runs. Both are otherwise sparse shapes that the
 * extent/circularity tests would happily flag as handwriting.
 */
export function computeRunLengths(ink, width, height, hRun, vRun) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      if (ink[row + x] === 0) {
        hRun[row + x] = 0;
        x++;
        continue;
      }
      const start = x;
      while (x < width && ink[row + x] !== 0) x++;
      const len = x - start;
      for (let k = start; k < x; k++) hRun[row + k] = len;
    }
  }

  // Vertical runs are computed as two row-major sweeps rather than by
  // walking each column: a column-major traversal touches a new cache line
  // on every single pixel, and on a multi-megapixel page that dominated the
  // whole detection stage. `column` holds the run length carried between
  // adjacent rows and is only `width` entries wide.
  const column = new Uint16Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      const up = ink[idx] !== 0 ? column[x] + 1 : 0;
      column[x] = up;
      vRun[idx] = up;
    }
  }
  column.fill(0);
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (ink[idx] === 0) {
        column[x] = 0;
        vRun[idx] = 0;
        continue;
      }
      const down = column[x] + 1;
      column[x] = down;
      // vRun currently holds the run length ending here from above.
      vRun[idx] = vRun[idx] + down - 1;
    }
  }
}

/**
 * Chamfer (3-4) distance transform of the ink mask: for every ink pixel,
 * roughly 3x its distance to the nearest background pixel. Two passes, all
 * integer arithmetic.
 *
 * On the ridge of a stroke this value is 3x the local half-width, which is
 * what separates a printed shape from a drawn one: printing lays down a
 * constant stroke width, while a pen varies with pressure and speed.
 */
export function chamferDistanceTransform(ink, width, height, dist) {
  const INF = 65000;
  const n = width * height;
  for (let i = 0; i < n; i++) dist[i] = ink[i] !== 0 ? INF : 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (dist[idx] === 0) continue;
      let best = dist[idx];
      if (x > 0 && dist[idx - 1] + 3 < best) best = dist[idx - 1] + 3;
      if (y > 0) {
        if (dist[idx - width] + 3 < best) best = dist[idx - width] + 3;
        if (x > 0 && dist[idx - width - 1] + 4 < best) best = dist[idx - width - 1] + 4;
        if (x < width - 1 && dist[idx - width + 1] + 4 < best) best = dist[idx - width + 1] + 4;
      }
      dist[idx] = best;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      const idx = row + x;
      if (dist[idx] === 0) continue;
      let best = dist[idx];
      if (x < width - 1 && dist[idx + 1] + 3 < best) best = dist[idx + 1] + 3;
      if (y < height - 1) {
        if (dist[idx + width] + 3 < best) best = dist[idx + width] + 3;
        if (x < width - 1 && dist[idx + width + 1] + 4 < best) best = dist[idx + width + 1] + 4;
        if (x > 0 && dist[idx + width - 1] + 4 < best) best = dist[idx + width - 1] + 4;
      }
      dist[idx] = best;
    }
  }
}

/**
 * 8-connected component labeling over `ink`, computing every statistic the
 * classifier needs in the same traversal (area, bbox, boundary-pixel count,
 * colored-pixel count, longest axis-aligned runs, and stroke-width samples
 * taken along each stroke's ridge).
 *
 * Rather than storing a full Int32 label image (~9MB/page), each component
 * records only its seed pixel; `paintComponent` re-walks a component later
 * if — and only if — it was classified as handwriting. Handwriting is
 * usually a small fraction of a page, so the second walk is cheap and we
 * save the label image entirely.
 *
 * `visited` is marked 1 for every ink pixel reached here.
 */
export function labelComponents(ink, width, height, colored, hRun, vRun, dist, visited, stack) {
  visited.fill(0);
  const stats = [];
  const n = width * height;

  for (let start = 0; start < n; start++) {
    if (ink[start] === 0 || visited[start] !== 0) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    let minX = start % width;
    let maxX = minX;
    let minY = (start / width) | 0;
    let maxY = minY;
    let area = 0;
    let boundary = 0;
    let coloredCount = 0;
    let maxHRun = 0;
    let maxVRun = 0;
    let ridgeCount = 0;
    let ridgeSum = 0;
    let ridgeSumSq = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;

      area++;
      if (colored[idx] !== 0) coloredCount++;
      if (hRun[idx] > maxHRun) maxHRun = hRun[idx];
      if (vRun[idx] > maxVRun) maxVRun = vRun[idx];

      // Ridge pixels (local maxima of the distance transform) sit at the
      // centre of the stroke, so their value tracks the local half-width.
      const dv = dist[idx];
      if (
        dv > 0 &&
        (x === 0 || dist[idx - 1] <= dv) &&
        (x === width - 1 || dist[idx + 1] <= dv) &&
        (y === 0 || dist[idx - width] <= dv) &&
        (y === height - 1 || dist[idx + width] <= dv)
      ) {
        ridgeCount++;
        ridgeSum += dv;
        ridgeSumSq += dv * dv;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // A pixel is on the boundary if any 4-neighbour is background or edge.
      // (Two distinct 8-connected components can never be 4-adjacent, so
      // testing `ink` here is equivalent to testing the component label.)
      if (
        x === 0 || ink[idx - 1] === 0 ||
        x === width - 1 || ink[idx + 1] === 0 ||
        y === 0 || ink[idx - width] === 0 ||
        y === height - 1 || ink[idx + width] === 0
      ) {
        boundary++;
      }

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = nRow + nx;
          if (ink[nIdx] !== 0 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    stats.push({
      seed: start,
      x: minX,
      y: minY,
      w: maxX - minX + 1,
      h: maxY - minY + 1,
      area,
      boundary,
      coloredCount,
      maxHRun,
      maxVRun,
      ridgeCount,
      ridgeSum,
      ridgeSumSq,
    });
  }

  return stats;
}

/**
 * Re-walk the component containing `seed` (pixels with visited === 1, which
 * `labelComponents` set) and write 255 into `out` for each of its pixels.
 * Visited pixels are re-marked 2 so a component is never painted twice.
 */
export function paintComponent(seed, width, height, visited, stack, out) {
  if (visited[seed] !== 1) return 0;
  let sp = 0;
  stack[sp++] = seed;
  visited[seed] = 2;
  let painted = 0;

  while (sp > 0) {
    const idx = stack[--sp];
    out[idx] = 255;
    painted++;
    const x = idx % width;
    const y = (idx / width) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const nRow = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIdx = nRow + nx;
        if (visited[nIdx] === 1) {
          visited[nIdx] = 2;
          stack[sp++] = nIdx;
        }
      }
    }
  }
  return painted;
}

/**
 * Grow `mask` outward into pixels that are contiguous with it and darker
 * than `bgThreshold`, up to `maxDepth` rings.
 *
 * Strokes in a real scan do not end at the ink threshold: JPEG ringing and
 * anti-aliasing leave a halo a few pixels wide that is too light to be
 * labeled as ink, yet dark enough to read as a visible ghost once the
 * stroke itself is erased. A fixed dilation cannot remove it without also
 * eating into whatever else is nearby, whereas following the halo only
 * through non-background pixels stops naturally at clean paper.
 *
 * Returns the number of pixels added.
 */
export function expandMaskThroughNonBackground(
  mask, gray, width, height, bgThreshold, maxDepth, state, queue, region = null
) {
  let head = 0;
  let tail = 0;
  const rx0 = region ? region.x0 : 0;
  const ry0 = region ? region.y0 : 0;
  const rx1 = region ? region.x1 : width - 1;
  const ry1 = region ? region.y1 : height - 1;

  for (let y = ry0; y <= ry1; y++) {
    const row = y * width;
    for (let x = rx0; x <= rx1; x++) {
      const i = row + x;
      if (mask[i] !== 0) {
        state[i] = 1;
        queue[tail++] = i;
      } else {
        state[i] = 0;
      }
    }
  }
  if (tail === 0) return 0;

  let added = 0;
  for (let depth = 0; depth < maxDepth && head < tail; depth++) {
    const levelEnd = tail;
    while (head < levelEnd) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx / width) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = nRow + nx;
          if (state[nIdx] !== 0 || gray[nIdx] >= bgThreshold) continue;
          state[nIdx] = 1;
          mask[nIdx] = 255;
          queue[tail++] = nIdx;
          added++;
        }
      }
    }
  }
  return added;
}

/**
 * Binary dilation with a square structuring element, done separably with a
 * sliding window count: O(n) regardless of radius, versus O(n * r^2) for the
 * naive neighbourhood scan. At radius 3 that is ~49 reads per pixel down to
 * a couple of counter updates.
 */
export function dilateBinary(src, width, height, radius, tmp, dst, region = null) {
  const rx0 = region ? region.x0 : 0;
  const ry0 = region ? region.y0 : 0;
  const rx1 = region ? region.x1 : width - 1;
  const ry1 = region ? region.y1 : height - 1;

  for (let y = ry0; y <= ry1; y++) {
    const row = y * width;
    let count = 0;
    for (let x = rx0; x <= rx0 + radius && x <= rx1; x++) {
      if (src[row + x] !== 0) count++;
    }
    for (let x = rx0; x <= rx1; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      const add = x + radius + 1;
      const rem = x - radius;
      if (add <= rx1 && src[row + add] !== 0) count++;
      if (rem >= rx0 && src[row + rem] !== 0) count--;
    }
  }

  for (let x = rx0; x <= rx1; x++) {
    let count = 0;
    for (let y = ry0; y <= ry0 + radius && y <= ry1; y++) {
      if (tmp[y * width + x] !== 0) count++;
    }
    for (let y = ry0; y <= ry1; y++) {
      dst[y * width + x] = count > 0 ? 255 : 0;
      const add = y + radius + 1;
      const rem = y - radius;
      if (add <= ry1 && tmp[add * width + x] !== 0) count++;
      if (rem >= ry0 && tmp[rem * width + x] !== 0) count--;
    }
  }
}

/**
 * Erase masked pixels by propagating surrounding color inward, as a
 * multi-source BFS from the mask boundary: each masked pixel is resolved
 * exactly once, from the average of whichever neighbours are already known.
 *
 * This replaces a fixed-iteration relaxation over each region's bounding
 * box, which re-scanned the same pixels hundreds of times and still might
 * not converge in the middle of a thick stroke. Cost here is O(masked
 * pixels), so pages with little handwriting cost almost nothing.
 *
 * `rgba` is modified in place.
 */
export function inpaintMasked(rgba, mask, n, width, height, state, queue, background = null, region = null) {
  const UNKNOWN = 1;
  const QUEUED = 2;
  const rx0 = region ? region.x0 : 0;
  const ry0 = region ? region.y0 : 0;
  const rx1 = region ? region.x1 : width - 1;
  const ry1 = region ? region.y1 : height - 1;

  let unknownCount = 0;
  for (let y = ry0; y <= ry1; y++) {
    const row = y * width;
    for (let x = rx0; x <= rx1; x++) {
      const i = row + x;
      const u = mask[i] !== 0 ? UNKNOWN : 0;
      state[i] = u;
      unknownCount += u;
    }
  }
  if (unknownCount === 0) return 0;

  let head = 0;
  let tail = 0;

  // Seed the frontier: masked pixels that touch at least one known pixel.
  for (let y = ry0; y <= ry1; y++) {
    const row = y * width;
    for (let x = rx0; x <= rx1; x++) {
      const i = row + x;
      if (state[i] !== UNKNOWN) continue;
      let touchesKnown = false;
      for (let dy = -1; dy <= 1 && !touchesKnown; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (state[nRow + nx] === 0) {
            touchesKnown = true;
            break;
          }
        }
      }
      if (touchesKnown) {
        state[i] = QUEUED;
        queue[tail++] = i;
      }
    }
  }

  let resolved = 0;
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx / width) | 0;

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const nRow = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIdx = nRow + nx;
        if (state[nIdx] === 0) {
          const o = nIdx * 4;
          rSum += rgba[o];
          gSum += rgba[o + 1];
          bSum += rgba[o + 2];
          cnt++;
        }
      }
    }

    if (cnt > 0) {
      let r = (rSum / cnt) | 0;
      let g = (gSum / cnt) | 0;
      let b = (bSum / cnt) | 0;
      // Averaging can never produce a value lighter than its lightest
      // neighbour, so any faint grey left on the mask boundary gets carried
      // inward and the erased stroke reappears as a ghost. Where the fill
      // lands close to the paper colour, snap it to exactly that.
      if (
        background !== null &&
        Math.abs(r - background.r) <= background.snap &&
        Math.abs(g - background.g) <= background.snap &&
        Math.abs(b - background.b) <= background.snap
      ) {
        r = background.r;
        g = background.g;
        b = background.b;
      }
      const o = idx * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
    }
    state[idx] = 0;
    resolved++;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      const nRow = ny * width;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const nIdx = nRow + nx;
        if (state[nIdx] === UNKNOWN) {
          state[nIdx] = QUEUED;
          queue[tail++] = nIdx;
        }
      }
    }
  }

  return resolved;
}
