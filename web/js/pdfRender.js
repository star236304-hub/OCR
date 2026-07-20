/**
 * Render every page of a PDF (as an ArrayBuffer) to a canvas, using
 * pdf.js. Browser counterpart to app/pdf_utils.py's pdf_to_images.
 */

const PDFJS_VERSION = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* webpackIgnore: true */ `${PDFJS_BASE}/pdf.min.mjs`).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
      return mod;
    });
  }
  return pdfjsLibPromise;
}

/**
 * @param {ArrayBuffer} arrayBuffer
 * @param {{scale?: number}} options - 2.0 is roughly a 150-160dpi render for
 *   a normal PDF page; higher improves OCR accuracy but costs more time and
 *   memory, which matters more on phones/tablets than on desktop.
 * @returns {Promise<HTMLCanvasElement[]>}
 */
export async function renderPdfToCanvases(arrayBuffer, options = {}) {
  const { scale = 2.0 } = options;
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const canvases = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    canvases.push(canvas);
  }
  return canvases;
}
