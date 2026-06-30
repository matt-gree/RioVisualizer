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
from rio_visualizer.data.constants import (
    BATTER_HITBOXES,
    BUNT,
    CHARACTERNAME_TO_ID,
    FIELDER_DIVE_RANGE,
    FIELDER_JOGGING_SPEED,
    FIELDER_LOCKOUT_BYPOSITION,
    FIELDER_SLIDINGCATCH_ABILITY,
    FIELDER_STARTING_COORDINATES,
)
from pyRio.hit_simulator.hit_simulation import (
    BatterAttributes,
    HitInputs,
    HitOverrides,
    simulate_hit,
)
from pyRio.hit_simulator import hit_simulation as hit_sim
from pyRio.stat_file_parser import StatObj, EventObj, EventSearch

try:
    from pyRio import rio_tags
except Exception:  # pragma: no cover - rio_tags is optional
    rio_tags = None

DATA_DIR = Path(__file__).resolve().parent / "data"
STADIUM_DIR = DATA_DIR / "stadiums"

POSITION_NAMES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]

DEFAULT_RANDS = {"rand_1": 1565, "rand_2": 20008, "rand_3": 1628}
DEFAULT_STADIUM = "Mario Stadium"


# ------------------------------------------------------------------ pyRio glue
# The front end speaks the legacy kwarg schema (numeric char ids, hit_type,
# num_stars, override_*). These helpers translate that into pyRio's HitInputs /
# HitOverrides, run simulate_hit, and translate the HitResult back.

def _resolve_star(is_star_hit, swing, num_stars, charge_up, is_captain,
                  captain_star_hit_pitch, non_captain_star_swing):
    """Reduce the visualizer's (num_stars, is_batter_captain) controls to pyRio's
    is_star / five_star_dinger booleans, mirroring the pre-pipeline star
    resolution the old calc_batting.calculateValues did. pyRio's own
    _resolve_star_swing then performs the captain/non-captain split from the
    character's attributes. Returns (is_star, five_star_dinger)."""
    if not is_star_hit or swing == BUNT or num_stars == 0:
        return False, False
    # Fully-charged 5-star swing -> Moonshot (the connected 5-star dinger).
    if charge_up == 1.0 and num_stars >= 5:
        return True, True
    if captain_star_hit_pitch == 0:
        # Non-captain character: only a real non-captain star swing qualifies.
        if non_captain_star_swing == 0:
            return False, False
        return True, False
    if is_captain:
        return num_stars >= 1, False
    # Captain-class character not set as this lineup's captain needs 2+ stars.
    return num_stars >= 2, False


def build_hit_inputs(**kwargs):
    """Build a pyRio HitInputs from the legacy front-end kwargs. Unknown keys
    (display toggles, fielder options, etc.) are ignored."""
    batter_id = kwargs.get("batter_id", 0)
    swing = kwargs.get("hit_type", 0)
    charge_up = kwargs.get("charge_up", 0.0)

    attrs = BatterAttributes.from_name(batter_id)
    is_star, five_star_dinger = _resolve_star(
        kwargs.get("is_star_hit", False),
        swing,
        kwargs.get("num_stars", 4),
        charge_up,
        kwargs.get("is_batter_captain", False),
        attrs.captain_star_hit_pitch,
        attrs.non_captain_star_swing,
    )

    starred = kwargs.get("is_starred", False)
    overrides = HitOverrides(
        vertical_zone=kwargs.get("override_vertical_range"),
        vertical_angle=kwargs.get("override_vertical_angle"),
        horizontal_angle=kwargs.get("override_horizontal_angle"),
        power=kwargs.get("override_power"),
    )

    rng = {}
    if kwargs.get("rand_1") is not None:
        rng["rng1"] = kwargs["rand_1"]
    if kwargs.get("rand_2") is not None:
        rng["rng2"] = kwargs["rand_2"]
    if kwargs.get("rand_3") is not None:
        rng["rng3"] = kwargs["rand_3"]

    return HitInputs(
        batter_name=batter_id,
        pitcher_name=kwargs.get("pitcher_id", 0),
        pitch_type_val=kwargs.get("pitch_type", 0),
        pos_x=kwargs.get("batter_x", 0.0),
        ball_x=kwargs.get("ball_x", 0.0),
        ball_z=kwargs.get("ball_z", 0.0),
        batter_hand=kwargs.get("handedness", 0),
        swing=swing,
        is_star=is_star,
        five_star_dinger=five_star_dinger,
        charge_up=charge_up,
        charge_down=kwargs.get("charge_down", 0.0),
        chem_links=kwargs.get("chem", 0),
        frame=kwargs.get("frame", 2),
        input_up=kwargs.get("stick_up", False),
        input_down=kwargs.get("stick_down", False),
        input_left=kwargs.get("stick_left", False),
        input_right=kwargs.get("stick_right", False),
        easy_batting=kwargs.get("easy_batting", False),
        batter_stars_on=starred,
        pitcher_stars_on=starred,
        overrides=overrides,
        **rng,
    )


def simulate_kwargs(**kwargs):
    """Run the pyRio hit simulation for one set of legacy front-end kwargs.
    Raises ValueError if the inputs would not make contact."""
    return simulate_hit(build_hit_inputs(**kwargs))


def trajectory_points(result):
    """HitResult trajectory ((x, y, z) tuples) -> [[x, y, z], ...]."""
    return [[p[0], p[1], p[2]] for p in result.trajectory]


def hit_details(result):
    """Flatten a HitResult into a JSON-serializable dict for the details panel."""
    return {
        "Contact": {
            "Zone": result.contact_type_name,
            "Quality": result.contact_quality,
            "Absolute": result.contact_absolute,
        },
        "Ball": {
            "HorizontalAngle": result.horizontal_angle,
            "VerticalAngle": result.vertical_angle,
            "HorizontalAngleDeg": result.horizontal_angle_deg,
            "VerticalAngleDeg": result.vertical_angle_deg,
            "Power": result.power,
            "Velocity": list(result.velocity),
            "Acceleration": list(result.acceleration),
            "BallEnergy": result.ball_energy,
        },
        "Flight": {
            "Frames": result.hang_frames,
            "Landing": list(result.landing),
            "Distance": result.distance,
        },
    }


def compute_paths(batting_json, out):
    count = 1 if "override_vertical_range" in batting_json else 5

    for i in range(count):
        kwargs = copy.deepcopy(batting_json)
        if batting_json.get("show_one_hit", False) != True:
            kwargs.setdefault("override_vertical_range", i)
        for k, v in DEFAULT_RANDS.items():
            kwargs.setdefault(k, v)

        try:
            result = simulate_kwargs(**kwargs)
        except Exception as e:
            out["errors"].append(f"vertical range {i}: {e!r}")
            continue

        points = trajectory_points(result)
        if len(points) == 0:
            continue

        out["paths"].append({
            "points": points,
            "final": points[-1],
            "max_height_point": max(points, key=lambda p: p[1]),
            "vertical_range": kwargs.get("override_vertical_range"),
        })

        if out["details"] is None:
            out["details"] = hit_details(result)


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
            points = trajectory_points(simulate_kwargs(**kwargs))
        except Exception:
            continue

        if len(points) == 0:
            continue
        final = tuple(points[-1])
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

    batter_offset_x = BATTER_HITBOXES[batter_id]["EasyBattingSpotHorizontal"]
    batter_offset_z = BATTER_HITBOXES[batter_id]["EasyBattingSpotVertical"]

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


# ------------------------------------------------------------- stat-file events
# Load a decoded Rio stat file, list its (filterable) contact events, and replay
# a chosen one through the same engine. Replays use the event's recorded
# RNG/charge/contact, so they reproduce the actual hit rather than a what-if.

# Result-category filters -> EventSearch event-number sets. "hit" is any hit;
# the base-count variants come from hitResultEvents(n).
_RESULT_FILTERS = {
    "hit": lambda es: es.hitResultEvents(0),
    "single": lambda es: es.hitResultEvents(1),
    "double": lambda es: es.hitResultEvents(2),
    "triple": lambda es: es.hitResultEvents(3),
    "homerun": lambda es: es.hitResultEvents(4),
    "out": lambda es: es.outResultEvents(),
    "caught": lambda es: es.caughtResultEvents() | es.caughtLineDriveResultsEvents(),
    "five_star_dinger": lambda es: es.fiveStarDingerEvents(),
    "star_pitch": lambda es: es.starPitchEvents(),
}

# Swing types the engine can replay (bunts / no-swing are unsupported).
_SIMULATABLE_SWINGS = {"Slap", "Charge", "Star"}


def parse_stat(stat_json):
    """Build a StatObj from a decoded stat-file dict."""
    return StatObj(stat_json)


def _active_tags(stat):
    if rio_tags is None:
        return frozenset()
    try:
        return rio_tags.active_tags_for_stat(stat)
    except Exception:
        return frozenset()


def _half_label(half):
    return "Top" if half == 0 else "Bot"


def stat_summary(stat):
    """Game-level metadata plus the option lists a filter UI needs."""
    batters = {}
    for i in range(len(stat.events())):
        ev = EventObj(stat, i)
        if ev.contact_dict():
            batters.setdefault(ev.batter(), 0)
            batters[ev.batter()] += 1
    stadium = stat.stadium()
    return {
        "stadium": stadium if stadium in list_stadiums() else None,
        "stadium_raw": stadium,
        "away": stat.player(0),
        "home": stat.player(1),
        "score": [stat.score(0), stat.score(1)],
        "innings": stat.inningsPlayed(),
        "batters": sorted(batters),
        "result_filters": list(_RESULT_FILTERS),
    }


def list_stat_events(stat, search, filters=None):
    """Contact events (newest engine-replayable ones) matching ``filters``.

    ``filters`` keys (all optional): result (one of _RESULT_FILTERS), inning
    (int), half (0/1), batter (name). Returns lightweight summaries; no
    simulation is run here."""
    filters = filters or {}

    candidates = None  # None = all events

    def _restrict(s):
        nonlocal candidates
        candidates = s if candidates is None else (candidates & s)

    result = filters.get("result")
    if result and result in _RESULT_FILTERS:
        _restrict(_RESULT_FILTERS[result](search))

    inning = filters.get("inning")
    if inning:
        _restrict(search.inningEvents(int(inning)))

    nums = sorted(candidates) if candidates is not None else range(len(stat.events()))

    half = filters.get("half")
    batter = filters.get("batter")

    events = []
    for n in nums:
        ev = EventObj(stat, n)
        if not ev.contact_dict():
            continue
        if ev.pitch_dict().get("Type of Swing") not in _SIMULATABLE_SWINGS:
            continue
        if half is not None and ev.half_inning() != int(half):
            continue
        if batter and ev.batter() != batter:
            continue
        events.append({
            "event_num": ev.event_num(),
            "inning": ev.inning(),
            "half": _half_label(ev.half_inning()),
            "batter": ev.batter(),
            "pitcher": ev.pitcher(),
            "result": ev.result_of_AB(),
            "rbi": ev.rbi(),
            "swing": ev.pitch_dict().get("Type of Swing"),
        })
    return events


def simulate_stat_event(stat, event_num):
    """Replay one stat-file event through the engine, returned in the same shape
    as ``simulate()`` so the renderer can draw it unchanged."""
    out = {
        "paths": [],
        "random_points": [],
        "fielders": [],
        "batter": None,
        "details": None,
        "errors": [],
        "stadium": None,
        "meta": None,
    }
    ev = EventObj(stat, int(event_num))
    stadium = stat.stadium()
    out["stadium"] = stadium if stadium in list_stadiums() else None

    try:
        inp = hit_sim._inputs_from_event(ev, _active_tags(stat))
        result = simulate_hit(inp)
    except Exception as e:
        out["errors"].append(f"event {event_num}: {e!r}")
        return out

    points = trajectory_points(result)
    if points:
        out["paths"].append({
            "points": points,
            "final": points[-1],
            "max_height_point": max(points, key=lambda p: p[1]),
            "vertical_range": None,
        })
    out["details"] = hit_details(result)

    batter_id = CHARACTERNAME_TO_ID.get(ev.batter())
    if batter_id is not None:
        try:
            compute_batter(
                {"batter_x": inp.pos_x, "handedness": inp.batter_hand, "batter_id": batter_id},
                out,
            )
        except Exception as e:
            out["errors"].append(f"batter: {e!r}")

    out["meta"] = {
        "event_num": ev.event_num(),
        "inning": ev.inning(),
        "half": _half_label(ev.half_inning()),
        "batter": ev.batter(),
        "pitcher": ev.pitcher(),
        "result": ev.result_of_AB(),
        "rbi": ev.rbi(),
        "swing": ev.pitch_dict().get("Type of Swing"),
    }
    return out


def simulate_stat_events(stat, search, filters=None):
    """Replay EVERY event matching ``filters`` and return them together, one path
    per event, in the same shape as ``simulate()`` (so the renderer draws them all
    at once). Each path carries a ``label`` (batter + result) for reference."""
    out = {
        "paths": [],
        "random_points": [],
        "fielders": [],
        "batter": None,
        "details": None,
        "errors": [],
        "stadium": None,
        "meta": None,
    }
    stadium = stat.stadium()
    out["stadium"] = stadium if stadium in list_stadiums() else None

    summaries = list_stat_events(stat, search, filters)
    tags = _active_tags(stat)
    first_inp = None
    for s in summaries:
        ev = EventObj(stat, s["event_num"])
        try:
            inp = hit_sim._inputs_from_event(ev, tags)
            result = simulate_hit(inp)
        except Exception as e:
            out["errors"].append(f"event {s['event_num']}: {e!r}")
            continue
        points = trajectory_points(result)
        if not points:
            continue
        if first_inp is None:
            first_inp = inp
        out["paths"].append({
            "points": points,
            "final": points[-1],
            "max_height_point": max(points, key=lambda p: p[1]),
            "vertical_range": None,
            "label": f"{s['batter']} · {s['result']}",
        })

    # When the filter is pinned to one batter, draw a representative batter box.
    batter = (filters or {}).get("batter")
    if batter and first_inp is not None:
        batter_id = CHARACTERNAME_TO_ID.get(batter)
        if batter_id is not None:
            try:
                compute_batter(
                    {"batter_x": first_inp.pos_x, "handedness": first_inp.batter_hand,
                     "batter_id": batter_id},
                    out,
                )
            except Exception as e:
                out["errors"].append(f"batter: {e!r}")

    out["meta"] = {"matched": len(out["paths"]), "filters": filters or {}}
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
