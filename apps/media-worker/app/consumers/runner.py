"""Worker process: polls both queues with bounded concurrency and recovers stale jobs.

Run standalone with `python -m app.consumers.runner`, or embedded in the FastAPI
app (WORKER_EMBEDDED=true) for single-container deployments such as Cloud Run.
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import traceback

from ..config import Settings, get_settings
from ..errors import JobCancelled, PipelineError
from ..storage import Storage, get_storage
from . import jobqueue
from .analysis import process_analysis
from .publish import process_publish
from .render import process_render

log = logging.getLogger(__name__)


class Worker:
    def __init__(self, settings: Settings | None = None, storage: Storage | None = None):
        self.settings = settings or get_settings()
        self.storage = storage or get_storage(self.settings)
        self.worker_id = self.settings.worker_id or f"{socket.gethostname()}-{os.getpid()}"
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.busy = 0
        self._busy_lock = threading.Lock()

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        plan = [
            ("analysis", self.settings.analysis_concurrency),
            ("render", self.settings.render_concurrency),
            ("publish", self.settings.publish_concurrency),
        ]
        for kind, n in plan:
            for i in range(n):
                t = threading.Thread(target=self._loop, args=(kind,), name=f"{kind}-{i}", daemon=True)
                t.start()
                self._threads.append(t)
        m = threading.Thread(target=self._maintenance, name="maintenance", daemon=True)
        m.start()
        self._threads.append(m)
        log.info("worker %s started: %s", self.worker_id, plan)

    def stop(self, timeout: float = 30) -> None:
        """Stop claiming new jobs; in-flight jobs get `timeout` seconds, then are recovered by heartbeat expiry."""
        self._stop.set()
        for t in self._threads:
            t.join(timeout=timeout / max(1, len(self._threads)))

    def wait(self) -> None:
        while not self._stop.wait(1.0):
            pass

    # -- loops ---------------------------------------------------------------

    def _maintenance(self) -> None:
        """Stale-job recovery at start-up (jobs left over from a crash or shutdown) and every minute."""
        while True:
            try:
                jobqueue.recover_stale(self.settings.stale_job_minutes)
            except Exception:
                log.exception("stale-job recovery failed")
            if self._stop.wait(60):
                return

    def _loop(self, kind: jobqueue.Kind) -> None:
        while not self._stop.is_set():
            try:
                job = jobqueue.claim(kind, self.worker_id)
            except Exception:
                log.exception("claim failed (%s)", kind)
                self._stop.wait(5)
                continue
            if not job:
                self._stop.wait(self.settings.poll_interval_seconds)
                continue
            self._handle(kind, job)

    def _handle(self, kind: jobqueue.Kind, job: dict) -> None:
        job_id = str(job["id"])
        log.info("claimed %s job %s (attempt %s)", kind, job_id, job["attempts"])
        with self._busy_lock:
            self.busy += 1
        try:
            if kind == "analysis":
                process_analysis(job, self.settings, self.storage)
            elif kind == "render":
                process_render(job, self.settings, self.storage)
            else:
                process_publish(job, self.settings, self.storage)
            log.info("%s job %s done", kind, job_id)
        except JobCancelled:
            log.info("%s job %s cancelled", kind, job_id)
        except PipelineError as e:
            retry = jobqueue.fail(kind, job, e.code, e.message, e.retryable)
            log.warning("%s job %s failed: %s (%s) retry=%s", kind, job_id, e.code, e.message, retry)
        except Exception as e:
            log.error("%s job %s crashed:\n%s", kind, job_id, traceback.format_exc())
            # Unexpected errors are retried, except publishing, where a retry could double-post.
            jobqueue.fail(kind, job, "internal_error", f"Unexpected error: {e}", retryable=kind != "publish")
        finally:
            with self._busy_lock:
                self.busy -= 1


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    worker = Worker()
    worker.start()

    def on_signal(signum, _frame):
        log.info("signal %s: shutting down", signum)
        worker._stop.set()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    worker.wait()
    worker.stop()


if __name__ == "__main__":
    main()
