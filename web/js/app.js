import { loadPdf, renderPage } from './pdfRender.js';
import { createPool } from './pool.js';
import { encodeCanvasToJpeg, pagesToPdfBlob, downloadBlob } from './pdfExport.js';
import { inspectAnnotations, stripAnnotations } from './annotations.js';

const fileInput = document.getElementById('file-input');
const dropzone = document.getElementById('dropzone');
const modeSelect = document.getElementById('mode');
const qualitySelect = document.getElementById('quality');
const errorEl = document.getElementById('error');

const progressEl = document.getElementById('progress');
const progressHead = document.getElementById('progress-head');
const statusEl = document.getElementById('status');
const progressFill = document.getElementById('progress-fill');
const progressDetail = document.getElementById('progress-detail');
const cancelBtn = document.getElementById('cancel');

const actionsEl = document.getElementById('actions');
const downloadPdfBtn = document.getElementById('download-pdf');
const summaryEl = document.getElementById('summary');
const previewsEl = document.getElementById('previews');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxClose = lightbox.querySelector('.lightbox-close');

const QUALITY_DPI = { fast: 100, balanced: 150, high: 200 };
const QUALITY_JPEG = { fast: 0.65, balanced: 0.72, high: 0.82 };
// Past roughly this many pages the accumulated JPEGs start to rival what a
// phone will hand a single tab, so we suggest the lighter preset instead of
// letting the run die halfway through.
const LARGE_DOC_PAGES = 200;
const PREVIEW_PAGES = 3;
const PREVIEW_MAX_DIM = 560;

let outputPages = [];
let annotationResult = null;
let running = false;
let cancelled = false;

function setError(msg) {
  errorEl.textContent = msg || '';
  errorEl.hidden = !msg;
}
function setStatus(msg) {
  statusEl.textContent = msg || '';
}
function setDetail(msg) {
  progressDetail.textContent = msg || '';
}
function setProgress(fraction) {
  progressFill.style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + '%';
}

const SUBTYPE_KO = {
  Ink: '펜 획',
  Highlight: '형광펜',
  Underline: '밑줄',
  StrikeOut: '취소선',
  Squiggly: '물결 밑줄',
  FreeText: '텍스트 상자',
  Text: '메모',
  Square: '사각형',
  Circle: '원',
  Line: '직선',
  Polygon: '다각형',
  PolyLine: '연결선',
  Caret: '삽입 표시',
  Stamp: '스탬프',
};

function describeSubtypes(bySubtype) {
  return Object.entries(bySubtype)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${SUBTYPE_KO[name] || name} ${count}개`)
    .join(', ');
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
}

/** Downscale into a small canvas so preview data URLs stay lightweight. */
function toPreviewDataUrl(rgba, width, height) {
  const scale = Math.min(1, PREVIEW_MAX_DIM / Math.max(width, height));
  const full = document.createElement('canvas');
  full.width = width;
  full.height = height;
  full.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);

  if (scale >= 1) return full.toDataURL('image/jpeg', 0.85);

  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(width * scale));
  small.height = Math.max(1, Math.round(height * scale));
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, small.width, small.height);
  return small.toDataURL('image/jpeg', 0.85);
}

function addPreviewCard(pageNum, originalUrl, overlayUrl, cleanedUrl, flagged) {
  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-head';
  const heading = document.createElement('h3');
  heading.textContent = `페이지 ${pageNum}`;
  const badge = document.createElement('span');
  badge.className = 'page-badge';
  badge.textContent = flagged > 0 ? `필기 ${flagged}곳 제거` : '필기 없음';
  if (flagged === 0) badge.classList.add('neutral');
  head.append(heading, badge);
  card.appendChild(head);

  const row = document.createElement('div');
  row.className = 'page-images';
  [
    [originalUrl, '원본'],
    [overlayUrl, '감지된 필기'],
    [cleanedUrl, '제거 후'],
  ].forEach(([src, caption]) => {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.src = src;
    img.alt = caption;
    img.loading = 'lazy';
    img.addEventListener('click', () => openLightbox(src, caption));
    const cap = document.createElement('figcaption');
    cap.textContent = caption;
    figure.append(img, cap);
    row.appendChild(figure);
  });
  card.appendChild(row);
  previewsEl.appendChild(card);
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

/**
 * Run `task` over page indices 0..total-1 across `laneCount` concurrent
 * lanes. Each lane pulls the next page when it finishes one, so a slow page
 * never stalls the others.
 */
async function runLanes(total, laneCount, task) {
  let next = 0;
  const lanes = [];
  for (let lane = 0; lane < laneCount; lane++) {
    lanes.push(
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= total || cancelled) return;
          await task(index, lane);
        }
      })()
    );
  }
  await Promise.all(lanes);
}

async function processFile(file) {
  if (running) return;

  setError('');
  previewsEl.innerHTML = '';
  summaryEl.textContent = '';
  actionsEl.hidden = true;
  outputPages = [];
  annotationResult = null;
  cancelled = false;
  running = true;

  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    setError('PDF 파일만 업로드할 수 있습니다.');
    running = false;
    return;
  }

  progressEl.hidden = false;
  progressHead.classList.remove('done');
  cancelBtn.hidden = false;
  setProgress(0);
  setStatus('PDF를 여는 중…');
  setDetail(file.name);

  const pool = createPool();
  let pdf = null;
  const startedAt = performance.now();

  try {
    const arrayBuffer = await file.arrayBuffer();

    // Handwriting added in a PDF app (iPad markup and friends) is stored as
    // annotation objects. Deleting those is exact and keeps the page's real
    // text, so it always beats rasterising - take that path when it applies.
    if (modeSelect.value !== 'raster') {
      setStatus('필기 주석을 확인하는 중…');
      const found = await inspectAnnotations(arrayBuffer.slice(0));
      if (found.total > 0) {
        setStatus('필기 주석을 제거하는 중…');
        setProgress(0.4);
        const stripped = await stripAnnotations(arrayBuffer.slice(0));
        setProgress(1);
        annotationResult = stripped;
        progressHead.classList.add('done');
        cancelBtn.hidden = true;
        setStatus(`완료 · 필기 주석 ${stripped.removed}개 제거`);
        setDetail(`${stripped.pages}개 페이지 · 원본 텍스트와 화질을 그대로 유지했습니다.`);
        summaryEl.textContent =
          `이 PDF는 앱에서 필기한 파일이라 주석을 직접 지웠습니다 (${describeSubtypes(found.bySubtype)}). ` +
          '페이지를 이미지로 바꾸지 않았기 때문에 글자는 그대로 선택·검색할 수 있습니다.';
        actionsEl.hidden = false;
        return;
      }
      if (modeSelect.value === 'annotations') {
        setError('이 PDF에는 지울 수 있는 필기 주석이 없습니다. 스캔한 문서라면 "이미지 처리"를 선택하세요.');
        progressEl.hidden = true;
        return;
      }
    }

    pdf = await loadPdf(arrayBuffer);
    const total = pdf.numPages;
    if (total === 0) {
      setError('PDF에서 페이지를 찾을 수 없습니다.');
      progressEl.hidden = true;
      return;
    }

    const dpi = QUALITY_DPI[qualitySelect.value] || QUALITY_DPI.balanced;
    const jpegQuality = QUALITY_JPEG[qualitySelect.value] || QUALITY_JPEG.balanced;
    if (total > LARGE_DOC_PAGES && qualitySelect.value !== 'fast') {
      setError(
        `${total}페이지 문서입니다. 메모리가 부족해 중단될 수 있으니, 문제가 생기면 해상도를 "빠르게"로 낮춰 다시 시도해 보세요.`
      );
    }
    const laneCount = pool.size;
    const canvases = Array.from({ length: laneCount }, () => document.createElement('canvas'));
    const previews = [];

    outputPages = new Array(total);
    let done = 0;
    let totalFlagged = 0;

    setStatus(`0 / ${total} 페이지`);
    setDetail(
      `${pool.usingWorkers ? `${laneCount}개 스레드로 병렬 처리` : '단일 스레드로 처리'} · ${qualitySelect.selectedOptions[0].text}`
    );

    await runLanes(total, laneCount, async (index, lane) => {
      const pageNum = index + 1;
      const canvas = canvases[lane];
      const { width, height } = await renderPage(pdf, pageNum, { dpi }, canvas);
      if (cancelled) return;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = ctx.getImageData(0, 0, width, height);
      const wantPreview = index < PREVIEW_PAGES;

      const result = await pool
        .lane(lane)
        .process(imageData.data.buffer, width, height, {}, wantPreview);
      if (cancelled) return;

      const cleaned = new Uint8ClampedArray(result.buffer);
      ctx.putImageData(new ImageData(cleaned, width, height), 0, 0);
      outputPages[index] = { bytes: await encodeCanvasToJpeg(canvas, jpegQuality), width, height };
      totalFlagged += result.flagged || 0;

      if (wantPreview && result.originalBuffer && result.overlayBuffer) {
        previews.push({
          pageNum,
          flagged: result.flagged || 0,
          originalUrl: toPreviewDataUrl(new Uint8ClampedArray(result.originalBuffer), width, height),
          overlayUrl: toPreviewDataUrl(new Uint8ClampedArray(result.overlayBuffer), width, height),
          cleanedUrl: toPreviewDataUrl(cleaned, width, height),
        });
      }

      done++;
      const elapsed = performance.now() - startedAt;
      const remaining = (elapsed / done) * (total - done);
      setProgress(done / total);
      setStatus(`${done} / ${total} 페이지`);
      setDetail(
        done < total
          ? `남은 시간 약 ${formatDuration(remaining)} · 페이지당 ${Math.round(elapsed / done)}ms`
          : 'PDF를 만드는 중…'
      );
    });

    if (cancelled) {
      setStatus('취소되었습니다.');
      setDetail(`${done} / ${total} 페이지까지 처리됨`);
      cancelBtn.hidden = true;
      return;
    }

    previews
      .sort((a, b) => a.pageNum - b.pageNum)
      .forEach((p) => addPreviewCard(p.pageNum, p.originalUrl, p.overlayUrl, p.cleanedUrl, p.flagged));

    const elapsed = performance.now() - startedAt;
    setProgress(1);
    progressHead.classList.add('done');
    cancelBtn.hidden = true;
    setStatus(`완료 · ${total}페이지`);
    setDetail(`${formatDuration(elapsed)} 소요 · 페이지당 ${Math.round(elapsed / total)}ms`);
    summaryEl.textContent =
      totalFlagged > 0
        ? `총 ${total}페이지에서 필기 ${totalFlagged}곳을 제거했습니다.` +
          (total > PREVIEW_PAGES ? ` 아래는 처음 ${PREVIEW_PAGES}페이지 미리보기입니다.` : '')
        : `총 ${total}페이지를 확인했지만 제거할 필기를 찾지 못했습니다.`;
    actionsEl.hidden = false;
  } catch (err) {
    console.error(err);
    setError('처리 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)));
    progressEl.hidden = true;
  } finally {
    pool.terminate();
    if (pdf) pdf.destroy().catch(() => {});
    running = false;
    fileInput.value = '';
  }
}

cancelBtn.addEventListener('click', () => {
  cancelled = true;
  setStatus('취소하는 중…');
});

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
  if (annotationResult) {
    downloadBlob(new Blob([annotationResult.bytes], { type: 'application/pdf' }), 'cleaned.pdf');
    return;
  }
  const pages = outputPages.filter(Boolean);
  if (!pages.length) return;
  downloadPdfBtn.disabled = true;
  // Assembling a few hundred pages blocks briefly; let the label repaint.
  setTimeout(() => {
    try {
      downloadBlob(pagesToPdfBlob(pages), 'cleaned.pdf');
    } catch (err) {
      console.error(err);
      setError('PDF를 만드는 중 오류가 발생했습니다: ' + (err && err.message ? err.message : String(err)));
    } finally {
      downloadPdfBtn.disabled = false;
    }
  }, 30);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
