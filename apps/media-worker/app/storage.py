"""Blob storage for the worker: resolve inputs, upload outputs, fetch local copies."""

from __future__ import annotations

import datetime as dt
import os
import shutil
import uuid
from pathlib import Path
from typing import Protocol

from .config import Settings, get_settings
from .errors import PipelineError


class Storage(Protocol):
    def input_ref(self, key: str, work_dir: Path) -> str:
        """Something ffmpeg can read: a local path or a signed HTTPS URL."""

    def local_file(self, key: str, work_dir: Path) -> Path:
        """A real local file (downloaded if needed) — publishers need byte access."""

    def upload_file(self, path: Path, key: str, content_type: str) -> None: ...


def _safe_key(key: str) -> str:
    parts = key.split("/")
    if not key or any(p in ("", ".", "..") for p in parts):
        raise PipelineError("invalid_blob_key", f"Invalid blob key: {key!r}")
    return key


class LocalStorage:
    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / _safe_key(key)).resolve()
        if self.root not in p.parents:
            raise PipelineError("invalid_blob_key", f"Invalid blob key: {key!r}")
        return p

    def input_ref(self, key: str, work_dir: Path) -> str:
        return str(self.local_file(key, work_dir))

    def local_file(self, key: str, work_dir: Path) -> Path:
        p = self.path(key)
        if not p.exists():
            raise PipelineError("source_missing", f"File not found in storage: {key}")
        return p

    def upload_file(self, path: Path, key: str, content_type: str) -> None:
        dest = self.path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f"{dest.name}.{uuid.uuid4().hex}.part")
        shutil.copyfile(path, tmp)
        os.replace(tmp, dest)


class GcsStorage:
    def __init__(self, bucket: str, stream_input: bool):
        from google.cloud import storage

        self.client = storage.Client()
        self.bucket = self.client.bucket(bucket)
        self.stream_input = stream_input

    def _signed_read_url(self, key: str) -> str:
        import google.auth
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        kwargs: dict = {}
        if not isinstance(creds, service_account.Credentials):
            # Metadata-server credentials: sign through IAM (needs roles/iam.serviceAccountTokenCreator).
            creds.refresh(Request())
            kwargs = {"service_account_email": creds.service_account_email, "access_token": creds.token}
        return self.bucket.blob(key).generate_signed_url(
            version="v4", expiration=dt.timedelta(hours=6), method="GET", **kwargs
        )

    def input_ref(self, key: str, work_dir: Path) -> str:
        if self.stream_input:
            if not self.bucket.blob(_safe_key(key)).exists():
                raise PipelineError("source_missing", f"File not found in storage: {key}")
            return self._signed_read_url(key)
        return str(self.local_file(key, work_dir))

    def local_file(self, key: str, work_dir: Path) -> Path:
        blob = self.bucket.blob(_safe_key(key))
        if not blob.exists():
            raise PipelineError("source_missing", f"File not found in storage: {key}")
        dest = work_dir / f"{abs(hash(key)) % 10**8}-{Path(key).name}"
        blob.download_to_filename(str(dest))
        return dest

    def upload_file(self, path: Path, key: str, content_type: str) -> None:
        self.bucket.blob(_safe_key(key)).upload_from_filename(str(path), content_type=content_type)


_storage: Storage | None = None


def get_storage(settings: Settings | None = None) -> Storage:
    global _storage
    if _storage is None:
        s = settings or get_settings()
        if s.storage_driver == "gcs":
            if not s.gcs_bucket:
                raise RuntimeError("GCS_BUCKET is required when STORAGE_DRIVER=gcs")
            _storage = GcsStorage(s.gcs_bucket, s.gcs_stream_input)
        else:
            _storage = LocalStorage(s.local_storage_dir)
    return _storage
