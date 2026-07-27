"""Heuristic handwriting detection and removal.

This is not a trained ML classifier - there is no labeled dataset to train
one in this project. Instead it combines two cheap, explainable signals that
work well in practice for scanned/annotated documents:

1. Colored ink: handwritten annotations on printed documents are very often
   made with a pen of a different (and non-neutral) color than the printed
   black text. Pixels with high HSV saturation are flagged directly.
2. Stroke-width irregularity: printed glyphs come from a font, so the stroke
   width within a connected component is close to constant. Handwriting has
   uneven stroke width from pen pressure/angle changes and tends to have
   lower contour solidity (more concave, looping shapes). Components whose
   stroke-width coefficient of variation and solidity fall outside the
   printed-text range are flagged as handwriting.

Both signals produce a single binary mask, which is then inpainted over to
erase the handwriting.

Tune the thresholds below if a particular document set behaves differently.

Note that the browser build (web/js/handwriting.js) uses a different, better
-tuned classifier - extent and circularity per component, plus a run-length
test that protects printed rules and table borders - and is the version that
receives ongoing work.
"""

import cv2
import numpy as np

COLOR_SATURATION_THRESHOLD = 40
MIN_COMPONENT_AREA = 6
STROKE_CV_THRESHOLD = 0.6
SOLIDITY_THRESHOLD = 0.55
MASK_DILATE_KERNEL = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))


def _colored_ink_mask(img_bgr: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    saturation = hsv[..., 1]
    mask = saturation > COLOR_SATURATION_THRESHOLD
    return (mask.astype(np.uint8)) * 255


def _black_handwriting_mask(gray: np.ndarray, exclude_mask: np.ndarray) -> np.ndarray:
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    binary = cv2.bitwise_and(binary, cv2.bitwise_not(exclude_mask))

    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)

    mask = np.zeros_like(gray, dtype=np.uint8)
    for label in range(1, num_labels):
        area = stats[label, cv2.CC_STAT_AREA]
        if area < MIN_COMPONENT_AREA:
            continue
        comp = labels == label
        widths = dist[comp]
        widths = widths[widths > 0]
        if widths.size < 5:
            continue
        mean_w, std_w = float(widths.mean()), float(widths.std())
        cv_w = std_w / mean_w if mean_w > 0 else 0.0

        contours, _ = cv2.findContours(
            (comp.astype(np.uint8)) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        solidity = 1.0
        if contours:
            hull_area = cv2.contourArea(cv2.convexHull(contours[0]))
            if hull_area > 0:
                solidity = area / hull_area

        if cv_w > STROKE_CV_THRESHOLD and solidity < SOLIDITY_THRESHOLD:
            mask[comp] = 255
    return mask


def detect_handwriting_mask(img_bgr: np.ndarray) -> np.ndarray:
    """Return a binary (0/255) mask of pixels classified as handwriting ink."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    colored_mask = _colored_ink_mask(img_bgr)
    black_mask = _black_handwriting_mask(gray, exclude_mask=colored_mask)
    mask = cv2.bitwise_or(colored_mask, black_mask)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, MASK_DILATE_KERNEL)


def remove_handwriting(img_bgr: np.ndarray, mask: np.ndarray, inpaint_radius: int = 6) -> np.ndarray:
    """Inpaint over the masked handwriting ink, restoring the plain page underneath."""
    dilated = cv2.dilate(mask, MASK_DILATE_KERNEL, iterations=1)
    return cv2.inpaint(img_bgr, dilated, inpaint_radius, cv2.INPAINT_TELEA)


def visualize_mask(img_bgr: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Overlay the detected handwriting regions in red for review in the UI."""
    overlay = img_bgr.copy()
    overlay[mask > 0] = (0, 0, 255)
    return cv2.addWeighted(overlay, 0.5, img_bgr, 0.5, 0)
