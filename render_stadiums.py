#!/usr/bin/env python3
"""Render fixed-camera stills of every stadium from the web visualizer's scene.

    python3 web_server.py              # in another terminal
    python3 render_stadiums.py         # every park
    python3 render_stadiums.py "Mario Stadium" "Toy Field"

Writes web/renders/<stem>.webp (the park), <stem>-glow.png (its light-emitting
parts, for pulsing over the still) and manifest.json (image size plus the
projection matrix that maps stadium coordinates onto the picture). Re-run it
whenever web/stadium.js, web/renderer.js or web/themes.js changes. ProjectRio-frontend uses the
same stills for its draft-room lineup field.

Headless Google Chrome renders web/render.html; it does not always exit after
--dump-dom, so we stop it ourselves once the page has been printed.

Env: RENDER_BASE (default http://127.0.0.1:5261), CHROME (path to the binary).
"""

import base64
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from rio_visualizer import api

ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT / "web" / "renders"
BASE = os.environ.get("RENDER_BASE", "http://127.0.0.1:5261")
CHROME = os.environ.get("CHROME") or {
    "darwin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "win32": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
}.get(sys.platform, "google-chrome")
WIDTH, HEIGHT = 1400, 1050


def stem(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()


def dump_dom(url: str, timeout: float = 180.0) -> str:
    """Load the render page in headless Chrome and return the DOM once printed."""
    with tempfile.TemporaryDirectory(prefix="rio-render-") as profile:
        args = [
            CHROME,
            "--headless=new",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            f"--user-data-dir={profile}",
            f"--window-size={WIDTH + 40},{HEIGHT + 80}",
            "--virtual-time-budget=60000",
            "--dump-dom",
            url,
        ]
        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        out = bytearray()
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                chunk = os.read(proc.stdout.fileno(), 1 << 16) if proc.poll() is None else proc.stdout.read()
                if chunk:
                    out += chunk
                if b"</html>" in out or proc.poll() is not None:
                    break
        finally:
            proc.kill()
            proc.wait()
        text = out.decode("utf-8", "replace")
        if "</html>" not in text:
            raise RuntimeError("timed out waiting for the render")
        return text


def render_one(name: str) -> dict:
    url = f"{BASE}/render.html?stadium={quote(name)}"
    page = dump_dom(url)
    match = re.search(r'<pre id="rio-render"[^>]*>([\s\S]*?)</pre>', page)
    if not match:
        status = re.search(r'<p id="status">([^<]*)</p>', page)
        raise RuntimeError(f"no render output ({status.group(1) if status else 'no status'})")
    result = json.loads(html.unescape(match.group(1)).strip())

    def decode(data_url: str) -> bytes:
        return base64.b64decode(data_url.split(",", 1)[1])

    base = stem(name)
    (OUT_DIR / f"{base}.webp").write_bytes(decode(result["scene"]))
    (OUT_DIR / f"{base}-glow.png").write_bytes(decode(result["glow"]))
    return {
        "width": result["width"],
        "height": result["height"],
        "matrix": result["matrix"],
        "scene": f"{base}.webp",
        "glow": f"{base}-glow.png",
    }


def main() -> int:
    names = sys.argv[1:] or api.list_stadiums()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT_DIR / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {"version": 1, "stadiums": {}}

    failed = False
    for name in names:
        started = time.monotonic()
        print(f"{name}… ", end="", flush=True)
        try:
            manifest["stadiums"][name] = render_one(name)
            manifest["rendered_at"] = datetime.now(timezone.utc).isoformat()
            manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
            print(f"done in {time.monotonic() - started:.1f}s")
        except Exception as exc:  # noqa: BLE001 — report and keep going
            failed = True
            print(f"FAILED — {exc}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
