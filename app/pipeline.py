"""End-to-end PDF -> (cleaned pages + OCR text) pipeline."""

from . import handwriting, ocr, pdf_utils


def process_pdf(pdf_bytes: bytes, dpi: int = 300, lang: str = ocr.DEFAULT_LANG) -> list[dict]:
    pages = []
    for img in pdf_utils.pdf_to_images(pdf_bytes, dpi=dpi):
        mask = handwriting.detect_handwriting_mask(img)
        cleaned = handwriting.remove_handwriting(img, mask)
        text, words = ocr.run_ocr(cleaned, lang=lang)
        pages.append(
            {
                "original": img,
                "cleaned": cleaned,
                "mask_overlay": handwriting.visualize_mask(img, mask),
                "text": text,
                "words": words,
            }
        )
    return pages
