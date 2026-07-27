/**
 * Assemble cleaned pages into a downloadable PDF.
 *
 * Pages arrive as encoded JPEG bytes rather than canvases: a few hundred
 * live canvases will not fit in memory on a phone, whereas the same pages
 * as JPEGs are a couple of hundred kilobytes each.
 */

// Dense text is high-frequency detail and compresses poorly: a 150dpi A4
// text page lands around 0.6MB at quality 0.72, versus 0.7MB at 0.82 (~17%
// larger) for no visible gain on document scans. Since every page is held
// in memory until the PDF is assembled, that ratio is worth having.
export function encodeCanvasToJpeg(canvas, quality = 0.72) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('페이지 이미지를 인코딩하지 못했습니다.'));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      'image/jpeg',
      quality
    );
  });
}

/**
 * @param {{bytes: Uint8Array, width: number, height: number}[]} pages
 */
export function pagesToPdfBlob(pages) {
  const { jsPDF } = window.jspdf;
  let doc = null;

  for (const page of pages) {
    const orientation = page.width >= page.height ? 'l' : 'p';
    const format = [page.width, page.height];
    if (!doc) {
      doc = new jsPDF({ orientation, unit: 'px', format, compress: false });
    } else {
      doc.addPage(format, orientation);
    }
    // The bytes are already JPEG-compressed; jsPDF embeds them as-is.
    doc.addImage(page.bytes, 'JPEG', 0, 0, page.width, page.height, undefined, 'NONE');
  }

  return doc.output('blob');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
