from __future__ import annotations


class PipelineError(Exception):
    """A failure with a stable machine-readable code surfaced to the user via the job row."""

    def __init__(self, code: str, message: str, *, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class JobCancelled(Exception):
    """Raised when the job row was cancelled while the worker was processing it."""
