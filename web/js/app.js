import { renderPdfToCanvases } from './pdfRender.js';
import { detectHandwritingMask, removeHandwriting, visualizeMask } from './handwriting.js';
import { createOcrWorker, runOcr } from './ocr.js';
import { canvasesToPdfBlob, downloadBlob } from './pdfExport.js';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const resultsEl = document.getElementById('results');
const actionsEl = document.getElementById('actions');
const downloadPdfBtn = document.getElementById('download-pdf');
const downloadTextBtn = document.getElementById('download-text');

let cleanedCanvases = [];
let allPageText = [];

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function setError(msg) {
  errorEl.textContent = msg || '';
}

function canvasToImg(canvas, caption) {
  const figure = document.createElement('figure');
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/png');
  img.alt = caption;
  const figcaption = document.createElement('figcaption');
  figcaption.textContent = caption;
  figure.appendChild(img);
  figure.appendChild(figcaption);
  return figure;
}

function cloneCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
}

async function processFile(file) {
  setError('');
  resultsEl.innerHTML = '';
  actionsEl.hidden = true;
  cleanedCanvases = [];
  allPageText = [];

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setError('PDF 파일만 업로드할 수 있습니다.');
    return;
  }

  try {
    setStatus('PDF를 이미지로 변환하는 중...');
    const arrayBuffer = await file.arrayBuffer();
    const pageCanvases = await renderPdfToCanvases(arrayBuffer);

    if (pageCanvases.length === 0) {
      setError('PDF에서 페이지를 찾을 수 없습니다.');
      setStatus('');
      return;
    }

    setStatus('OCR 엔진을 준비하는 중 (처음 실행 시 다소 걸릴 수 있어요)...');
    const worker = await createOcrWorker('kor+eng', (m) => {
      if (m.status && typeof m.progress === 'number') {
        setStatus(`${m.status} (${Math.round(m.progress * 100)}%)`);
      }
    });

    for (let i = 0; i < pageCanvases.length; i++) {
      const pageNum = i + 1;
      setStatus(`페이지 ${pageNum}/${pageCanvases.length}: 손글씨 감지 중...`);

      const canvas = pageCanvases[i];
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const mask = detectHandwritingMask(imageData.data, canvas.width, canvas.height);
      const cleanedData = removeHandwriting(imageData.data, mask, canvas.width, canvas.height);
      const maskOverlayData = visualizeMask(imageData.data, mask, canvas.width, canvas.height);

      const cleanedCanvas = cloneCanvas(canvas);
      cleanedCanvas.getContext('2d').putImageData(new ImageData(cleanedData, canvas.width, canvas.height), 0, 0);

      const maskCanvas = cloneCanvas(canvas);
      maskCanvas.getContext('2d').putImageData(new ImageData(maskOverlayData, canvas.width, canvas.height), 0, 0);

      setStatus(`페이지 ${pageNum}/${pageCanvases.length}: OCR 인식 중...`);
      const { text } = await runOcr(worker, cleanedCanvas);

      cleanedCanvases.push(cleanedCanvas);
      allPageText.push(text);

      const card = document.createElement('div');
      card.className = 'card';
      const heading = document.createElement('h3');
      heading.textContent = `페이지 ${pageNum}`;
      card.appendChild(heading);

      const imagesRow = document.createElement('div');
      imagesRow.className = 'page-images';
      imagesRow.appendChild(canvasToImg(canvas, '원본'));
      imagesRow.appendChild(canvasToImg(maskCanvas, '감지된 손글씨 (빨간색)'));
      imagesRow.appendChild(canvasToImg(cleanedCanvas, '손글씨 제거 후'));
      card.appendChild(imagesRow);

      const label = document.createElement('strong');
      label.textContent = '추출된 텍스트';
      card.appendChild(label);

      const pre = document.createElement('pre');
      pre.className = 'ocr-text';
      pre.textContent = text || '(인식된 텍스트가 없습니다)';
      card.appendChild(pre);

      resultsEl.appendChild(card);
    }

    await worker.terminate();
    actionsEl.hidden = false;
    setStatus(`완료: 총 ${pageCanvases.length}페이지 처리됨`);
  } catch (err) {
    console.error(err);
    setError('처리 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)));
    setStatus('');
  }
}

fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) processFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) processFile(file);
});

downloadPdfBtn.addEventListener('click', () => {
  if (!cleanedCanvases.length) return;
  const blob = canvasesToPdfBlob(cleanedCanvases);
  downloadBlob(blob, 'cleaned.pdf');
});

downloadTextBtn.addEventListener('click', () => {
  if (!allPageText.length) return;
  const blob = new Blob([allPageText.join('\n\n')], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, 'extracted_text.txt');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
