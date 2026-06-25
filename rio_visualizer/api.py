"""Importable simulation surface for RioVisualizer.

Wraps the pure-Python batting calculation (``rio_visualizer.calc``) in the
``simulate()`` contract that the Three.js front end speaks, plus stadium and
character helpers. Standard-library only — no pygame, no network. Both the
standalone ``web_server.py`` and PRSH import from here.

Paths are package-relative (resolved from this file), so importing works
regardless of the current working directory.
"""
import copy
import json
from pathlib import Path
from random import randint

from rio_visualizer.utils import get_data
from rio_visualizer.calc import calc_batting
from rio_visualizer.data.constants import (
    CHARACTERNAME_TO_ID,
    FIELDER_DIVE_RANGE,
    FIELDER_JOGGING_SPEED,
    FIELDER_LOCKOUT_BYPOSITION,
    FIELDER_SLIDINGCATCH_ABILITY,
    FIELDER_STARTING_COORDINATES,
)

DATA_DIR = Path(__file__).resolve().parent / "data"
STADIUM_DIR = DATA_DIR / "stadiums"

POSITION_NAMES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]

DEFAULT_RANDS = {"rand_1": 1565, "rand_2": 20008, "rand_3": 1628}
DEFAULT_STADIUM = "Mario Stadium"


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

    hbox_batter = get_data.get_hitbox(batter_id)

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
    for p in get_data.get_bat_hitbox(batter_id, 0, handedness):
        bat_boxes.append({
            "center": [batter_x + p / 2, 1, 0],
            "size": [abs(p), 0.1, 0.1],
        })

    out["batter"] = {
        "name": get_data.get_name(batter_id),
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
                "name": get_data.get_name(fielder_id),
                "coords": [coords[0], 0.5, coords[1]],
                "running_radius": running_distance / 2,
                "dive_radius": dive_max_distance / 2,
                "line_height": line_height,
            })
        except Exception as e:
            out["errors"].append(f"fielder {fielder_pos}: {e!r}")


def simulate(batting_json):
    """Run the batting calc for one request body and return the front-end contract.

    Returns ``{paths, random_points, fielders, batter, details, errors}``.
    Never raises for per-component failures — they are collected in ``errors``.
    """
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


def stadium_path(name):
    """Return the Path to a stadium JSON, or None if the name is unknown."""
    if name not in list_stadiums():
        return None
    return STADIUM_DIR / f"{name}.json"


def load_stadium(name):
    """Return a stadium's parsed JSON, or None if the name is unknown."""
    p = stadium_path(name)
    return json.loads(p.read_text()) if p else None


def list_characters():
    return sorted(
        ({"id": cid, "name": name}
         for name, cid in CHARACTERNAME_TO_ID.items()
         if isinstance(cid, int) and isinstance(name, str)),
        key=lambda c: c["id"],
    )
