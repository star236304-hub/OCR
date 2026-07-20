/**
 * Assemble cleaned page canvases into a downloadable multi-page PDF,
 * using jsPDF. Browser counterpart to app/pdf_utils.py's images_to_pdf.
 */
export function canvasesToPdfBlob(canvases) {
  const { jsPDF } = window.jspdf;
  let doc = null;

  for (const canvas of canvases) {
    const orientation = canvas.width >= canvas.height ? 'l' : 'p';
    const size = [canvas.width, canvas.height];
    if (!doc) {
      doc = new jsPDF({ orientation, unit: 'px', format: size, compress: true });
    } else {
      doc.addPage(size, orientation);
    }
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    doc.addImage(dataUrl, 'JPEG', 0, 0, canvas.width, canvas.height);
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
  URL.revokeObjectURL(url);
}
