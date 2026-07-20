# PDF OCR & 필기 제거

스캔한 PDF를 업로드하면 손글씨(펜 표시, 메모, 서명 등)를 지우고 인쇄된 텍스트만 OCR로 추출해주는 프로젝트입니다. 두 가지 독립된 구현이 있습니다.

| | `app/` (서버) | `web/` (정적 PWA) |
|---|---|---|
| 용도 | 직접 호스팅해서 쓰는 웹 서버 | GitHub Pages 등 정적 호스팅, **아이폰/아이패드에서 홈 화면에 추가**해서 앱처럼 사용 |
| 처리 위치 | 서버 (Python + Tesseract) | 브라우저 안 (서버 없음, 업로드한 파일이 외부로 전송되지 않음) |
| OCR 엔진 | Tesseract (pytesseract) | Tesseract.js (WASM) |
| 손글씨 감지 | OpenCV 기반 휴리스틱 | 순수 JS 휴리스틱 (동일한 아이디어, 별도 튜닝) |

둘 다 "색이 있는 펜 자국"과 "인쇄 글자와 다르게 성글고 불규칙한 모양의 검정 잉크"를 감지해 지우고, 남은 인쇄 텍스트만 OCR로 인식한다는 핵심 아이디어는 같습니다. 어느 쪽을 쓸지는 배포 방식에 따라 고르면 됩니다.

---

## `web/` - 정적 PWA (GitHub Pages, 아이폰/아이패드용)

서버가 전혀 없습니다. PDF 렌더링(pdf.js), 손글씨 감지/제거(직접 구현한 순수 JS), OCR(Tesseract.js)이 전부 브라우저 안에서 실행됩니다. 라이브러리는 CDN(jsdelivr)에서 그때그때 불러오므로 빌드 과정이 없고, `web/` 폴더를 그대로 정적 호스팅에 올리면 끝입니다.

### GitHub Pages로 배포하기

1. 이 브랜치를 `main`에 머지합니다 (또는 `.github/workflows/deploy-pages.yml`의 `branches:` 값을 원하는 브랜치로 수정).
2. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 한 번 설정합니다 (최초 1회, 수동 설정 필요 - GitHub API/git push만으로는 이 저장소 설정을 바꿀 수 없습니다).
3. `main`에 push하면 `.github/workflows/deploy-pages.yml`이 `web/` 폴더를 자동으로 GitHub Pages에 배포합니다. Actions 탭에서 진행 상황과 배포된 URL을 확인할 수 있습니다.

### 아이폰/아이패드에서 앱처럼 쓰기

1. Safari로 배포된 GitHub Pages 주소에 접속합니다.
2. 공유 버튼 → **홈 화면에 추가**를 누르면 아이콘이 생기고, 주소창 없이 앱처럼 실행됩니다 (PWA manifest + apple-mobile-web-app 메타 태그로 설정되어 있습니다).
3. PDF는 파일 앱이나 사진 앨범에서 선택해 업로드할 수 있습니다.

### 로컬에서 미리 보기

빌드 도구 없이 아무 정적 서버로 `web/`를 서빙하면 됩니다:

```bash
cd web && python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 접속.

### 한계

- 첫 실행 시 OCR 엔진(수 MB, 한국어+영어 언어 데이터 포함)을 CDN에서 내려받기 때문에 다소 걸릴 수 있습니다. 이후에는 서비스워커 캐시로 더 빨라집니다.
- 모든 처리가 기기 안에서(WASM으로) 이뤄지므로 서버 버전보다 느릴 수 있습니다. 특히 페이지 수가 많은 PDF는 시간이 걸립니다.
- 손글씨 감지는 규칙 기반 휴리스틱이며 완벽하지 않습니다. 임계값은 `web/js/handwriting.js` 상단 `DEFAULTS`에서 조정할 수 있습니다.

### 테스트

핵심 로직(`web/js/imageProc.js`, `web/js/handwriting.js`)은 브라우저 없이 Node에서 테스트할 수 있습니다:

```bash
npm install
npm test
```

---

## `app/` - 서버 버전 (Python/FastAPI)

스캔한 PDF를 업로드하면 손글씨 표시를 지우고, 인쇄된 텍스트만 추출합니다.

### 동작 방식

1. **PDF → 이미지**: PyMuPDF로 각 페이지를 고해상도 이미지로 렌더링합니다.
2. **손글씨 감지**: 규칙 기반 휴리스틱 두 가지를 결합해 손글씨 잉크 마스크를 만듭니다.
   - 색이 있는 펜 자국 (인쇄된 검정 텍스트와 다른 색상의 잉크, HSV 채도 기준)
   - 획 굵기가 불규칙한 검정 잉크 (인쇄 폰트는 획 굵기가 일정하지만, 손글씨는 필압/각도 변화로 굵기 편차와 낮은 형태 견고성(solidity)을 보임)
3. **제거**: 감지된 마스크 영역을 인페인팅(`cv2.inpaint`)으로 지워, 인쇄된 부분만 남긴 정제 이미지를 만듭니다.
4. **OCR**: 정제된 이미지에 Tesseract(`kor+eng`)를 실행하고, 신뢰도 낮은 결과를 한 번 더 걸러냅니다.

이미지 정제와 텍스트 필터링 모두 같은 마스크를 사용하므로, 손글씨 판정 로직은 한 곳(`app/handwriting.py`)에만 있습니다.

> ⚠️ **한계**: 손글씨 감지는 학습된 모델이 아니라 규칙 기반 휴리스틱입니다. 인쇄 텍스트와 겹치거나 획이 매우 가는 손글씨, 혹은 인쇄 텍스트와 비슷한 굵기의 손글씨는 완벽히 구분되지 않을 수 있습니다. `app/handwriting.py` 상단의 임계값을 조정해 특정 문서 유형에 맞출 수 있습니다.

### 설치

시스템 패키지 (Tesseract, 한국어 언어팩):

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-kor
```

Python 패키지:

```bash
pip install -r requirements.txt
```

### 실행

```bash
uvicorn app.main:app --reload --port 8000
```

브라우저에서 http://localhost:8000 접속 후 PDF 파일을 업로드합니다.

결과 화면에서 원본 / 감지된 손글씨(빨간 표시) / 정제된 페이지 이미지를 비교할 수 있고, 정제된 PDF와 추출된 텍스트(.txt)를 다운로드할 수 있습니다.

### 테스트

```bash
pip install pytest
pytest
```

---

## 프로젝트 구조

```
app/                     서버 버전 (Python/FastAPI)
  main.py                FastAPI 라우트 (업로드, 처리, 다운로드)
  pipeline.py            PDF → 이미지 → 손글씨 제거 → OCR 전체 흐름
  pdf_utils.py           PDF ↔ 이미지 변환 (PyMuPDF)
  handwriting.py         손글씨 감지/제거 (OpenCV 기반 휴리스틱)
  ocr.py                 Tesseract OCR 래퍼
  templates/, static/    업로드 폼 / 결과 페이지 / 스타일시트
tests/
  test_pipeline.py       서버 버전 파이프라인 테스트

web/                     정적 PWA (GitHub Pages, 아이폰/아이패드용)
  index.html             단일 페이지 앱
  manifest.webmanifest   PWA 매니페스트 (홈 화면 추가용)
  service-worker.js      앱 셸 오프라인 캐시
  css/style.css
  js/
    app.js               UI 컨트롤러
    pdfRender.js          PDF → 캔버스 (pdf.js)
    handwriting.js         손글씨 감지/제거 (순수 JS 휴리스틱)
    imageProc.js            픽셀 처리 유틸 (그레이스케일, Otsu, connected components, ...)
    ocr.js                 Tesseract.js 래퍼
    pdfExport.js           캔버스 → 다운로드용 PDF (jsPDF)
  icons/                 PWA 아이콘
webtests/
  handwriting.test.mjs   web/js 핵심 로직 테스트 (Node 내장 테스트 러너)
  fixtures/              테스트용 이미지

.github/workflows/
  deploy-pages.yml       web/ 를 GitHub Pages에 자동 배포
```
