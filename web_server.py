"""Standalone dev server for the RioVisualizer web front end.

Serves the Three.js front end in web/ and exposes the batting calculation
(``rio_visualizer.api``) over a small JSON API. Standard library only, so it
runs anywhere Python does (including macOS) with no installs:

    python3 web_server.py [port]

In PRSH the same surface is reached by importing ``rio_visualizer.api``
directly; this server exists for standalone/debug use.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from rio_visualizer import api

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
INSTRUCTIONS = ROOT / "instructions.txt"

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def send_payload(self, body, content_type, status=200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        self.send_payload(json.dumps(obj), "application/json; charset=utf-8", status)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)

        if path == "/":
            path = "/index.html"

        if path == "/api/characters":
            return self.send_json({"characters": api.list_characters()})

        if path == "/api/stadiums":
            return self.send_json({"stadiums": api.list_stadiums(), "default": api.DEFAULT_STADIUM})

        if path.startswith("/api/stadium/"):
            name = path[len("/api/stadium/"):]
            sp = api.stadium_path(name)
            if sp is None:
                return self.send_json({"error": "unknown stadium"}, 404)
            return self.send_payload(sp.read_text(), "application/json; charset=utf-8")

        if path == "/api/instructions":
            return self.send_payload(INSTRUCTIONS.read_text(), "text/plain; charset=utf-8")

        # static files from web/
        target = (WEB_DIR / path.lstrip("/")).resolve()
        if WEB_DIR in target.parents and target.is_file():
            ctype = STATIC_TYPES.get(target.suffix, "application/octet-stream")
            return self.send_payload(target.read_bytes(), ctype)

        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/api/simulate":
            return self.send_json({"error": "not found"}, 404)

        length = int(self.headers.get("Content-Length", 0))
        try:
            batting_json = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(batting_json, dict):
                raise ValueError("body must be a JSON object")
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)

        self.send_json(api.simulate(batting_json))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5261
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"RioVisualizer running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
