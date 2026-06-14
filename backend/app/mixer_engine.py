from __future__ import annotations

from dataclasses import dataclass
import threading
from typing import Dict, List, Optional
import uuid

from fastapi import UploadFile
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from fourier_core import FourierImage
from utils import PNGCodec

# Exception raised when a mix operation is cancelled
class CancelledMix(Exception):
    pass


@dataclass(frozen=True)
class ROI:
    """Region of interest expressed as percentages."""
    x: float
    y: float
    w: float
    h: float

    def mask(self, H: int, W: int, region: str) -> np.ndarray:
        """Create a frequency-domain mask for the selected region."""
        if region == "full":
            return np.ones((H, W), dtype=np.float32)

        x0 = int(round((self.x / 100.0) * W))
        y0 = int(round((self.y / 100.0) * H))
        x1 = int(round(((self.x + self.w) / 100.0) * W))
        y1 = int(round(((self.y + self.h) / 100.0) * H))

        x0 = max(0, min(W, x0))
        x1 = max(0, min(W, x1))
        y0 = max(0, min(H, y0))
        y1 = max(0, min(H, y1))

        if x1 <= x0 or y1 <= y0:
            return np.ones((H, W), dtype=np.float32)

        if region == "inner":
            m = np.zeros((H, W), dtype=np.float32)
            m[y0:y1, x0:x1] = 1.0
            return m

        m = np.ones((H, W), dtype=np.float32)
        m[y0:y1, x0:x1] = 0.0
        return m


class MixContext:
    """Provides cancellation and progress tracking for long-running tasks."""

    def __init__(self, cancel_event: threading.Event):
        self._cancel = cancel_event
        self._lock = threading.Lock()
        self._progress = 0.0

    def check_cancel(self) -> None:
        """Raise an exception if cancellation was requested."""
        if self._cancel.is_set():
            raise CancelledMix()

    def set_progress(self, p: float) -> None:
        """Update progress value in the range [0, 1]."""
        p = float(max(0.0, min(1.0, p)))
        with self._lock:
            if p > self._progress:
                self._progress = p

    def progress(self) -> float:
        with self._lock:
            return float(self._progress)


class FourierMixer:
    """Handles Fourier-domain image mixing operations."""

    def __init__(self, images: List[Optional[FourierImage]]):
        self._images = images

    def unify_to_smallest(self) -> FourierMixer:
        """Resize all loaded images to a common minimum size."""
        loaded = [im for im in self._images if im is not None]
        if not loaded:
            return self

        min_h = min(im.shape[0] for im in loaded)
        min_w = min(im.shape[1] for im in loaded)

        new_imgs: List[Optional[FourierImage]] = []
        for im in self._images:
            if im is None:
                new_imgs.append(None)
            else:
                if im.shape != (min_h, min_w):
                    new_imgs.append(im.resized(min_h, min_w))
                else:
                    new_imgs.append(im)
        return FourierMixer(new_imgs)

    def sync_payload(self) -> Dict:
        """Generate synchronized image and Fourier previews."""
        m = self.unify_to_smallest()
        slots = []
        for im in m._images:
            if im is None:
                slots.append({"has": False})
            else:
                slots.append({
                    "has": True,
                    "unified_png_b64": im.to_unified_png_b64(),
                    "ft": im.component_previews_b64(),
                })
        loaded = [im for im in m._images if im is not None]
        size = {"w": loaded[0].shape[1], "h": loaded[0].shape[0]} if loaded else {"w": 0, "h": 0}
        return {"size": size, "slots": slots}

    @staticmethod
    def _normalize_weights(ws: np.ndarray) -> np.ndarray:
        """Normalize weights to sum to one."""
        ws = ws.astype(np.float32)
        s = float(np.sum(ws))
        if s <= 1e-9:
            return np.zeros_like(ws, dtype=np.float32)
        return ws / s

    def mix_with_progress(
        self,
        weights_a: List[float],
        weights_b: List[float],
        roi: ROI,
        regions: Dict[str, str],
        mixing_mode: str,
        ctx: MixContext,
    ) -> bytes:
        ctx.set_progress(0.02)
        ctx.check_cancel()

        m = self.unify_to_smallest()
        imgs = m._images

        if mixing_mode == "real_imag":
            compA, compB = "real", "imag"
        elif mixing_mode == "mag_phase":
            compA, compB = "mag", "phase"
        else:
            raise ValueError("mixing_mode must be 'real_imag' or 'mag_phase'")

        regA = regions.get(compA, "full")
        regB = regions.get(compB, "full")

        specsA = []
        specsB = []
        wA = []
        wB = []

        loaded = [(im, wa, wb) for im, wa, wb in zip(imgs, weights_a, weights_b) if im is not None]
        if not loaded:
            blank = Image.new("L", (320, 240), color=235)
            return PNGCodec.pil_to_png_bytes(blank)

        base0, base1 = 0.05, 0.55
        n = len(loaded)

        for i, (im, wa, wb) in enumerate(loaded):
            ctx.check_cancel()
            ctx.set_progress(base0 + (base1 - base0) * (i / max(1, n)))

            specsA.append(im.spectrum_shifted_masked(roi, region=regA, ctx=ctx))
            specsB.append(im.spectrum_shifted_masked(roi, region=regB, ctx=ctx))
            wA.append(float(wa))
            wB.append(float(wb))

        ctx.check_cancel()
        ctx.set_progress(0.58)

        SA = np.stack(specsA, axis=0)
        SB = np.stack(specsB, axis=0)

        wA_np = self._normalize_weights(np.array(wA, dtype=np.float32)).reshape((-1, 1, 1))
        wB_np = self._normalize_weights(np.array(wB, dtype=np.float32)).reshape((-1, 1, 1))

        ctx.check_cancel()
        ctx.set_progress(0.64)

        if mixing_mode == "real_imag":
            R = np.sum(wA_np * np.real(SA), axis=0)
            I = np.sum(wB_np * np.imag(SB), axis=0)
            Smix = (R + 1j * I).astype(np.complex64)
        else:
            Mag = np.sum(wA_np * np.abs(SA), axis=0).astype(np.float32)
            phs = np.angle(SB).astype(np.float32)
            Phase = np.sum(wB_np * phs, axis=0).astype(np.float32)
            Smix = (Mag * np.exp(1j * Phase)).astype(np.complex64)

        ctx.check_cancel()
        ctx.set_progress(0.72)

        Smix_unshift = np.fft.ifftshift(Smix)

        ctx.check_cancel()
        ctx.set_progress(0.78)
        tmp = np.fft.ifft(Smix_unshift, axis=0)

        ctx.check_cancel()
        ctx.set_progress(0.88)
        out = np.fft.ifft(tmp, axis=1)

        ctx.check_cancel()
        ctx.set_progress(0.94)

        out_real = np.real(out).astype(np.float32)
        out_u8 = self._normalize_image(out_real)

        ctx.check_cancel()
        ctx.set_progress(1.0)

        pil = Image.fromarray(out_u8, mode="L")
        return PNGCodec.pil_to_png_bytes(pil)

    @staticmethod
    def _normalize_image(x: np.ndarray) -> np.ndarray:
        mn = float(np.min(x))
        mx = float(np.max(x))
        if mx - mn < 1e-9:
            return np.zeros_like(x, dtype=np.uint8)
        v = (x - mn) / (mx - mn)
        return (v * 255.0).clip(0, 255).astype(np.uint8)


class RoiModel(BaseModel):
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    w: float = Field(ge=1, le=100)
    h: float = Field(ge=1, le=100)

    def to_roi(self) -> ROI:
        return ROI(x=self.x, y=self.y, w=self.w, h=self.h)


class RegionsModel(BaseModel):
    mag: str = Field(pattern="^(inner|outer|full)$")
    phase: str = Field(pattern="^(inner|outer|full)$")
    real: str = Field(pattern="^(inner|outer|full)$")
    imag: str = Field(pattern="^(inner|outer|full)$")

    def to_dict(self) -> Dict[str, str]:
        return {"mag": self.mag, "phase": self.phase, "real": self.real, "imag": self.imag}


class MixRequest(BaseModel):
    images_png_b64: List[Optional[str]] = Field(min_length=4, max_length=4)
    weights_a: List[float] = Field(min_length=4, max_length=4)
    weights_b: List[float] = Field(min_length=4, max_length=4)
    roi: RoiModel
    regions: RegionsModel
    mixing_mode: str = Field(pattern="^(real_imag|mag_phase)$")


class MixerService:
    @staticmethod
    async def build_images_from_uploads(files: List[Optional[UploadFile]]) -> List[Optional[FourierImage]]:
        images: List[Optional[FourierImage]] = [None, None, None, None]
        for i, f in enumerate(files):
            if f is None:
                continue
            data = await f.read()
            images[i] = FourierImage.from_upload_bytes(data)
        return images

    @staticmethod
    def build_images_from_b64(b64_list: List[Optional[str]]) -> List[Optional[FourierImage]]:
        images: List[Optional[FourierImage]] = [None, None, None, None]
        for i, s in enumerate(b64_list):
            if not s:
                continue
            png = PNGCodec.png_bytes_from_b64(s)
            images[i] = FourierImage.from_upload_bytes(png)
        return images


class MixJobState:
    RUNNING = "running"
    DONE = "done"
    CANCELLED = "cancelled"
    ERROR = "error"


class MixJob:
    def __init__(self, job_id: str):
        self.job_id = job_id
        self.cancel_event = threading.Event()
        self.ctx = MixContext(self.cancel_event)

        self._lock = threading.Lock()
        self._state = MixJobState.RUNNING
        self._output_b64: Optional[str] = None
        self._error: Optional[str] = None

    def cancel(self) -> None:
        self.cancel_event.set()

    def progress(self) -> float:
        return self.ctx.progress()

    def state(self) -> str:
        with self._lock:
            return self._state

    def output_b64(self) -> Optional[str]:
        with self._lock:
            return self._output_b64

    def error(self) -> Optional[str]:
        with self._lock:
            return self._error

    def _set_done(self, out_png: bytes) -> None:
        with self._lock:
            self._output_b64 = PNGCodec.b64_from_png_bytes(out_png)
            self._state = MixJobState.DONE

    def _set_cancelled(self) -> None:
        with self._lock:
            self._state = MixJobState.CANCELLED

    def _set_error(self, msg: str) -> None:
        with self._lock:
            self._error = msg
            self._state = MixJobState.ERROR

    def run(self, req: MixRequest) -> None:
        try:
            self.ctx.set_progress(0.01)
            imgs = MixerService.build_images_from_b64(req.images_png_b64)
            mixer = FourierMixer(imgs)

            roi = req.roi.to_roi()
            regions = req.regions.to_dict()

            self.ctx.check_cancel()
            self.ctx.set_progress(0.03)

            out_png = mixer.mix_with_progress(
                weights_a=req.weights_a,
                weights_b=req.weights_b,
                roi=roi,
                regions=regions,
                mixing_mode=req.mixing_mode,
                ctx=self.ctx,
            )
            self._set_done(out_png)
        except CancelledMix:
            self._set_cancelled()
        except Exception as e:
            self._set_error(str(e))


class MixJobManager:
    def __init__(self):
        self._lock = threading.Lock()
        self._jobs: Dict[str, MixJob] = {}

    def create_job(self) -> MixJob:
        jid = str(uuid.uuid4())
        job = MixJob(jid)
        with self._lock:
            self._jobs[jid] = job
        return job

    def get(self, jid: str) -> Optional[MixJob]:
        with self._lock:
            return self._jobs.get(jid)

    def cancel(self, jid: str) -> bool:
        job = self.get(jid)
        if not job:
            return False
        job.cancel()
        return True