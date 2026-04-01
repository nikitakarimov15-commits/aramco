"""
Download all assets referenced by the built SPA bundle from aramcoinvest.net.

This is a pragmatic recovery since we don't have source code. It pulls the
missing Vite chunks/images so the SPA can run under our domain.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import requests

BASE = "https://aramcoinvest.net/"
ROOT = Path(__file__).resolve().parents[1]
BUNDLE = ROOT / "assets" / "index-8920794d.js"
OUT_DIR = ROOT / "assets"


def extract_asset_paths(bundle_text: str) -> list[str]:
    import re

    # capture both "/assets/.." and "assets/.."
    pat = re.compile(r"(?:/|\./)?assets/[A-Za-z0-9._-]+\.(?:js|css|png|jpg|jpeg|svg|woff2?|ttf|webp)")
    return sorted(set(pat.findall(bundle_text)))


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    s = BUNDLE.read_text(encoding="utf-8", errors="ignore")
    paths = extract_asset_paths(s)
    if not paths:
        print("No asset paths found in bundle.", file=sys.stderr)
        return 2

    sess = requests.Session()
    ok_count = 0
    skip_count = 0
    fail: list[str] = []

    for i, p in enumerate(paths, 1):
        # normalize to "assets/..."
        rel = p[1:] if p.startswith("/") else p
        dest = OUT_DIR / rel.split("/", 1)[1]  # drop leading "assets/"
        if dest.exists() and dest.stat().st_size > 0:
            skip_count += 1
            continue

        url = urljoin(BASE, rel)
        try:
            r = sess.get(url, timeout=30)
            if r.status_code != 200 or not r.content:
                fail.append(f"{p} -> {r.status_code}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(r.content)
            ok_count += 1
        except Exception as e:
            fail.append(f"{p} -> {e}")

        if i % 25 == 0:
            time.sleep(0.3)

    print(f"Downloaded: {ok_count}, skipped: {skip_count}, failed: {len(fail)}")
    if fail:
        (ROOT / "scripts" / "sync_assets_failures.txt").write_text("\\n".join(fail), encoding="utf-8")
        print("Failures written to scripts/sync_assets_failures.txt", file=sys.stderr)
        # don't hard-fail; many assets might be optional
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

