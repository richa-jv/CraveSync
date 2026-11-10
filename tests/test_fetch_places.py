import importlib.util
from pathlib import Path

import pandas as pd

spec = importlib.util.spec_from_file_location(
    "fetch_places", Path(__file__).parent.parent / "scripts" / "fetch_places.py"
)
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)


def el(name, amenity, lat=53.5186, lon=-113.4990, **tags):
    return {"type": "node", "id": 1, "lat": lat, "lon": lon, "tags": {"name": name, "amenity": amenity, **tags}}


def test_cafe_is_coffee_and_quick_snack():
    row = fp.to_row(el("Bean Spot", "cafe", cuisine="coffee_shop", opening_hours="Mo-Fr 07:00-18:00"))
    assert "coffee" in row["good_for"] and "quick snack" in row["good_for"]
    assert "late-night" not in row["good_for"]
    assert row["lat"] == 53.5186 and row["lon"] == -113.499


def test_late_night_from_hours_past_midnight():
    row = fp.to_row(el("Shawarma Place", "fast_food", cuisine="lebanese;shawarma", opening_hours="Mo-Su 11:00-02:00"))
    good = row["good_for"].split(";")
    assert {"lunch", "dinner", "late-night", "quick snack"} <= set(good)
    assert "middle eastern" in row["cuisines"] and "arabic" in row["cuisines"]
    assert "shawarma" in row["dishes"]


def test_lunch_only_restaurant():
    row = fp.to_row(el("Lunch Spot", "restaurant", opening_hours="Mo-Fr 10:00-15:00"))
    assert row["good_for"] == "lunch"


def test_unknown_hours_assume_lunch_and_dinner():
    row = fp.to_row(el("Mystery Bistro", "restaurant"))
    assert row["good_for"] == "lunch;dinner"


def test_areas():
    assert fp.area_for(53.5254, -113.5276) == "On campus"
    assert fp.area_for(53.5185, -113.4975) == "Whyte Ave"


def test_merge_keeps_manual_rows_drops_samples_and_dedupes_chains():
    existing = pd.DataFrame([
        {"name": "Tim Hortons", "distance_km": 0.2, "source": "manual"},
        {"name": "SAMPLE Pho Shop", "distance_km": 2.5, "source": "manual"},
        {"name": "Bar Burrito (SUB)", "distance_km": 0.3, "source": "manual"},
    ])
    fetched = pd.DataFrame([
        {"name": "Tim Hortons", "distance_km": 0.1, "source": "osm"},
        {"name": "Bar Burrito", "distance_km": 0.3, "source": "osm"},
        {"name": "Sushi Now", "distance_km": 1.0, "source": "osm"},
        {"name": "Sushi Now", "distance_km": 2.0, "source": "osm"},
    ])
    out = fp.merge(existing, fetched, keep_samples=False)
    assert sorted(out["name"]) == ["Bar Burrito (SUB)", "Sushi Now", "Tim Hortons"]
    assert out.loc[out["name"] == "Tim Hortons", "source"].item() == "manual"
    assert out.loc[out["name"] == "Sushi Now", "distance_km"].item() == 1.0


def test_drive_thru_off_the_lrt_is_drive_thru_only():
    # Mill Woods: not on the Capital/Metro lines, so you'd only drive there.
    row = fp.to_row(el("Tim Hortons", "fast_food", lat=53.4550, lon=-113.4230, drive_through="yes", cuisine="coffee_shop"))
    assert row["good_for"] == "drive-thru"
    assert row["name"] == "Tim Hortons (drive-thru, Edmonton)"
    assert row["how"] == "drive" and "drive-thru" in row["tags"]


def test_clareview_drive_thru_is_also_reachable_by_lrt():
    row = fp.to_row(el("Tim Hortons", "fast_food", lat=53.6010, lon=-113.4110, drive_through="yes", cuisine="coffee_shop"))
    good = row["good_for"].split(";")
    assert "drive-thru" in good and "coffee" in good
    assert row["name"] == "Tim Hortons (drive-thru, Clareview)"
    assert row["how"].startswith("LRT to Clareview")


def test_drive_thru_near_campus_also_counts_for_walking_plans():
    row = fp.to_row(el("McDonald's", "fast_food", lat=53.5240, lon=-113.5120, drive_through="yes"))
    good = row["good_for"].split(";")
    assert "drive-thru" in good and "lunch" in good
    assert row["location"] == "Garneau"


def test_neighbourhood_labels():
    assert fp.area_for(53.4850, -113.5140) == "Southgate"
    assert fp.area_for(53.5625, -113.5040) == "Kingsway"
    assert fp.area_for(53.5030, -113.5260) == "South Campus"
    assert fp.area_for(53.5140, -113.5230) == "McKernan"


def test_merge_keeps_every_drive_thru_location_and_verified_edits():
    existing = pd.DataFrame([
        {"name": "Tim Hortons", "distance_km": 0.2, "source": "manual"},
        {"name": "Jerusalem Shawarma", "distance_km": 2.0, "source": "osm", "verified": "yes", "osm_id": "node/9", "avg_cost": 16},
        {"name": "Old Unchecked Cafe", "distance_km": 1.0, "source": "osm", "verified": "no", "osm_id": "node/8"},
    ])
    fetched = pd.DataFrame([
        {"name": "Jerusalem Shawarma", "distance_km": 2.0, "source": "osm", "osm_id": "node/9", "avg_cost": 15},
        {"name": "Tim Hortons (drive-thru, Southgate)", "distance_km": 4.8, "source": "osm", "osm_id": "node/1"},
        {"name": "Tim Hortons (drive-thru, Clareview)", "distance_km": 11.5, "source": "osm", "osm_id": "node/2"},
        {"name": "Tim Hortons", "distance_km": 0.5, "source": "osm", "osm_id": "node/3"},
    ])
    out = fp.merge(existing, fetched, keep_samples=False)
    names = sorted(out["name"])
    assert names == ["Jerusalem Shawarma", "Tim Hortons", "Tim Hortons (drive-thru, Clareview)", "Tim Hortons (drive-thru, Southgate)"]
    assert out.loc[out["name"] == "Jerusalem Shawarma", "avg_cost"].item() == 16  # your edit survives
    assert out.loc[out["name"] == "Tim Hortons", "source"].item() == "manual"


def test_every_requested_end_of_the_line_is_reachable():
    for lat, lon, station in [(53.4580, -113.5120, "Century Park"), (53.5700, -113.5060, "NAIT"), (53.6000, -113.4130, "Clareview")]:
        minutes, how, nearest = fp.travel_from_campus(lat, lon)
        assert how.startswith(f"LRT to {station}") and nearest == station and minutes < 45


def test_fifteen_minute_rule_after_the_lrt():
    slat, slon = 53.4866, -113.5132  # Southgate station
    near = fp.travel_from_campus(slat + 0.005, slon)          # ~0.55 km: walk
    bus = fp.travel_from_campus(slat, slon + 0.04)            # ~2.7 km east: one short bus
    too_far = fp.travel_from_campus(slat - 0.045, slon - 0.06)  # ~6 km away: out
    assert "walk" in near[1] and "bus" in bus[1] and too_far is None


def test_query_covers_campus_and_every_station():
    q = fp.overpass_query(*fp.CAMPUS, 3000)
    for _name, _key, lat, lon, _stops in fp.STATIONS:
        assert f"{lat},{lon}" in q
    assert "around:3000," in q and "drive_through" in q


def test_station_coordinates_come_from_the_map_when_close_enough():
    elements = [
        {"type": "node", "lat": 53.6040, "lon": -113.4120, "tags": {"name": "Clareview Station"}},
        {"type": "node", "lat": 53.30, "lon": -113.30, "tags": {"name": "Southgate Transit Centre (far)"}},
    ]
    stations = {s[0]: s for s in fp.match_stations(elements)}
    assert stations["Clareview"][2:4] == (53.6040, -113.4120)
    assert stations["Southgate"][2:4] == (53.4866, -113.5132)  # too far away -> keep built-in


def test_places_off_the_lrt_that_arent_drive_thrus_are_skipped():
    assert fp.to_row(el("Mill Woods Grill", "restaurant", lat=53.4550, lon=-113.4230)) is None


def test_hand_added_places_get_map_details_without_losing_your_edits():
    existing = pd.DataFrame([
        {"name": "ACE Coffee Roasters", "location": "Garneau", "dishes": "london fog;coffee", "avg_cost": 8,
         "distance_km": 0.9, "source": "manual", "verified": "no"},
        {"name": "Mood Cafe", "location": "", "dishes": "vietnamese coffee", "avg_cost": 8, "distance_km": "", "source": "manual"},
    ])
    fetched = pd.DataFrame([
        {"name": "ACE Coffee Roasters Garneau", "location": "Garneau", "dishes": "", "avg_cost": 8, "distance_km": 0.8,
         "lat": 53.52, "lon": -113.51, "opening_hours": "Mo-Su 07:00-18:00", "travel_min": 13, "how": "13 min walk from campus",
         "near_station": "University", "source": "osm", "osm_id": "node/1"},
        {"name": "Mood Cafe", "location": "Strathcona", "dishes": "", "avg_cost": 8, "distance_km": 2.4, "lat": 53.515, "lon": -113.49,
         "opening_hours": "", "travel_min": 18, "how": "one bus from campus", "near_station": "University", "source": "osm", "osm_id": "node/2"},
    ])
    out = fp.merge(existing, fetched, keep_samples=False).set_index("name")
    assert len(out) == 2  # no duplicates
    ace = out.loc["ACE Coffee Roasters"]
    assert ace["lat"] == 53.52 and ace["opening_hours"] == "Mo-Su 07:00-18:00" and ace["travel_min"] == 13
    assert ace["dishes"] == "london fog;coffee" and ace["location"] == "Garneau"  # your edits kept
    mood = out.loc["Mood Cafe"]
    assert mood["location"] == "Strathcona" and mood["distance_km"] == 2.4


def test_busy_areas_are_skipped_not_fatal(monkeypatch):
    calls = []

    def fake_run_query(q, rounds=3):
        calls.append(q)
        if "drive_through" in q:
            raise fp.MapUnavailable("HTTP Error 502: Bad Gateway")
        return [el("Same Cafe", "cafe"), el(f"Spot {len(calls)}", "restaurant") | {"id": 100 + len(calls)}]

    monkeypatch.setattr(fp, "run_query", fake_run_query)
    monkeypatch.setattr(fp.time, "sleep", lambda s: None)
    elements, failed = fp.fetch_all(*fp.CAMPUS, 3000)
    assert failed == ["drive-thrus"]
    assert len(calls) == len(fp.STATIONS) + 2          # campus + every station + drive-thrus
    assert len([e for e in elements if e["tags"]["name"] == "Same Cafe"]) == 1   # de-duplicated


def test_retries_then_gives_up_cleanly(monkeypatch):
    tries = []

    def boom(*a, **k):
        tries.append(1)
        raise OSError("HTTP Error 502: Bad Gateway")

    monkeypatch.setattr(fp.urllib.request, "urlopen", boom)
    monkeypatch.setattr(fp.time, "sleep", lambda s: None)
    import pytest
    with pytest.raises(fp.MapUnavailable):
        fp.run_query("[out:json];node(1);out;", rounds=2)
    assert len(tries) == 2 * len(fp.ENDPOINTS)


def test_partial_run_keeps_places_from_skipped_areas():
    existing = pd.DataFrame([
        {"name": "Clareview Pho", "distance_km": 11, "source": "osm", "verified": "no", "osm_id": "node/7"},
        {"name": "Old Campus Cafe", "distance_km": 0.3, "source": "osm", "verified": "no", "osm_id": "node/8"},
    ])
    fetched = pd.DataFrame([{"name": "Old Campus Cafe", "distance_km": 0.3, "source": "osm", "osm_id": "node/8"}])
    assert sorted(fp.merge(existing, fetched, False, partial=True)["name"]) == ["Clareview Pho", "Old Campus Cafe"]
    assert sorted(fp.merge(existing, fetched, False, partial=False)["name"]) == ["Old Campus Cafe"]


def test_enrich_respects_your_rough_location_and_uses_drive_thru_branches():
    existing = pd.DataFrame([
        {"name": "ACE Coffee Roasters", "location": "Garneau", "distance_km": 0.9, "source": "manual"},
        {"name": "McDonald's", "location": "Near campus", "distance_km": 1.0, "source": "manual"},
    ])
    fetched = pd.DataFrame([
        {"name": "McDonald's (drive-thru, Garneau)", "location": "Garneau", "distance_km": 1.08, "lat": 53.5207, "lon": -113.5116,
         "travel_min": 12, "how": "one bus from campus", "source": "osm", "osm_id": "way/1"},
        {"name": "ACE Coffee Roasters", "location": "Downtown", "distance_km": 2.68, "lat": 53.5424, "lon": -113.4949,
         "travel_min": 19, "how": "one bus from campus", "source": "osm", "osm_id": "node/2"},
        {"name": "McDonald's", "location": "Coliseum", "distance_km": 7.54, "lat": 53.5846, "lon": -113.4667,
         "travel_min": 43, "how": "LRT to Coliseum + short bus", "source": "osm", "osm_id": "way/3"},
    ]).sort_values("travel_min")
    out = fp.merge(existing, fetched, keep_samples=False).set_index("name")
    assert out.loc["McDonald's", "lat"] == 53.5207 and out.loc["McDonald's", "travel_min"] == 12
    assert str(out.loc["ACE Coffee Roasters", "lat"]) in {"", "nan"}  # downtown ACE is too far from your Garneau estimate
