/**
 * PDF loading and page rendering via pdf.js.
 *
 * Pages are rendered one at a time into a caller-supplied canvas rather
 * than all up front: a few hundred rendered pages held simultaneously is
 * gigabytes of canvas memory and a guaranteed crash on iOS Safari.
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

export async function loadPdf(arrayBuffer) {
  const pdfjsLib = await loadPdfjs();
  return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
}

/**
 * Render one page into `canvas` at approximately `dpi`, capped at
 * `maxPixels` so an unusually large page (a poster, a plan drawing) cannot
 * blow up memory.
 *
 * Resolution is the single biggest lever on total runtime - every stage
 * downstream costs time linear in pixel count - which is why it is exposed
 * as a user-facing setting rather than hard-coded. Targeting DPI rather
 * than a fixed pixel budget keeps output sharpness consistent across mixed
 * page sizes in one document.
 */
export async function renderPage(pdf, pageNum, { dpi = 150, maxPixels = 6e6 } = {}, canvas) {
  const page = await pdf.getPage(pageNum);
  try {
    const base = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    const pixels = base.width * scale * (base.height * scale);
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
    const viewport = page.getViewport({ scale: Math.max(scale, 0.1) });

    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Pages with transparent backgrounds would otherwise read back as
    // black, which the ink threshold would treat as a fully inked page.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
    return { width: canvas.width, height: canvas.height };
  } finally {
    page.cleanup();
  }
}
