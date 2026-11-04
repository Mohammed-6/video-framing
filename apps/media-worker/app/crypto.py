"""Decrypt platform credentials written by the API (apps/api/src/crypto.ts).

Format: "v1:" + base64(iv[12] | ciphertext | tag[16]), AES-256-GCM, JSON payload.
"""

from __future__ import annotations

import base64
import json
import os

from .errors import PipelineError


def _key(b64_key: str | None) -> bytes:
    if not b64_key:
        raise PipelineError("credentials_key_missing", "CREDENTIALS_KEY is not configured on the worker")
    key = base64.b64decode(b64_key)
    if len(key) != 32:
        raise PipelineError("credentials_key_invalid", "CREDENTIALS_KEY must be 32 bytes (base64)")
    return key


def decrypt_credentials(value: str | None, b64_key: str | None) -> dict[str, str]:
    if not value:
        return {}
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not value.startswith("v1:"):
        raise PipelineError("credentials_invalid", "Unknown credentials format")
    raw = base64.b64decode(value[3:])
    iv, ct_and_tag = raw[:12], raw[12:]
    try:
        plain = AESGCM(_key(b64_key)).decrypt(iv, ct_and_tag, None)
    except PipelineError:
        raise
    except Exception as exc:
        raise PipelineError("credentials_invalid", "Could not decrypt platform credentials (wrong CREDENTIALS_KEY?)") from exc
    return json.loads(plain)


def encrypt_credentials(data: dict[str, str], b64_key: str | None) -> str:
    """Used by tests (and available if the worker ever needs to rotate tokens)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    ct = AESGCM(_key(b64_key)).encrypt(iv, json.dumps(data).encode(), None)
    return "v1:" + base64.b64encode(iv + ct).decode()
