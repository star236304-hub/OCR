/**
 * A small fixed-size pool of processing workers.
 *
 * Each lane in the pipeline owns one worker for its whole run, so there is
 * no scheduling to do: `pool.lane(i)` hands back a stable handle whose
 * `process()` resolves with the cleaned page.
 *
 * If module workers are unavailable (Safari older than 16.4), the pool
 * transparently degrades to a single main-thread lane. That is slower and
 * blocks the UI between pages, but it works rather than failing outright.
 */

import { createProcessor, visualizeMask } from './handwriting.js';

function detectConcurrency() {
  const cores = navigator.hardwareConcurrency || 2;
  // Phones and tablets have far less headroom before the OS reclaims the
  // tab; each lane holds a page canvas plus ~35MB of worker scratch.
  const isMobile =
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
  const cap = isMobile ? 2 : 4;
  return Math.max(1, Math.min(cap, cores - 1 || 1));
}

function createWorkerLane(url) {
  const worker = new Worker(url, { type: 'module' });
  const pending = new Map();
  let nextId = 1;

  worker.onmessage = (e) => {
    const resolve = pending.get(e.data.id);
    if (resolve) {
      pending.delete(e.data.id);
      resolve(e.data);
    }
  };

  return {
    process(buffer, width, height, options, wantPreview) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ id, buffer, width, height, options, wantPreview }, [buffer]);
      });
    },
    terminate() {
      worker.terminate();
      pending.clear();
    },
  };
}

function createInlineLane() {
  const processor = createProcessor();
  return {
    async process(buffer, width, height, options, wantPreview) {
      const rgba = new Uint8ClampedArray(buffer);
      const original = wantPreview ? new Uint8ClampedArray(rgba) : null;
      const result = processor.process(rgba, width, height, options || {}, wantPreview);
      const out = {
        buffer: rgba.buffer,
        width,
        height,
        components: result.components,
        flagged: result.flagged,
        maskedPixels: result.maskedPixels,
      };
      if (wantPreview && original) {
        const overlay = result.mask ? visualizeMask(original, result.mask, width, height) : original;
        out.originalBuffer = original.buffer;
        out.overlayBuffer = overlay.buffer;
      }
      // Yield so the progress UI can paint between pages.
      await new Promise((r) => setTimeout(r, 0));
      return out;
    },
    terminate() {},
  };
}

export function createPool() {
  const workerUrl = new URL('./worker.js', import.meta.url);
  let lanes;
  let usingWorkers = true;

  try {
    lanes = Array.from({ length: detectConcurrency() }, () => createWorkerLane(workerUrl));
  } catch (err) {
    console.warn('Module workers unavailable, falling back to main thread:', err);
    lanes = [createInlineLane()];
    usingWorkers = false;
  }

  return {
    size: lanes.length,
    usingWorkers,
    lane: (i) => lanes[i % lanes.length],
    terminate() {
      lanes.forEach((l) => l.terminate());
    },
  };
}
