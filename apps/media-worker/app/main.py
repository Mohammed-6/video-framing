"""FastAPI surface for the media worker: health checks, and optionally the embedded consumer.

The worker doesn't accept jobs over HTTP — jobs come from Postgres — so this app is
mainly for liveness/readiness probes and for Cloud Run, which requires a listening port.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from .config import get_settings
from .consumers.runner import Worker
from .db import connect

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

_worker: Worker | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global _worker
    if get_settings().worker_embedded:
        _worker = Worker()
        _worker.start()
    yield
    if _worker:
        _worker.stop()


app = FastAPI(title="ClipForge media worker", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/readyz")
def readyz() -> dict:
    try:
        with connect() as conn:
            conn.execute("SELECT 1")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"database unavailable: {exc}") from exc
    return {"ok": True, "embeddedWorker": _worker is not None, "busy": _worker.busy if _worker else 0}
