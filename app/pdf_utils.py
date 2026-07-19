"""PDF <-> image conversion helpers built on PyMuPDF."""

import io

import cv2
import fitz
import numpy as np
from PIL import Image


def pdf_to_images(pdf_bytes: bytes, dpi: int = 300) -> list[np.ndarray]:
    """Render every page of a PDF to a BGR image (OpenCV convention)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    zoom = dpi / 72
    matrix = fitz.Matrix(zoom, zoom)
    images = []
    try:
        for page in doc:
            pix = page.get_pixmap(matrix=matrix, colorspace=fitz.csRGB)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            images.append(cv2.cvtColor(arr, cv2.COLOR_RGB2BGR))
    finally:
        doc.close()
    return images


def images_to_pdf(images_bgr: list[np.ndarray]) -> bytes:
    """Pack a list of BGR images into a single multi-page PDF."""
    if not images_bgr:
        raise ValueError("images_bgr must not be empty")
    pil_pages = [Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)) for img in images_bgr]
    buf = io.BytesIO()
    pil_pages[0].save(buf, format="PDF", save_all=True, append_images=pil_pages[1:])
    return buf.getvalue()
