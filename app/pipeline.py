"""End-to-end PDF -> cleaned pages pipeline."""

from . import handwriting, pdf_utils


def process_pdf(pdf_bytes: bytes, dpi: int = 150) -> list[dict]:
    pages = []
    for img in pdf_utils.pdf_to_images(pdf_bytes, dpi=dpi):
        mask = handwriting.detect_handwriting_mask(img)
        cleaned = handwriting.remove_handwriting(img, mask)
        pages.append(
            {
                "original": img,
                "cleaned": cleaned,
                "mask_overlay": handwriting.visualize_mask(img, mask),
            }
        )
    return pages
