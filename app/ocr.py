"""Tesseract OCR wrapper with confidence-based filtering."""

import cv2
import numpy as np
import pytesseract
from pytesseract import Output

DEFAULT_LANG = "kor+eng"
MIN_CONFIDENCE = 40


def run_ocr(
    img_bgr: np.ndarray, lang: str = DEFAULT_LANG, min_confidence: int = MIN_CONFIDENCE
) -> tuple[str, list[dict]]:
    """OCR an image and return (full_text, word_list).

    Words below `min_confidence` (Tesseract's 0-100 score; -1 means "not
    text") are dropped. Since handwriting has already been removed from the
    image before this runs, this also acts as a second safety net against
    any inpainting artifacts being misread as text.
    """
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    data = pytesseract.image_to_data(rgb, lang=lang, output_type=Output.DICT)

    words = []
    lines: dict[tuple[int, int, int], list[str]] = {}
    for i in range(len(data["text"])):
        text = data["text"][i].strip()
        conf = float(data["conf"][i])
        if not text or conf < min_confidence:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        lines.setdefault(key, []).append(text)
        words.append(
            {
                "text": text,
                "confidence": conf,
                "bbox": [data["left"][i], data["top"][i], data["width"][i], data["height"][i]],
            }
        )

    full_text = "\n".join(" ".join(w) for w in lines.values())
    return full_text, words
