from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

from .config import get_settings


@contextmanager
def connect(autocommit: bool = True) -> Iterator[psycopg.Connection]:
    """Short-lived connection. Jobs run for minutes, so we never hold a transaction open across stages."""
    conn = psycopg.connect(get_settings().database_url, autocommit=autocommit, row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()
