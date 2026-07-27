/**
 * Processing worker: erases handwriting from one page's pixels.
 *
 * Page buffers are transferred (not copied) in both directions, so moving
 * a ~9MB page between threads costs nothing. The processor instance is
 * kept alive across messages so its scratch buffers are allocated once per
 * worker rather than once per page.
 */

import { createProcessor, visualizeMask } from './handwriting.js';

const processor = createProcessor();

self.onmessage = (e) => {
  const { id, buffer, width, height, options, wantPreview } = e.data;
  const rgba = new Uint8ClampedArray(buffer);

  // The preview needs the untouched page, but processing works in place.
  const original = wantPreview ? new Uint8ClampedArray(rgba) : null;

  const result = processor.process(rgba, width, height, options || {}, wantPreview);

  const message = {
    id,
    buffer: rgba.buffer,
    width,
    height,
    components: result.components,
    flagged: result.flagged,
    maskedPixels: result.maskedPixels,
  };
  const transfer = [rgba.buffer];

  if (wantPreview && original) {
    const overlay = result.mask
      ? visualizeMask(original, result.mask, width, height)
      : original;
    message.originalBuffer = original.buffer;
    message.overlayBuffer = overlay.buffer;
    transfer.push(original.buffer);
    if (overlay.buffer !== original.buffer) transfer.push(overlay.buffer);
  }

  self.postMessage(message, transfer);
};
