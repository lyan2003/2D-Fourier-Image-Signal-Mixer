from __future__ import annotations

import base64
import io
from typing import List, Tuple
import numpy as np
from PIL import Image


class PNGCodec:
    @staticmethod
    def pil_to_png_bytes(img: Image.Image) -> bytes:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    @staticmethod
    def png_bytes_to_pil(b: bytes) -> Image.Image:
        return Image.open(io.BytesIO(b))

    @staticmethod
    def b64_from_png_bytes(png: bytes) -> str:
        return base64.b64encode(png).decode("utf-8")

    @staticmethod
    def png_bytes_from_b64(s: str) -> bytes:
        if "," in s:
            s = s.split(",", 1)[1]
        return base64.b64decode(s.encode("utf-8"))


def to_grayscale_array(png_bytes: bytes) -> np.ndarray:
    """Converts raw PNG bytes into a 2D grayscale NumPy array."""
    pil = PNGCodec.png_bytes_to_pil(png_bytes).convert("L")
    return np.array(pil, dtype=np.uint8)


def resize_grayscale_array(arr: np.ndarray, target_h: int, target_w: int) -> np.ndarray:
    """Resizes a 2D grayscale array to target dimensions using bilinear interpolation."""
    pil = Image.fromarray(arr, mode="L")
    pil_resized = pil.resize((target_w, target_h), resample=Image.BILINEAR)
    return np.array(pil_resized, dtype=np.uint8)