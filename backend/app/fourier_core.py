from __future__ import annotations

from typing import Dict, Optional, Tuple, TYPE_CHECKING
import numpy as np
from PIL import Image

from utils import PNGCodec, to_grayscale_array, resize_grayscale_array

# Avoid circular imports during runtime
if TYPE_CHECKING:
    from mixer_engine import ROI, MixContext


class FourierImage:
    def __init__(self, gray_u8: np.ndarray):
        if gray_u8.ndim != 2:
            raise ValueError("Expected 2D grayscale image.")

        self._img_u8 = gray_u8.astype(np.uint8, copy=False)
        self._spec_shifted: Optional[np.ndarray] = None  # Cached FFT spectrum

    @staticmethod
    def from_upload_bytes(png_bytes: bytes) -> FourierImage:
        """Create an instance from uploaded image bytes."""
        arr = to_grayscale_array(png_bytes)
        return FourierImage(arr)

    @property
    def shape(self) -> Tuple[int, int]:
        """Return image dimensions as (height, width)."""
        h, w = self._img_u8.shape
        return h, w

    def resized(self, target_h: int, target_w: int) -> FourierImage:
        """Return a resized copy of the image."""
        resized_arr = resize_grayscale_array(self._img_u8, target_h, target_w)
        return FourierImage(resized_arr)

    def to_unified_png_b64(self) -> str:
        """Encode the image as Base64 PNG."""
        pil = Image.fromarray(self._img_u8, mode="L")
        return PNGCodec.b64_from_png_bytes(PNGCodec.pil_to_png_bytes(pil))

    def spectrum_shifted(self, ctx: Optional[MixContext] = None) -> np.ndarray:
        """Compute and cache the centered Fourier spectrum."""
        if self._spec_shifted is not None:
            return self._spec_shifted

        if ctx:
            ctx.check_cancel()
            ctx.set_progress(max(ctx.progress(), 0.10))

        img = self._img_u8.astype(np.float32)

        if ctx:
            ctx.check_cancel()
            ctx.set_progress(max(ctx.progress(), 0.14))
        F0 = np.fft.fft(img, axis=0)

        if ctx:
            ctx.check_cancel()
            ctx.set_progress(max(ctx.progress(), 0.18))
        F = np.fft.fft(F0, axis=1)

        if ctx:
            ctx.check_cancel()
            ctx.set_progress(max(ctx.progress(), 0.22))
        S = np.fft.fftshift(F).astype(np.complex64)

        self._spec_shifted = S
        return S

    def component_previews_b64(self) -> Dict[str, str]:
        """Generate preview images for Fourier components."""
        S = self.spectrum_shifted(ctx=None)

        mag = np.abs(S)
        phase = np.angle(S)
        real = np.real(S)
        imag = np.imag(S)

        mag_img = self._normalize_log(mag)
        phase_img = self._normalize_phase(phase)
        real_img = self._normalize_signed(real)
        imag_img = self._normalize_signed(imag)

        return {
            "mag": PNGCodec.b64_from_png_bytes(
                PNGCodec.pil_to_png_bytes(Image.fromarray(mag_img, mode="L"))
            ),
            "phase": PNGCodec.b64_from_png_bytes(
                PNGCodec.pil_to_png_bytes(Image.fromarray(phase_img, mode="L"))
            ),
            "real": PNGCodec.b64_from_png_bytes(
                PNGCodec.pil_to_png_bytes(Image.fromarray(real_img, mode="L"))
            ),
            "imag": PNGCodec.b64_from_png_bytes(
                PNGCodec.pil_to_png_bytes(Image.fromarray(imag_img, mode="L"))
            ),
        }

    @staticmethod
    def _normalize_log(x: np.ndarray) -> np.ndarray:
        """Log-scale normalization for magnitude visualization."""
        v = np.log1p(x.astype(np.float32))
        v /= (v.max() + 1e-9)
        return (v * 255.0).clip(0, 255).astype(np.uint8)

    @staticmethod
    def _normalize_phase(ph: np.ndarray) -> np.ndarray:
        """Map phase values from [-π, π] to [0, 255]."""
        v = (ph + np.pi) / (2.0 * np.pi)
        return (v * 255.0).clip(0, 255).astype(np.uint8)

    @staticmethod
    def _normalize_signed(x: np.ndarray) -> np.ndarray:
        """Normalize signed values for display."""
        x = x.astype(np.float32)
        m = np.max(np.abs(x)) + 1e-9
        v = (x / m) * 0.5 + 0.5
        return (v * 255.0).clip(0, 255).astype(np.uint8)

    def spectrum_shifted_masked(
        self,
        roi: ROI,
        region: str,
        ctx: Optional[MixContext] = None
    ) -> np.ndarray:
        """Apply an ROI mask to the centered spectrum."""
        S = self.spectrum_shifted(ctx=ctx)
        H, W = S.shape
        m = roi.mask(H, W, region=region)

        return (S * m).astype(np.complex64)