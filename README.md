# PDF OCR & 필기 제거

스캔한 PDF를 업로드하면 손글씨(펜 표시, 메모, 서명 등)를 지우고 인쇄된 텍스트만 OCR로 추출해주는 웹 앱입니다.

## 동작 방식

1. **PDF → 이미지**: PyMuPDF로 각 페이지를 고해상도 이미지로 렌더링합니다.
2. **손글씨 감지**: 규칙 기반 휴리스틱 두 가지를 결합해 손글씨 잉크 마스크를 만듭니다.
   - 색이 있는 펜 자국 (인쇄된 검정 텍스트와 다른 색상의 잉크, HSV 채도 기준)
   - 획 굵기가 불규칙한 검정 잉크 (인쇄 폰트는 획 굵기가 일정하지만, 손글씨는 필압/각도 변화로 굵기 편차와 낮은 형태 견고성(solidity)을 보임)
3. **제거**: 감지된 마스크 영역을 인페인팅(`cv2.inpaint`)으로 지워, 인쇄된 부분만 남긴 정제 이미지를 만듭니다.
4. **OCR**: 정제된 이미지에 Tesseract(`kor+eng`)를 실행하고, 신뢰도 낮은 결과를 한 번 더 걸러냅니다.

이미지 정제와 텍스트 필터링 모두 같은 마스크를 사용하므로, 손글씨 판정 로직은 한 곳(`app/handwriting.py`)에만 있습니다.

> ⚠️ **한계**: 손글씨 감지는 학습된 모델이 아니라 규칙 기반 휴리스틱입니다. 인쇄 텍스트와 겹치거나 획이 매우 가는 손글씨, 혹은 인쇄 텍스트와 비슷한 굵기의 손글씨는 완벽히 구분되지 않을 수 있습니다. `app/handwriting.py` 상단의 임계값을 조정해 특정 문서 유형에 맞출 수 있습니다.

## 설치

시스템 패키지 (Tesseract, 한국어 언어팩):

```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-kor
```

Python 패키지:

```bash
pip install -r requirements.txt
```

## 실행

```bash
uvicorn app.main:app --reload --port 8000
```

브라우저에서 http://localhost:8000 접속 후 PDF 파일을 업로드합니다.

결과 화면에서 원본 / 감지된 손글씨(빨간 표시) / 정제된 페이지 이미지를 비교할 수 있고, 정제된 PDF와 추출된 텍스트(.txt)를 다운로드할 수 있습니다.

## 테스트

```bash
pip install pytest
pytest
```

## 프로젝트 구조

```
app/
  main.py          FastAPI 라우트 (업로드, 처리, 다운로드)
  pipeline.py      PDF → 이미지 → 손글씨 제거 → OCR 전체 흐름
  pdf_utils.py     PDF ↔ 이미지 변환 (PyMuPDF)
  handwriting.py   손글씨 감지/제거 (휴리스틱)
  ocr.py           Tesseract OCR 래퍼
  templates/       업로드 폼 / 결과 페이지
  static/          스타일시트
tests/
  test_pipeline.py 손글씨 제거 및 OCR 파이프라인 검증
```
