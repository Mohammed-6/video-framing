"""Resolve the brand kit in app settings to blob keys (mirror of resolveBrandKit in the API)."""

from __future__ import annotations

from ..db import connect


def resolve_brand_kit(kit: dict, include: dict | None = None) -> dict:
    include = include or {}
    ids = {k: kit.get(f"{k}AssetId") for k in ("intro", "outro", "music", "logo")}
    wanted = [v for k, v in ids.items() if v and include.get(k, True) is not False]
    rows: dict[str, dict] = {}
    if wanted:
        with connect() as conn:
            for r in conn.execute(
                "SELECT id::text, kind, blob_key FROM brand_assets WHERE id::text = ANY(%s) AND status = 'ready'", (wanted,)
            ).fetchall():
                rows[r["id"]] = r

    def key(kind: str) -> str | None:
        r = rows.get(ids[kind] or "")
        return r["blob_key"] if r and r["kind"] == kind and include.get(kind, True) is not False else None

    intro, outro, music, logo = key("intro"), key("outro"), key("music"), key("logo")
    return {
        "intro": {"blobKey": intro} if intro else None,
        "outro": {"blobKey": outro} if outro else None,
        "music": {"blobKey": music, "volume": kit.get("musicVolume", 0.15), "duck": kit.get("duckMusic", True)}
        if music else None,
        "logo": {
            "blobKey": logo,
            "position": kit.get("logoPosition", "top-left"),
            "scale": kit.get("logoScale", 0.18),
            "opacity": kit.get("logoOpacity", 0.9),
        }
        if logo else None,
    }
