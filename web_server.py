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
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from rio_visualizer import api

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
INSTRUCTIONS = ROOT / "instructions.txt"

# Loaded stat files, keyed by an id handed back to the client on upload. In-memory
# only (cleared on restart); fine for the standalone single-user dev server.
_STATS = {}

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

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        return body

    def do_POST(self):
        path = urlparse(self.path).path

        try:
            body = self.read_json_body()
        except Exception as e:
            return self.send_json({"error": f"invalid JSON: {e}"}, 400)

        if path == "/api/simulate":
            if not isinstance(body, dict):
                return self.send_json({"error": "body must be a JSON object"}, 400)
            return self.send_json(api.simulate(body))

        if path == "/api/stat/load":
            # body is the decoded stat-file JSON itself
            if not isinstance(body, dict):
                return self.send_json({"error": "body must be a stat-file JSON object"}, 400)
            try:
                stat = api.parse_stat(body)
                search = api.EventSearch(stat)
            except Exception as e:
                return self.send_json({"error": f"could not parse stat file: {e}"}, 400)
            stat_id = uuid.uuid4().hex
            _STATS[stat_id] = (stat, search)
            return self.send_json({
                "stat_id": stat_id,
                "summary": api.stat_summary(stat),
                "events": api.list_stat_events(stat, search, {}),
            })

        if path == "/api/stat/events":
            entry = _STATS.get(body.get("stat_id"))
            if entry is None:
                return self.send_json({"error": "unknown stat_id (re-upload the file)"}, 404)
            stat, search = entry
            return self.send_json({
                "events": api.list_stat_events(stat, search, body.get("filters") or {}),
            })

        if path == "/api/stat/simulate":
            entry = _STATS.get(body.get("stat_id"))
            if entry is None:
                return self.send_json({"error": "unknown stat_id (re-upload the file)"}, 404)
            stat, _ = entry
            return self.send_json(api.simulate_stat_event(stat, body.get("event_num")))

        if path == "/api/stat/simulate_all":
            entry = _STATS.get(body.get("stat_id"))
            if entry is None:
                return self.send_json({"error": "unknown stat_id (re-upload the file)"}, 404)
            stat, search = entry
            return self.send_json(api.simulate_stat_events(stat, search, body.get("filters") or {}))

        return self.send_json({"error": "not found"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5261
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"RioVisualizer running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
