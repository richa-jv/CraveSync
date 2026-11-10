"""Pull real food spots around the University of Alberta from OpenStreetMap.

What gets included:
  * everything within a walk or one bus from campus (default 3 km: campus, Garneau, Whyte Ave)
  * everything reachable by LRT: every Capital Line and Metro Line station
    (Century Park <-> Clareview, plus MacEwan / Kingsway / NAIT), and anything within
    a 15-minute walk OR a 15-minute bus ride of a station
  * drive-thrus across south and central Edmonton (Southgate up to Kingsway and Clareview)
Each place gets an estimated travel time from campus and how to get there,
e.g. "LRT to Southgate + 6 min walk".

Merges into data/restaurants.csv:
  * rows you've added by hand (source=manual) or checked (verified=yes) are kept as-is
  * new places from the map are added with source=osm, verified=no
  * SAMPLE placeholder rows are removed (use --keep-samples to keep them)

Run from the project folder:
    python scripts/fetch_places.py
    python scripts/fetch_places.py --dry-run          # preview, don't write

Map data © OpenStreetMap contributors, available under the ODbL.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "restaurants.csv"

CAMPUS = (53.5263, -113.5250)  # U of A Quad
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
FOOD_AMENITIES = "restaurant|cafe|fast_food|ice_cream|food_court"
DRIVE_AMENITIES = "fast_food|cafe|restaurant|ice_cream"
# south, west, north, east: Southgate/South Campus up to Clareview, campus/McKernan across to Clareview.
DRIVE_BBOX = (53.475, -113.565, 53.615, -113.385)

# Neighbourhood labels: (name, lat, lon). A place gets the nearest one within 2 km.
NEIGHBOURHOODS = [
    ("Garneau", 53.5245, -113.5125),
    ("McKernan", 53.5140, -113.5230),
    ("Strathcona", 53.5150, -113.4880),
    ("South Campus", 53.5030, -113.5260),
    ("Southgate", 53.4850, -113.5140),
    ("Downtown", 53.5430, -113.4950),
    ("Kingsway", 53.5625, -113.5040),
    ("Clareview", 53.6010, -113.4110),
    ("Bonnie Doon", 53.5180, -113.4600),
    ("NAIT", 53.5700, -113.5050),
    ("Century Park", 53.4570, -113.5160),
]

# ---- LRT ------------------------------------------------------------------------
# (name, keyword to find it on the map, fallback lat, fallback lon, stops from University station)
# Capital Line runs Century Park <-> Clareview; Metro Line branches at Churchill to NAIT.
# Fallback coordinates are approximate; the script looks up the real ones on the map
# and uses them when it finds a station with that name within 800 m.
STATIONS = [
    ("Century Park", "century park", 53.4568, -113.5162, 5),
    ("Southgate", "southgate", 53.4866, -113.5132, 4),
    ("South Campus", "south campus", 53.5027, -113.5266, 3),
    ("McKernan/Belgravia", "mckernan", 53.5133, -113.5238, 2),
    ("Health Sciences", "health sciences", 53.5201, -113.5257, 1),
    ("University", "university", 53.5248, -113.5215, 0),
    ("Grandin", "grandin", 53.5362, -113.5110, 1),
    ("Corona", "corona", 53.5399, -113.5058, 2),
    ("Bay/Enterprise Square", "bay", 53.5412, -113.4980, 3),
    ("Central", "central", 53.5430, -113.4925, 4),
    ("Churchill", "churchill", 53.5446, -113.4885, 5),
    ("Stadium", "stadium", 53.5595, -113.4762, 6),
    ("Coliseum", "coliseum", 53.5713, -113.4596, 7),
    ("Belvedere", "belvedere", 53.5892, -113.4300, 8),
    ("Clareview", "clareview", 53.6033, -113.4115, 9),
    ("MacEwan", "macewan", 53.5483, -113.4985, 6),
    ("Kingsway/Royal Alex", "kingsway", 53.5598, -113.4995, 7),
    ("NAIT", "nait", 53.5693, -113.5047, 8),
]
MIN_PER_STOP = 2.3        # LRT ride time per stop
FIRST_LEG_MIN = 10        # walk from the Quad to University station + wait for a train
WALK_MIN_PER_KM = 15.6    # 4.8 km/h with a 1.25 detour factor (straight line -> streets)
BUS_WAIT_MIN = 7
TRANSFER_MIN = 3          # getting from the LRT platform to a bus stop
BUS_MIN_PER_KM = 4.5      # ~18 km/h with a 1.35 detour factor
MAX_LAST_LEG_MIN = 15     # "15 minutes after the LRT", walking or on one bus
BUS_REACH_KM = MAX_LAST_LEG_MIN / BUS_MIN_PER_KM   # ~3.3 km from a station


def walk_min(km: float) -> float:
    return km * WALK_MIN_PER_KM


def bus_ride_min(km: float) -> float:
    return km * BUS_MIN_PER_KM


def travel_from_campus(lat: float, lon: float, stations=STATIONS, campus_km: float = 3.0):
    """Best estimated trip from the Quad: (minutes, how, nearest station) or None if not reachable."""
    options = []
    d = haversine_km(CAMPUS, (lat, lon))
    if walk_min(d) <= 25:
        options.append((walk_min(d), f"{round(walk_min(d))} min walk from campus"))
    if d <= max(campus_km, BUS_REACH_KM) and walk_min(d) > MAX_LAST_LEG_MIN:
        options.append((BUS_WAIT_MIN + bus_ride_min(d), "one bus from campus"))
    nearest = None
    for name, _key, slat, slon, stops in stations:
        ds = haversine_km((slat, slon), (lat, lon))
        if nearest is None or ds < nearest[1]:
            nearest = (name, ds)
        ride = FIRST_LEG_MIN + stops * MIN_PER_STOP
        if walk_min(ds) <= MAX_LAST_LEG_MIN:
            options.append((ride + walk_min(ds), f"LRT to {name} + {max(1, round(walk_min(ds)))} min walk"))
        elif bus_ride_min(ds) <= MAX_LAST_LEG_MIN:
            options.append((ride + TRANSFER_MIN + BUS_WAIT_MIN + bus_ride_min(ds), f"LRT to {name} + short bus"))
    if not options:
        return None
    minutes, how = min(options)
    return round(minutes), how, nearest[0]


def stations_query() -> str:
    return """
[out:json][timeout:60];
(
  nwr["railway"="station"](53.44,-113.60,53.62,-113.38);
  nwr["public_transport"="station"](53.44,-113.60,53.62,-113.38);
);
out center tags;
"""


def match_stations(elements: list[dict]) -> list[tuple]:
    """Swap in real station coordinates from the map where we can find them."""
    found = []
    for name, key, lat, lon, stops in STATIONS:
        best = None
        for el in elements:
            label = el.get("tags", {}).get("name", "").lower()
            elat = el.get("lat") or el.get("center", {}).get("lat")
            elon = el.get("lon") or el.get("center", {}).get("lon")
            if key in label and elat is not None:
                d = haversine_km((lat, lon), (elat, elon))
                if d <= 0.8 and (best is None or d < best[0]):
                    best = (d, elat, elon)
        found.append((name, key, best[1], best[2], stops) if best else (name, key, lat, lon, stops))
    return found


# Rough default price per person when the map doesn't say. Edit in the CSV afterwards.
DEFAULT_COST = {"cafe": 8, "ice_cream": 8, "bakery": 8, "fast_food": 13, "food_court": 13, "restaurant": 20}

# OSM cuisine tag -> extra cuisine words our friends' profiles use.
CUISINE_SYNONYMS = {
    "lebanese": ["middle eastern", "arabic"],
    "syrian": ["middle eastern", "arabic"],
    "arab": ["middle eastern", "arabic"],
    "shawarma": ["middle eastern", "arabic"],
    "kebab": ["middle eastern", "arabic"],
    "turkish": ["middle eastern", "mediterranean"],
    "greek": ["mediterranean"],
    "sushi": ["japanese"],
    "ramen": ["japanese"],
    "pho": ["vietnamese"],
    "burger": ["burgers"],
    "coffee shop": ["coffee", "cafe"],
    "ice cream": ["dessert"],
    "bubble tea": ["dessert"],
    "donut": ["dessert"],
    "breakfast": ["brunch"],
}
COFFEE_WORDS = {"coffee", "coffee shop", "tea", "bubble tea", "cafe"}
SNACK_WORDS = {"donut", "bakery", "dessert", "ice cream", "bubble tea", "sandwich", "coffee", "crepe", "juice"}
DISH_WORDS = ["shawarma", "pho", "ramen", "sushi", "pizza", "burger", "taco", "burrito", "dumpling",
              "poke", "bubble tea", "coffee", "donut", "wings", "pasta", "noodle", "curry", "matcha"]


def overpass_query(lat: float, lon: float, radius: int, stations=STATIONS) -> str:
    rings = [f"(around:{radius},{lat},{lon})"]
    rings += [f"(around:{int(BUS_REACH_KM * 1000)},{slat},{slon})" for _n, _k, slat, slon, _s in stations]
    bbox = "({},{},{},{})".format(*DRIVE_BBOX)
    parts = []
    for ring in rings:
        parts.append(f'  nwr["amenity"~"^({FOOD_AMENITIES})$"]["name"]{ring};')
        parts.append(f'  nwr["shop"="bakery"]["name"]{ring};')
    parts.append(f'  nwr["amenity"~"^({DRIVE_AMENITIES})$"]["drive_through"~"^(yes|only)$"]["name"]{bbox};')
    parts.append(f'  nwr["amenity"~"^({DRIVE_AMENITIES})$"]["drive_thru"~"^(yes|only)$"]["name"]{bbox};')
    body = "\n".join(parts)
    return f"""
[out:json][timeout:180];
(
{body}
);
out center tags;
"""


def run_query(query: str) -> list[dict]:
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for url in ENDPOINTS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": "ffo-match-student-project"})
                with urllib.request.urlopen(req, timeout=200) as resp:
                    return json.load(resp)["elements"]
            except Exception as e:  # network errors, rate limits
                last_err = e
                time.sleep(5)
    sys.exit(f"Couldn't reach OpenStreetMap ({last_err}). Check your internet and try again in a minute.")


def load_stations() -> list[tuple]:
    try:
        stations = match_stations(run_query(stations_query()))
    except SystemExit:
        print("Couldn't look up stations on the map; using built-in station locations.")
        return STATIONS
    moved = sum(1 for a, b in zip(STATIONS, stations) if a[2:4] != b[2:4])
    print(f"Found {moved}/{len(STATIONS)} LRT stations on the map (the rest use built-in locations).")
    return stations


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def area_for(lat: float, lon: float, stations=STATIONS) -> str:
    if 53.520 <= lat <= 53.530 and -113.535 <= lon <= -113.515:
        return "On campus"
    if 53.5165 <= lat <= 53.5200 and -113.512 < lon < -113.480:
        return "Whyte Ave"
    name, d = min(((n, haversine_km((a, b), (lat, lon))) for n, a, b in NEIGHBOURHOODS), key=lambda x: x[1])
    if d <= 1.5:
        return name
    st, ds = min(((n, haversine_km((a, b), (lat, lon))) for n, _k, a, b, _s in stations), key=lambda x: x[1])
    return f"near {st.split('/')[0]} Station" if ds <= BUS_REACH_KM else "Edmonton"


# ---- opening hours -------------------------------------------------------------
_RANGE = re.compile(r"(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})")


def hour_ranges(opening_hours: str) -> list[tuple[float, float]]:
    """All (open, close) pairs in hours, e.g. 'Mo-Fr 07:00-22:00' -> [(7, 22)]. Close may be > 24."""
    out = []
    for h1, m1, h2, m2 in _RANGE.findall(opening_hours or ""):
        start, end = int(h1) + int(m1) / 60, int(h2) + int(m2) / 60
        if end <= start:  # closes after midnight
            end += 24
        out.append((start, end))
    return out


def open_at(ranges: list[tuple[float, float]], hour: float) -> bool:
    return any(s <= hour < e or s <= hour + 24 < e for s, e in ranges)


def occasions(kind: str, cuisines: list[str], opening_hours: str, drive_thru: bool = False, walkable: bool = True) -> list[str]:
    """Which plans a place suits. Places outside walking range only count as drive-thrus."""
    good = _walk_occasions(kind, cuisines, opening_hours) if walkable else []
    if drive_thru:
        good.append("drive-thru")
    return good


def _walk_occasions(kind: str, cuisines: list[str], opening_hours: str) -> list[str]:
    is_coffee = kind == "cafe" or bool(COFFEE_WORDS & set(cuisines))
    is_snacky = kind in {"cafe", "fast_food", "ice_cream", "bakery"} or bool(SNACK_WORDS & set(cuisines))
    is_meal = kind in {"restaurant", "fast_food", "food_court"}

    always = "24/7" in (opening_hours or "")
    ranges = hour_ranges(opening_hours)
    known = always or bool(ranges)

    good = []
    if is_coffee:
        good.append("coffee")
    if is_snacky:
        good.append("quick snack")
    if is_meal and (not known or always or open_at(ranges, 12.5)):
        good.append("lunch")
    if is_meal and (not known or always or open_at(ranges, 18.5)):
        good.append("dinner")
    if always or any(e >= 22.5 for _, e in ranges):
        good.append("late-night")
    return good


# ---- turning map data into our CSV rows ---------------------------------------
def to_row(el: dict, walk_km: float = 3.0, stations=STATIONS) -> dict | None:
    tags = el.get("tags", {})
    name = tags.get("name")
    lat = el.get("lat") or el.get("center", {}).get("lat")
    lon = el.get("lon") or el.get("center", {}).get("lon")
    if not name or lat is None or lon is None:
        return None

    kind = tags.get("amenity") or ("bakery" if tags.get("shop") == "bakery" else "restaurant")
    raw = [c.strip().lower().replace("_", " ") for c in tags.get("cuisine", "").split(";") if c.strip()]
    cuisines = list(raw)
    for c in raw:
        cuisines += CUISINE_SYNONYMS.get(c, [])
    if kind == "cafe":
        cuisines.append("cafe")
    if kind == "bakery":
        cuisines.append("bakery")
    cuisines = list(dict.fromkeys(cuisines))

    lower_name = name.lower()
    dishes = [d for d in DISH_WORDS if d in lower_name or d in raw]

    tag_list = []
    if tags.get("diet:halal") in {"yes", "only"}:
        tag_list.append("halal")
    if tags.get("diet:vegetarian") in {"yes", "only"}:
        tag_list.append("vegetarian-friendly")
    if tags.get("diet:vegan") in {"yes", "only"}:
        tag_list.append("vegan-friendly")
    if "coffee" in cuisines or kind == "cafe":
        tag_list.append("coffee")

    hours = tags.get("opening_hours", "")
    drive = tags.get("drive_through") in {"yes", "only"} or tags.get("drive_thru") in {"yes", "only"}
    dist = haversine_km(CAMPUS, (lat, lon))
    trip = travel_from_campus(lat, lon, stations, walk_km)
    walkable = trip is not None and tags.get("drive_through") != "only"
    if not walkable and not drive:
        return None  # can't get there by walking, LRT or one bus, and it's not a drive-thru
    area = area_for(lat, lon, stations)
    if drive:
        tag_list.append("drive-thru")
        # Keep each drive-thru location separate: "Tim Hortons (drive-thru, Southgate)".
        name = f"{name} (drive-thru, {area})"
    desc_bits = [kind.replace("_", " ")] + raw + (["drive-thru"] if drive else [])
    return {
        "name": name,
        "location": area,
        "cuisines": ";".join(cuisines),
        "dishes": ";".join(dishes),
        "proteins": "",  # unknown from the map - fill in by hand where it matters
        "avg_cost": DEFAULT_COST.get(kind, 15),
        "distance_km": round(dist, 2),
        "travel_min": trip[0] if trip else "",
        "how": trip[1] if trip else "drive",
        "near_station": trip[2] if trip else "",
        "good_for": ";".join(occasions(kind, cuisines, hours, drive, walkable)),
        "tags": ";".join(tag_list),
        "description": ", ".join(desc_bits) + (f". Hours: {hours}" if hours else ""),
        "verified": "no",
        "source": "osm",
        "osm_id": f"{el.get('type')}/{el.get('id')}",
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "opening_hours": hours,
    }


def norm(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", str(name).lower())
    return re.sub(r"[^a-z0-9]", "", name)


def _col(df: pd.DataFrame, name: str, default: str) -> pd.Series:
    return df[name].fillna(default).astype(str) if name in df else pd.Series(default, index=df.index)


def merge(existing: pd.DataFrame, fetched: pd.DataFrame, keep_samples: bool) -> pd.DataFrame:
    if not keep_samples:
        existing = existing[~existing["name"].astype(str).str.startswith("SAMPLE")]
    # Keep anything added by hand or already checked (verified=yes) - never overwrite your edits.
    keep = existing[(_col(existing, "source", "manual") != "osm") | (_col(existing, "verified", "no").str.lower() == "yes")]
    kept_ids = set(_col(keep, "osm_id", ""))
    known = {norm(n) for n in keep["name"]}
    fetched = fetched[~_col(fetched, "osm_id", "").isin(kept_ids - {""})]
    sort_key = pd.to_numeric(fetched["travel_min"], errors="coerce") if "travel_min" in fetched else fetched["distance_km"]
    fetched = fetched.assign(_t=sort_key.fillna(999)).sort_values(["_t", "distance_km"]).drop(columns="_t")

    is_drive = fetched["name"].astype(str).str.contains(r"\(drive-thru,", regex=True)
    # Walk-in chains (e.g. several Tim Hortons): keep only the closest one.
    walk = fetched[~is_drive]
    walk = walk.assign(_k=walk["name"].map(norm)).drop_duplicates("_k").drop(columns="_k")
    walk = walk[~walk["name"].map(norm).isin(known)]
    # Drive-thrus: keep every location (they're named by neighbourhood).
    drive = fetched[is_drive].drop_duplicates("name")
    drive = drive[~drive["name"].isin(set(keep["name"]))]

    out = pd.concat([keep, walk, drive], ignore_index=True)
    return out.sort_values("distance_km").reset_index(drop=True)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--radius", type=int, default=3000, help="metres around the Quad to include (default 3000)")
    ap.add_argument("--keep-samples", action="store_true", help="keep SAMPLE placeholder rows")
    ap.add_argument("--dry-run", action="store_true", help="print what would be added, don't write")
    args = ap.parse_args()

    print("Looking up LRT stations...")
    stations = load_stations()
    print(f"Fetching food spots around campus and within a 15-min walk/bus of {len(stations)} LRT stations,")
    print("plus drive-thrus from Southgate up to Kingsway and Clareview. This can take a minute...")
    elements = run_query(overpass_query(*CAMPUS, args.radius, stations))
    rows = [r for el in elements if (r := to_row(el, args.radius / 1000, stations))]
    fetched = pd.DataFrame(rows)
    n_drive = fetched["good_for"].str.contains("drive-thru").sum()
    print(f"Found {len(fetched)} places on the map ({n_drive} drive-thrus).")

    existing = pd.read_csv(OUT) if OUT.exists() else pd.DataFrame(columns=fetched.columns)
    merged = merge(existing, fetched, args.keep_samples)
    added = (merged["source"] == "osm").sum()

    print(merged["location"].value_counts().head(25).to_string())
    if args.dry_run:
        print(merged[["name", "location", "distance_km", "good_for"]].to_string(index=False))
        return
    merged.to_csv(OUT, index=False)
    print(f"\nSaved {len(merged)} places to {OUT} ({added} from the map). "
          "Open it and fix prices / proteins for the spots you actually go to.")


if __name__ == "__main__":
    main()
