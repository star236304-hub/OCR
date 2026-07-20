import { renderPdfToCanvases } from './pdfRender.js';
import { detectHandwritingMask, removeHandwriting, visualizeMask } from './handwriting.js';
import { createOcrWorker, runOcr } from './ocr.js';
import { canvasesToPdfBlob, downloadBlob } from './pdfExport.js';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const errorEl = document.getElementById('error');
const resultsEl = document.getElementById('results');
const actionsEl = document.getElementById('actions');
const downloadPdfBtn = document.getElementById('download-pdf');
const downloadTextBtn = document.getElementById('download-text');

const progressEl = document.getElementById('progress');
const progressHead = document.getElementById('progress-head');
const statusEl = document.getElementById('status');
const progressFill = document.getElementById('progress-fill');
const progressDetail = document.getElementById('progress-detail');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxClose = lightbox.querySelector('.lightbox-close');

const RENDER_SHARE = 0.08; // first 8% of the bar covers PDF rendering
const STATUS_KO = {
  'loading tesseract core': 'OCR 엔진 로딩',
  'initializing tesseract': 'OCR 초기화',
  'loading language traineddata': '언어 데이터 로딩',
  'initializing api': 'API 초기화',
  'recognizing text': '텍스트 인식',
};

let cleanedCanvases = [];
let allPageText = [];

function setError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}

function showProgress(show) {
  progressEl.hidden = !show;
}

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function setDetail(msg) {
  progressDetail.textContent = msg || '';
}

function setProgress(fraction) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  progressFill.style.width = pct.toFixed(1) + '%';
}

function canvasToImg(canvas, caption) {
  const figure = document.createElement('figure');
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/png');
  img.alt = caption;
  img.addEventListener('click', () => openLightbox(img.src, caption));
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

const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>';

function makeResultCard(pageNum, originalCanvas, maskCanvas, cleanedCanvas, text) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const heading = document.createElement('h3');
  heading.textContent = `페이지 ${pageNum}`;
  const badge = document.createElement('span');
  badge.className = 'page-badge';
  badge.textContent = 'OCR 완료';
  head.append(heading, badge);
  card.appendChild(head);

  const imagesRow = document.createElement('div');
  imagesRow.className = 'page-images';
  imagesRow.appendChild(canvasToImg(originalCanvas, '원본'));
  imagesRow.appendChild(canvasToImg(maskCanvas, '감지된 손글씨'));
  imagesRow.appendChild(canvasToImg(cleanedCanvas, '손글씨 제거 후'));
  card.appendChild(imagesRow);

  const textHead = document.createElement('div');
  textHead.className = 'text-head';
  const label = document.createElement('strong');
  label.textContent = '추출된 텍스트';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-btn';
  copyBtn.innerHTML = COPY_ICON + '<span>복사</span>';
  textHead.append(label, copyBtn);
  card.appendChild(textHead);

  const pre = document.createElement('pre');
  pre.className = 'ocr-text';
  if (text) {
    pre.textContent = text;
  } else {
    pre.textContent = '(인식된 텍스트가 없습니다)';
    pre.classList.add('empty');
    copyBtn.disabled = true;
    copyBtn.style.display = 'none';
  }

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.classList.add('copied');
      copyBtn.querySelector('span').textContent = '복사됨';
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.querySelector('span').textContent = '복사';
      }, 1500);
    } catch {
      /* clipboard may be unavailable (e.g. non-secure context) */
    }
  });

  card.appendChild(pre);
  return card;
}

function openLightbox(src, alt) {
  lightboxImg.src = src;
  lightboxImg.alt = alt || '';
  lightbox.hidden = false;
}
function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = '';
}
lightboxClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
});

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

  showProgress(true);
  progressHead.classList.remove('done');
  setProgress(0);
  setStatus('PDF를 여는 중…');
  setDetail(file.name);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const pageCanvases = await renderPdfToCanvases(arrayBuffer);

    if (pageCanvases.length === 0) {
      setError('PDF에서 페이지를 찾을 수 없습니다.');
      showProgress(false);
      return;
    }
    setProgress(RENDER_SHARE);

    const totalPages = pageCanvases.length;
    let pageBase = RENDER_SHARE;
    let pageSpan = (1 - RENDER_SHARE) / totalPages;

    setStatus('OCR 엔진 준비 중…');
    setDetail('처음 실행 시 엔진(수 MB)을 내려받습니다.');
    const worker = await createOcrWorker('kor+eng', (m) => {
      if (!m || !m.status) return;
      const ko = STATUS_KO[m.status] || m.status;
      const pctText = typeof m.progress === 'number' ? ` ${Math.round(m.progress * 100)}%` : '';
      setDetail(ko + pctText);
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        setProgress(pageBase + pageSpan * m.progress);
      }
    });

    for (let i = 0; i < totalPages; i++) {
      const pageNum = i + 1;
      pageBase = RENDER_SHARE + (1 - RENDER_SHARE) * (i / totalPages);
      setProgress(pageBase);
      setStatus(`페이지 ${pageNum} / ${totalPages} 처리 중…`);
      setDetail('손글씨 감지 중…');

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

      const { text } = await runOcr(worker, cleanedCanvas);
      setProgress(pageBase + pageSpan);

      cleanedCanvases.push(cleanedCanvas);
      allPageText.push(text);
      resultsEl.appendChild(makeResultCard(pageNum, canvas, maskCanvas, cleanedCanvas, text));
    }

    await worker.terminate();
    setProgress(1);
    progressHead.classList.add('done');
    actionsEl.hidden = false;
    setStatus(`완료: 총 ${totalPages}페이지 처리됨`);
    setDetail('아래에서 결과를 확인하고 내려받으세요.');
  } catch (err) {
    console.error(err);
    setError('처리 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)));
    showProgress(false);
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
