/**
 * Removal of PDF annotation objects - the way handwriting added on an iPad
 * (Apple Markup, GoodNotes, Notability, PDF Expert, Adobe) is normally
 * stored.
 *
 * When a PDF carries its handwriting as annotations, deleting those objects
 * is not an approximation of removing it: it *is* removing it. Nothing is
 * rasterised, so the page keeps its real text - selectable, searchable and
 * sharp at any zoom - and the file usually gets smaller rather than
 * ballooning into a stack of JPEGs. The pixel pipeline is a fallback for
 * scans, where there is no structure to work with.
 *
 * Some apps offer to "flatten" annotations when exporting, which merges the
 * strokes into the page content stream. Those files look identical to a scan
 * from the outside and have to go through the pixel pipeline.
 */

const PDFLIB_VERSION = '1.17.1';
const PDFLIB_URL = `https://cdn.jsdelivr.net/npm/pdf-lib@${PDFLIB_VERSION}/dist/pdf-lib.esm.min.js`;

let pdfLibPromise = null;
/**
 * pdf-lib is loaded from the CDN like the other libraries. Callers may pass
 * their own module instead, which is how these functions are exercised
 * outside a browser.
 */
function loadPdfLib(injected) {
  if (injected) return Promise.resolve(injected);
  if (!pdfLibPromise) pdfLibPromise = import(/* webpackIgnore: true */ PDFLIB_URL);
  return pdfLibPromise;
}

/**
 * Markup annotation subtypes that represent something a person drew or wrote
 * on top of the page.
 *
 * `Link` and `Widget` are deliberately absent: those are the document's own
 * navigation and form fields, not annotations over it.
 */
export const HANDWRITING_SUBTYPES = new Set([
  'Ink', // pen and pencil strokes - the main one
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'FreeText', // typed sticky text placed on the page
  'Text', // sticky notes
  'Square',
  'Circle',
  'Line',
  'Polygon',
  'PolyLine',
  'Caret',
  'Stamp',
  'FileAttachment',
  'Sound',
]);

function subtypeOf(dict, PDFName) {
  const raw = dict?.get?.(PDFName.of('Subtype'));
  if (!raw) return null;
  return String(raw).replace(/^\//, '');
}

/**
 * Count removable annotations per subtype without modifying anything.
 * @returns {{total: number, bySubtype: Record<string, number>, pages: number}}
 */
export async function inspectAnnotations(arrayBuffer, { pdfLib } = {}) {
  const { PDFDocument, PDFName } = await loadPdfLib(pdfLib);
  const doc = await PDFDocument.load(arrayBuffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  const bySubtype = {};
  let total = 0;
  let pages = 0;

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    let pageHits = 0;
    for (let i = 0; i < annots.size(); i++) {
      const dict = page.node.context.lookup(annots.get(i));
      const subtype = subtypeOf(dict, PDFName);
      if (!subtype || !HANDWRITING_SUBTYPES.has(subtype)) continue;
      bySubtype[subtype] = (bySubtype[subtype] || 0) + 1;
      total++;
      pageHits++;
    }
    if (pageHits > 0) pages++;
  }

  return { total, bySubtype, pages };
}

/**
 * Delete handwriting annotations and return the rebuilt PDF.
 *
 * Popups are dropped alongside their parent markup annotation; on their own
 * they are just the comment bubble belonging to a note we removed.
 *
 * @returns {{bytes: Uint8Array, removed: number, pages: number}}
 */
export async function stripAnnotations(arrayBuffer, { pdfLib } = {}) {
  const { PDFDocument, PDFName } = await loadPdfLib(pdfLib);
  const doc = await PDFDocument.load(arrayBuffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  let removed = 0;
  let pages = 0;

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;

    const context = page.node.context;
    const keep = [];
    const removedRefs = new Set();

    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const dict = context.lookup(ref);
      const subtype = subtypeOf(dict, PDFName);
      if (subtype && HANDWRITING_SUBTYPES.has(subtype)) {
        removed++;
        removedRefs.add(String(ref));
        const popup = dict?.get?.(PDFName.of('Popup'));
        if (popup) removedRefs.add(String(popup));
      } else {
        keep.push({ ref, dict, subtype });
      }
    }

    if (removedRefs.size === 0) continue;
    pages++;

    const survivors = keep
      .filter((entry) => {
        if (removedRefs.has(String(entry.ref))) return false;
        // A popup whose parent is gone has nothing left to point at.
        if (entry.subtype === 'Popup') {
          const parent = entry.dict?.get?.(PDFName.of('Parent'));
          if (parent && removedRefs.has(String(parent))) return false;
        }
        return true;
      })
      .map((entry) => entry.ref);

    page.node.set(PDFName.of('Annots'), context.obj(survivors));
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, removed, pages };
}
