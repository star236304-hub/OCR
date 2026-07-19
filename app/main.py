"""Web app: upload a PDF, get back handwriting-cleaned pages + OCR text."""

import re
import uuid
from pathlib import Path

import cv2
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app import pdf_utils, pipeline

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR.parent / "data" / "jobs"
DATA_DIR.mkdir(parents=True, exist_ok=True)

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")

app = FastAPI(title="PDF OCR & 필기 제거")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
app.mount("/jobs", StaticFiles(directory=str(DATA_DIR)), name="jobs")


def _job_dir(job_id: str) -> Path:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=400, detail="잘못된 작업 ID입니다.")
    return DATA_DIR / job_id


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.post("/process", response_class=HTMLResponse)
async def process(request: Request, file: UploadFile = File(...)):
    if file.content_type != "application/pdf" and not file.filename.lower().endswith(".pdf"):
        return templates.TemplateResponse(
            request, "index.html", {"error": "PDF 파일만 업로드할 수 있습니다."}
        )

    pdf_bytes = await file.read()
    try:
        pages = pipeline.process_pdf(pdf_bytes)
    except Exception:
        return templates.TemplateResponse(
            request,
            "index.html",
            {"error": "PDF를 처리하지 못했습니다. 파일이 손상되었거나 지원되지 않는 형식일 수 있습니다."},
        )

    if not pages:
        return templates.TemplateResponse(
            request, "index.html", {"error": "PDF에서 페이지를 찾을 수 없습니다."}
        )

    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    page_infos = []
    cleaned_images = []
    all_text = []
    for idx, page in enumerate(pages, start=1):
        cv2.imwrite(str(job_dir / f"page_{idx}_original.png"), page["original"])
        cv2.imwrite(str(job_dir / f"page_{idx}_cleaned.png"), page["cleaned"])
        cv2.imwrite(str(job_dir / f"page_{idx}_mask.png"), page["mask_overlay"])
        cleaned_images.append(page["cleaned"])
        all_text.append(page["text"])
        page_infos.append(
            {
                "index": idx,
                "original_url": f"/jobs/{job_id}/page_{idx}_original.png",
                "cleaned_url": f"/jobs/{job_id}/page_{idx}_cleaned.png",
                "mask_url": f"/jobs/{job_id}/page_{idx}_mask.png",
                "text": page["text"],
            }
        )

    full_text = "\n\n".join(all_text)
    (job_dir / "extracted_text.txt").write_text(full_text, encoding="utf-8")
    (job_dir / "cleaned.pdf").write_bytes(pdf_utils.images_to_pdf(cleaned_images))

    return templates.TemplateResponse(
        request,
        "result.html",
        {
            "job_id": job_id,
            "pages": page_infos,
        },
    )


@app.get("/download/{job_id}/text")
def download_text(job_id: str):
    path = _job_dir(job_id) / "extracted_text.txt"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(path, filename="extracted_text.txt", media_type="text/plain")


@app.get("/download/{job_id}/pdf")
def download_pdf(job_id: str):
    path = _job_dir(job_id) / "cleaned.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    return FileResponse(path, filename="cleaned.pdf", media_type="application/pdf")
