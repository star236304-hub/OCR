/**
 * Tesseract.js wrapper - browser counterpart to app/ocr.py.
 *
 * The worker is created once (language data + wasm core are a multi-MB
 * download) and reused across every page of a PDF.
 */

const DEFAULT_LANG = 'kor+eng';
const MIN_CONFIDENCE = 40;

export async function createOcrWorker(lang = DEFAULT_LANG, onProgress) {
  const { createWorker } = window.Tesseract;
  const worker = await createWorker(lang, 1, {
    logger: onProgress ? (m) => onProgress(m) : undefined,
  });
  return worker;
}

/**
 * OCR a canvas and return (text, words), dropping low-confidence words -
 * mirrors app/ocr.py's run_ocr. Handwriting has already been removed from
 * the canvas before this runs, so this confidence filter is mainly a
 * safety net against inpainting artifacts being misread as text.
 */
export async function runOcr(worker, canvas, minConfidence = MIN_CONFIDENCE) {
  const { data } = await worker.recognize(canvas, {}, { blocks: true });

  const lines = [];
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const lineWords = [];
        for (const word of line.words || []) {
          const text = (word.text || '').trim();
          if (!text || word.confidence < minConfidence) continue;
          lineWords.push(text);
          words.push({ text, confidence: word.confidence, bbox: word.bbox });
        }
        if (lineWords.length) lines.push(lineWords.join(' '));
      }
    }
  }

  return { text: lines.join('\n'), words };
}
