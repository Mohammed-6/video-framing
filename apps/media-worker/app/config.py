from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgres://clipforge:clipforge@localhost:5432/clipforge"
    # Same 32-byte base64 key as the API; decrypts platform credentials.
    credentials_key: str | None = None

    # Storage
    storage_driver: Literal["local", "gcs"] = "local"
    local_storage_dir: str = "./data/blobs"
    gcs_bucket: str | None = None
    gcs_stream_input: bool = True
    work_dir: str = "/tmp/clipforge"

    # Worker loop
    worker_id: str | None = None
    poll_interval_seconds: float = 2.0
    heartbeat_interval_seconds: float = 20.0
    stale_job_minutes: int = 10
    analysis_concurrency: int = 1
    render_concurrency: int = 2
    publish_concurrency: int = 2
    worker_embedded: bool = False

    # YouTube download (yt-dlp)
    ytdlp_max_height: int = 1080
    # Netscape-format cookies file; needed when YouTube asks "confirm you're not a bot"
    # (common from cloud IPs).
    ytdlp_cookies_file: str | None = None
    max_source_minutes: int = 240

    # Transcription
    transcribe_provider: Literal["faster_whisper", "openai"] = "faster_whisper"
    whisper_model: str = "small"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"

    # Clip planning
    clip_planner: Literal["llm", "heuristic"] = "heuristic"
    openai_api_key: str | None = None
    openai_base_url: str | None = None
    openai_model: str = "gpt-4o-mini"
    azure_openai_endpoint: str | None = None
    azure_openai_api_key: str | None = None
    azure_openai_deployment: str | None = None
    azure_openai_api_version: str = "2024-10-21"
    llm_timeout_seconds: float = 120.0

    # Media
    scene_detection: bool = True
    scene_threshold: float = 0.35
    ffmpeg_threads: int = 0
    render_preset: str = "veryfast"
    render_crf: int = 20
    caption_font: str = "DejaVu Sans"
    # OpenCV YuNet face detector (downloaded into the image); Haar cascade fallback if missing.
    face_model_path: str | None = "/opt/models/face_detection_yunet_2023mar.onnx"

    # Publishing
    # true = simulate posts (no platform calls); handy for testing the whole flow.
    publish_dry_run: bool = False
    google_oauth_client_id: str | None = None
    google_oauth_client_secret: str | None = None
    publish_http_timeout_seconds: float = 120.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
