import threading
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from mixer_engine import MixJobManager, MixRequest, FourierMixer, MixerService, MixJobState

app = FastAPI(title="Fourier Mixer API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_jobs = MixJobManager()


@app.post("/api/sync")
async def sync(
    image0: Optional[UploadFile] = File(default=None),
    image1: Optional[UploadFile] = File(default=None),
    image2: Optional[UploadFile] = File(default=None),
    image3: Optional[UploadFile] = File(default=None),
):
    imgs = await MixerService.build_images_from_uploads([image0, image1, image2, image3])
    mixer = FourierMixer(imgs)
    return mixer.sync_payload()


@app.post("/api/mix_start")
def mix_start(req: MixRequest):
    job = _jobs.create_job()
    t = threading.Thread(target=job.run, args=(req,), daemon=True)
    t.start()
    return {"job_id": job.job_id}


@app.get("/api/mix_status/{job_id}")
def mix_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    state = job.state()
    payload = {
        "job_id": job_id,
        "state": state,
        "progress": job.progress(),
    }
    if state == MixJobState.DONE:
        payload["output_png_b64"] = job.output_b64()
    if state == MixJobState.ERROR:
        payload["error"] = job.error() or "Unknown error"
    return payload


@app.post("/api/mix_cancel/{job_id}")
def mix_cancel(job_id: str):
    ok = _jobs.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True}