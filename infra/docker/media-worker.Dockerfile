# Build context: repository root.
FROM python:3.11-slim

# ffmpeg (with libass for caption burn-in) and a font for captions.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
COPY --from=denoland/deno:bin-2.5.6 /deno /usr/local/bin/deno

WORKDIR /app
COPY apps/media-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Face detector for speaker-following reframe (OpenCV Zoo, MIT). Size check guards against
# getting a Git LFS pointer file instead of the model.
ADD https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx /opt/models/face_detection_yunet_2023mar.onnx
RUN chmod 644 /opt/models/*.onnx \
 && python -c "import os,sys; s=os.path.getsize('/opt/models/face_detection_yunet_2023mar.onnx'); print('yunet bytes', s); sys.exit(s < 100000)"

COPY apps/media-worker/app ./app

# Whisper models are downloaded on first use; mount a volume here to cache them.
ENV PYTHONUNBUFFERED=1 HF_HOME=/models WORK_DIR=/tmp/clipforge
RUN useradd --create-home --uid 10001 worker && mkdir -p /models /tmp/clipforge && chown -R worker /models /tmp/clipforge
USER worker

EXPOSE 8080
# Standalone consumer. For Cloud Run use:
#   uvicorn app.main:app --host 0.0.0.0 --port 8080  with WORKER_EMBEDDED=true
CMD ["python", "-m", "app.consumers.runner"]
