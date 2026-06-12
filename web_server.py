"""Web version of the batting visualizer.

Serves the Three.js front end in web/ and exposes the existing Python
batting calculation over a small JSON API. Uses only the standard library,
so it runs anywhere Python does (including macOS) with no installs:

    python3 web_server.py [port]

The same handlers translate directly into FastAPI routes for PRSH.
"""
import copy
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from random import randint
from urllib.parse import unquote, urlparse

import utils.get_data
from src.calc import calc_batting
from data.constants import (
    CHARACTERNAME_TO_ID,
    FIELDER_DIVE_RANGE,
    FIELDER_JOGGING_SPEED,
    FIELDER_LOCKOUT_BYPOSITION,
    FIELDER_SLIDINGCATCH_ABILITY,
    FIELDER_STARTING_COORDINATES,
)

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
STADIUM_DIR = ROOT / "data" / "stadiums"

POSITION_NAMES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]

DEFAULT_RANDS = {"rand_1": 1565, "rand_2": 20008, "rand_3": 1628}


def path_to_points(path):
    return [[p["X"], p["Y"], p["Z"]] for p in path]


def compute_paths(batting_json, out):
    count = 1 if "override_vertical_range" in batting_json else 5

    for i in range(count):
        kwargs = copy.deepcopy(batting_json)
        if batting_json.get("show_one_hit", False) != True:
            kwargs.setdefault("override_vertical_range", i)
        for k, v in DEFAULT_RANDS.items():
            kwargs.setdefault(k, v)

        try:
            res = calc_batting.hit_ball(**kwargs)
        except Exception as e:
            out["errors"].append(f"vertical range {i}: {e!r}")
            continue

        points = path_to_points(res["FlightDetails"]["Path"])
        if len(points) == 0:
            continue

        out["paths"].append({
            "points": points,
            "final": points[-1],
            "max_height_point": max(points, key=lambda p: p[1]),
            "vertical_range": kwargs.get("override_vertical_range"),
        })

        if out["details"] is None:
            details = dict(res)
            details["FlightDetails"] = {
                k: v for k, v in res["FlightDetails"].items() if k != "Path"
            }
            out["details"] = details


def compute_random_hits(batting_json, out):
    n = batting_json.get("generate_random_hits", 0)
    if not isinstance(n, int) or n <= 0:
        return

    seen = set()
    for _ in range(n):
        kwargs = copy.deepcopy(batting_json)
        kwargs.setdefault("rand_1", randint(0, (2**15) - 1))
        kwargs.setdefault("rand_2", randint(0, (2**15) - 1))
        kwargs.setdefault("rand_3", randint(0, (2**15) - 1))

        try:
            path = calc_batting.hit_ball(**kwargs)["FlightDetails"]["Path"]
        except Exception:
            continue

        if len(path) == 0:
            continue
        final = (path[-1]["X"], path[-1]["Y"], path[-1]["Z"])
        if final not in seen:
            seen.add(final)
            out["random_points"].append(list(final))


def compute_batter(batting_json, out):
    batter_x = batting_json.get("batter_x", 0)
    handedness = batting_json.get("handedness", 0)
    batter_id = batting_json.get("batter_id", 0)

    hbox_batter = utils.get_data.get_hitbox(batter_id)

    batter_width = hbox_batter[0] / 100
    batter_hitbox_near = hbox_batter[1] / 100
    batter_hitbox_far = hbox_batter[2] / -100

    batter_offset_x = calc_batting.BATTER_HITBOXES[batter_id]["EasyBattingSpotHorizontal"]
    batter_offset_z = calc_batting.BATTER_HITBOXES[batter_id]["EasyBattingSpotVertical"]

    if handedness == 1:
        batter_x *= -1
        batter_offset_x *= -1
        batter_hitbox_near *= -1
        batter_hitbox_far *= -1

    height = 2
    slight_offset = 0.001

    # draw_cube semantics: box centered at position + offset, dims = |scale|
    boxes = []
    for p in [batter_hitbox_near, batter_hitbox_far]:
        boxes.append({
            "center": [
                batter_x + batter_offset_x + p / 2,
                slight_offset + height / 2,
                batter_offset_z + batter_width / 2,
            ],
            "size": [abs(p), height, abs(batter_width)],
        })

    bat_boxes = []
    for p in utils.get_data.get_bat_hitbox(batter_id, 0, handedness):
        bat_boxes.append({
            "center": [batter_x + p / 2, 1, 0],
            "size": [abs(p), 0.1, 0.1],
        })

    out["batter"] = {
        "name": utils.get_data.get_name(batter_id),
        "boxes": boxes,
        "bat_boxes": bat_boxes,
        "label_pos": [batter_x + batter_offset_x, slight_offset, batter_offset_z],
    }


def compute_fielders(batting_json, out):
    positions = batting_json.get("choose_fielder", None)
    if positions is None:
        return
    if isinstance(positions, int):
        positions = [positions]

    fielder_id = batting_json.get("fielder_id", 0)
    dive_type = batting_json.get("dive_type", "popfly")
    ball_hangtime = batting_json.get("hangtime", 100)

    for fielder_pos in positions:
        try:
            coords = FIELDER_STARTING_COORDINATES[fielder_pos]

            sliding_catch_mult = 1 if FIELDER_SLIDINGCATCH_ABILITY[fielder_id] == 0 else 1.2
            dive_frame_upper = 45 if FIELDER_SLIDINGCATCH_ABILITY[fielder_id] == 0 else 60

            jogging_speed = FIELDER_JOGGING_SPEED[fielder_id]
            sprint_mult = 1.4
            dive_range = FIELDER_DIVE_RANGE[fielder_id]

            fielder_control_frames = max(ball_hangtime - FIELDER_LOCKOUT_BYPOSITION[fielder_pos], 0)

            running_distance = fielder_control_frames * jogging_speed * sprint_mult
            dive_max_distance = (
                max(fielder_control_frames - dive_frame_upper, 0) * jogging_speed * sprint_mult
                + dive_range
                + min(fielder_control_frames, dive_frame_upper) * jogging_speed * sprint_mult * sliding_catch_mult
            )

            if dive_type == "popfly" or fielder_pos > 5:
                line_height = 0.01
            elif dive_type == "linedrive":
                line_height = 2.78 if fielder_id == 2 else 2.5

            out["fielders"].append({
                "position": fielder_pos,
                "position_name": POSITION_NAMES[fielder_pos],
                "name": utils.get_data.get_name(fielder_id),
                "coords": [coords[0], 0.5, coords[1]],
                "running_radius": running_distance / 2,
                "dive_radius": dive_max_distance / 2,
                "line_height": line_height,
            })
        except Exception as e:
            out["errors"].append(f"fielder {fielder_pos}: {e!r}")


def simulate(batting_json):
    out = {
        "paths": [],
        "random_points": [],
        "fielders": [],
        "batter": None,
        "details": None,
        "errors": [],
    }
    compute_paths(batting_json, out)
    compute_random_hits(batting_json, out)
    try:
        compute_batter(batting_json, out)
    except Exception as e:
        out["errors"].append(f"batter: {e!r}")
    compute_fielders(batting_json, out)
    return out


def list_stadiums():
    return sorted(p.stem for p in STADIUM_DIR.glob("*.json"))


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
            return self.send_json({"characters": sorted(
                ({"id": cid, "name": name}
                 for name, cid in CHARACTERNAME_TO_ID.items()
                 if isinstance(cid, int) and isinstance(name, str)),
                key=lambda c: c["id"],
            )})

        if path == "/api/stadiums":
            return self.send_json({"stadiums": list_stadiums(), "default": "Mario Stadium"})

        if path.startswith("/api/stadium/"):
            name = path[len("/api/stadium/"):]
            if name not in list_stadiums():
                return self.send_json({"error": "unknown stadium"}, 404)
            return self.send_payload(
                (STADIUM_DIR / f"{name}.json").read_text(), "application/json; charset=utf-8")

        if path == "/api/instructions":
            return self.send_payload((ROOT / "instructions.txt").read_text(), "text/plain; charset=utf-8")

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

        self.send_json(simulate(batting_json))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5261
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Batting visualizer running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
