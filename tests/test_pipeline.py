"""Pipeline smoke tests using a synthetic page: printed text + a pen scribble."""

import cv2
import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from app import handwriting, ocr, pdf_utils

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def _synthetic_page() -> np.ndarray:
    img = Image.new("RGB", (900, 300), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, 48)
    draw.text((40, 40), "HELLO WORLD", fill=(0, 0, 0), font=font)
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    # Simulate a red-pen handwritten scribble below the printed line.
    pts = np.array(
        [[60, 180], [120, 220], [180, 160], [240, 210], [300, 170], [360, 200]], dtype=np.int32
    )
    cv2.polylines(bgr, [pts], isClosed=False, color=(0, 0, 255), thickness=4)
    return bgr


def test_handwriting_mask_flags_colored_scribble_not_printed_text():
    img = _synthetic_page()
    mask = handwriting.detect_handwriting_mask(img)

    # The scribble region should be flagged...
    assert mask[190:210, 100:350].sum() > 0
    # ...while the printed text region should be left alone.
    assert mask[40:90, 40:400].sum() == 0


def test_remove_handwriting_erases_scribble_and_keeps_text_ocrable():
    img = _synthetic_page()
    mask = handwriting.detect_handwriting_mask(img)
    cleaned = handwriting.remove_handwriting(img, mask)

    # No strongly red pixels should remain where the scribble was.
    region = cleaned[160:230, 50:370]
    red_pixels = np.sum((region[..., 2] > 150) & (region[..., 1] < 100))
    assert red_pixels == 0

    text, _ = ocr.run_ocr(cleaned, lang="eng")
    assert "HELLO" in text.upper()


def test_images_to_pdf_and_back_roundtrip():
    img = _synthetic_page()
    pdf_bytes = pdf_utils.images_to_pdf([img])
    pages = pdf_utils.pdf_to_images(pdf_bytes, dpi=150)
    assert len(pages) == 1
    assert pages[0].shape[0] > 0 and pages[0].shape[1] > 0
