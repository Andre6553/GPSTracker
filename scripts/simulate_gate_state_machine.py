import csv
import math
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from pathlib import Path


HOME_LAT = -34.1401849713584
HOME_LON = 22.0925647796762

# State machine constants (match `supabase/functions/telegram-alerts/index.ts`)
OUTER_RADIUS_OFFSET_M = 250  # env default
MIN_DRIVE_SPEED_KMH = 12
MIN_OUTSIDE_SEC = 300
MIN_DRIVE_SEC = 30
ENTRY_CONFIRM_POINTS = 3
COOLDOWN_SEC = 900


def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = math.sin(dLat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@dataclass
class Pt:
    ts: datetime
    lat: float
    lon: float
    speed_kmh: float


def load_points(csv_path: Path) -> list[Pt]:
    rows: list[Pt] = []
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            ts = parse_ts(row["timestamp"])
            lat = float(row["lat"])
            lon = float(row["lon"])
            speed = float(row.get("speed_kmh") or 0.0)
            rows.append(Pt(ts=ts, lat=lat, lon=lon, speed_kmh=speed))
    rows.sort(key=lambda p: p.ts)
    return rows


def elapsed_seconds(iso: datetime, now: datetime) -> int:
    return max(0, int((now - iso).total_seconds()))


def simulate(points: list[Pt]):
    inner_r = 50.0
    outer_r = inner_r + OUTER_RADIUS_OFFSET_M

    # Initial row defaults (row did not exist)
    status = "HOME"
    outside_since: datetime | None = None
    driving_since: datetime | None = None
    inside_streak = 0
    last_distance_m: float | None = None
    cooldown_until: datetime | None = None

    events = []

    for p in points:
        now = p.ts
        dist_m = haversine_km(p.lat, p.lon, HOME_LAT, HOME_LON) * 1000.0
        is_inside_inner = dist_m <= inner_r
        is_outside_outer = dist_m > outer_r
        is_driving = p.speed_kmh >= MIN_DRIVE_SPEED_KMH

        in_cooldown = cooldown_until is not None and now < cooldown_until
        prev_status = status

        if in_cooldown:
            status = "TRIGGERED_COOLDOWN"
            last_distance_m = dist_m
            inside_streak = inside_streak + 1 if is_inside_inner else 0
            if inside_streak > ENTRY_CONFIRM_POINTS:
                inside_streak = ENTRY_CONFIRM_POINTS
        else:
            if status == "TRIGGERED_COOLDOWN" and not in_cooldown:
                status = "HOME" if is_inside_inner else "AWAY_PENDING"

            if is_outside_outer:
                if status in ("HOME", "TRIGGERED_COOLDOWN"):
                    status = "AWAY_PENDING"
                    outside_since = now
                    driving_since = now if is_driving else None

                if status == "AWAY_PENDING":
                    if outside_since is None:
                        outside_since = now
                    if is_driving:
                        if driving_since is None:
                            driving_since = now
                    else:
                        driving_since = None

                    outside_sec = elapsed_seconds(outside_since, now) if outside_since else 0
                    driving_sec = elapsed_seconds(driving_since, now) if driving_since else 0
                    if outside_sec >= MIN_OUTSIDE_SEC and driving_sec >= MIN_DRIVE_SEC:
                        status = "AWAY_CONFIRMED"

                inside_streak = 0
            elif status == "AWAY_PENDING" and not is_inside_inner:
                # Between inner and outer while pending
                inside_streak = 0

            if (status in ("AWAY_CONFIRMED", "RETURNING")) and not is_inside_inner:
                if is_driving and last_distance_m is not None and dist_m < last_distance_m - 5:
                    status = "RETURNING"

            triggered = False
            if (status in ("AWAY_CONFIRMED", "RETURNING")) and is_inside_inner:
                inside_streak += 1
                if inside_streak >= ENTRY_CONFIRM_POINTS:
                    triggered = True
                    status = "TRIGGERED_COOLDOWN"
                    outside_since = None
                    driving_since = None
                    cooldown_until = now + timedelta(seconds=COOLDOWN_SEC)
            elif is_inside_inner:
                status = "HOME"
                inside_streak = min(inside_streak + 1, ENTRY_CONFIRM_POINTS)
            else:
                inside_streak = 0

            if (not triggered) and status == "RETURNING" and (not is_driving) and (not is_inside_inner):
                status = "AWAY_CONFIRMED"

        last_distance_m = dist_m

        if status != prev_status:
            events.append({
                "t": now.isoformat(),
                "to": status,
                "dist_m": round(dist_m, 1),
                "speed_kmh": round(p.speed_kmh, 1),
                "inside_streak": inside_streak,
                "outside_sec": elapsed_seconds(outside_since, now) if outside_since else None,
                "driving_sec": elapsed_seconds(driving_since, now) if driving_since else None,
                "cooldown_active": in_cooldown,
            })

    return events


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    args = ap.parse_args()

    pts = load_points(Path(args.csv))
    print(f"Loaded points: {len(pts)}")
    events = simulate(pts)
    print(f"State transitions: {len(events)}")
    for e in events:
        print(e)


if __name__ == "__main__":
    main()

