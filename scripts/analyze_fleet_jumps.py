import csv
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


HOME_LAT = -34.140104
HOME_LON = 22.092554
INNER_RADIUS_M = 50.0

# Thresholds for "jump" detection
STEP_M_MIN = 120.0  # detect smaller "dart" steps that still create lines on the map
IMPLIED_KMH_MIN = 120.0  # implied speed from step/dt

# Optional: which day to analyze (UTC date), can be set by CLI.
# Format: --utc-date YYYY-MM-DD
TARGET_UTC_DATE = None  # type: tuple[int, int, int] | None


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def parse_ts(s: str) -> datetime:
    # Example: 2026-04-02T06:07:49+00:00
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


@dataclass
class Pt:
    ts: datetime
    lat: float
    lon: float
    speed_kmh: float


@dataclass
class Jump:
    to_ts: datetime
    from_ts: datetime
    step_m: float
    dt_s: float
    implied_kmh: float | None
    from_home_m: float
    to_home_m: float
    outside_prev: bool
    outside_cur: bool
    from_lat: float
    from_lon: float
    to_lat: float
    to_lon: float
    reported_speed_kmh: float


def load_csv(csv_path: Path) -> list[Pt]:
    rows: list[Pt] = []
    with csv_path.open("r", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            try:
                ts = parse_ts(row["timestamp"])
                if TARGET_UTC_DATE is not None and (ts.year, ts.month, ts.day) != TARGET_UTC_DATE:
                    continue
                lat = float(row["lat"])
                lon = float(row["lon"])
                speed = float(row.get("speed_kmh") or 0.0)
                rows.append(Pt(ts=ts, lat=lat, lon=lon, speed_kmh=speed))
            except Exception:
                continue
    rows.sort(key=lambda p: p.ts)
    return rows


def analyze(points: list[Pt]) -> list[Jump]:
    jumps: list[Jump] = []
    if len(points) < 2:
        return jumps

    prev = points[0]
    prev_home = haversine_m(prev.lat, prev.lon, HOME_LAT, HOME_LON)
    prev_outside = prev_home > INNER_RADIUS_M

    # dt stats to see if points are spaced ~3s or ~30s etc.
    dts: list[float] = []

    for cur in points[1:]:
        dt = (cur.ts - prev.ts).total_seconds()
        if dt <= 0:
            prev = cur
            prev_home = haversine_m(prev.lat, prev.lon, HOME_LAT, HOME_LON)
            prev_outside = prev_home > INNER_RADIUS_M
            continue
        dts.append(dt)

        step_m = haversine_m(prev.lat, prev.lon, cur.lat, cur.lon)
        implied_kmh = (step_m / dt) * 3.6 if dt >= 1 else None

        cur_home = haversine_m(cur.lat, cur.lon, HOME_LAT, HOME_LON)
        cur_outside = cur_home > INNER_RADIUS_M

        is_jump = step_m >= STEP_M_MIN or (implied_kmh is not None and implied_kmh >= IMPLIED_KMH_MIN)
        if is_jump:
            jumps.append(
                Jump(
                    to_ts=cur.ts,
                    from_ts=prev.ts,
                    step_m=step_m,
                    dt_s=dt,
                    implied_kmh=implied_kmh,
                    from_home_m=prev_home,
                    to_home_m=cur_home,
                    outside_prev=prev_outside,
                    outside_cur=cur_outside,
                    from_lat=prev.lat,
                    from_lon=prev.lon,
                    to_lat=cur.lat,
                    to_lon=cur.lon,
                    reported_speed_kmh=cur.speed_kmh,
                )
            )

        prev = cur
        prev_home = cur_home
        prev_outside = cur_outside

    return jumps


def inside_sequences(points: list[Pt], inner_r: float) -> list[tuple[int, datetime, int, float]]:
    """
    Returns sequences of consecutive points with home_dist <= inner_r.
    Each item: (start_idx, start_ts, run_length, max_home_dist_in_run)
    """
    seqs: list[tuple[int, datetime, int, float]] = []
    n = len(points)
    i = 0
    while i < n:
        home_d = haversine_m(points[i].lat, points[i].lon, HOME_LAT, HOME_LON)
        if home_d > inner_r:
            i += 1
            continue

        start = i
        max_d = home_d
        while i < n:
            d = haversine_m(points[i].lat, points[i].lon, HOME_LAT, HOME_LON)
            max_d = max(max_d, d)
            if d > inner_r:
                break
            i += 1
        run_len = i - start
        seqs.append((start, points[start].ts, run_len, max_d))

    return seqs


def first_transition_inside(points: list[Pt]) -> tuple[int | None, int | None]:
    """
    Returns:
      - first_enter_idx: first index with home_dist <= INNER_RADIUS_M
      - first_leave_idx: first index after being inside where home_dist > INNER_RADIUS_M
    """
    first_enter_idx = None
    for i, p in enumerate(points):
        d = haversine_m(p.lat, p.lon, HOME_LAT, HOME_LON)
        if d <= INNER_RADIUS_M:
            first_enter_idx = i
            break

    first_leave_idx = None
    if first_enter_idx is not None:
        for i in range(first_enter_idx + 1, len(points)):
            d = haversine_m(points[i].lat, points[i].lon, HOME_LAT, HOME_LON)
            if d > INNER_RADIUS_M:
                first_leave_idx = i
                break
    return first_enter_idx, first_leave_idx


def main():
    import sys
    global TARGET_UTC_DATE

    # Defaults
    csv_path = Path(r"./logs/Andre_fleet_history (4).csv")

    # Simple CLI parsing
    i = 1
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == "--csv" and i + 1 < len(sys.argv):
            csv_path = Path(sys.argv[i + 1])
            i += 2
        elif a == "--utc-date" and i + 1 < len(sys.argv):
            ymd = sys.argv[i + 1].strip().split("-")
            if len(ymd) == 3:
                TARGET_UTC_DATE = (int(ymd[0]), int(ymd[1]), int(ymd[2]))
            i += 2
        else:
            i += 1

    if not csv_path.exists():
        raise SystemExit(f"CSV not found: {csv_path.resolve()}")

    points = load_csv(csv_path)
    if TARGET_UTC_DATE is not None:
        print(f"Loaded points for UTC date {TARGET_UTC_DATE}: {len(points)}")
    else:
        print(f"Loaded points (all dates): {len(points)} from {csv_path.name}")

    jumps = analyze(points)
    print(f"Detected jumps: {len(jumps)} (step_m>={STEP_M_MIN} OR implied_kmh>={IMPLIED_KMH_MIN})")

    jumps.sort(key=lambda j: j.step_m, reverse=True)
    print("\nTop jumps by step distance:")
    for j in jumps[:15]:
        implied = f"{j.implied_kmh:.1f} km/h" if j.implied_kmh is not None else "n/a"
        rs = j.reported_speed_kmh if j.reported_speed_kmh is not None else 0.0
        print(
            f"- to={j.to_ts.isoformat()} step={j.step_m:.0f}m dt={j.dt_s:.1f}s implied={implied} "
            f"home_dist: {j.from_home_m:.0f}m({'OUT' if j.outside_prev else 'IN'}) -> {j.to_home_m:.0f}m({'OUT' if j.outside_cur else 'IN'}) "
            f"reported_speed={rs:.1f} km/h"
        )

    enter_idx, leave_idx = first_transition_inside(points)
    print(f"\nFirst enter inner (<= {INNER_RADIUS_M}m): idx={enter_idx} ts={points[enter_idx].ts.isoformat() if enter_idx is not None else None}")
    print(f"First leave inner: idx={leave_idx} ts={points[leave_idx].ts.isoformat() if leave_idx is not None else None}")

    # dt stats (for understanding the cadence of the map darts)
    # Note: recompute quickly (we keep it light; dataset is small for this file)
    dts = []
    for a, b in zip(points, points[1:]):
        dt = (b.ts - a.ts).total_seconds()
        if dt > 0:
            dts.append(dt)
    if dts:
        dts_sorted = sorted(dts)
        def q(p):
            idx = int(round((len(dts_sorted)-1)*p))
            return dts_sorted[idx]
        print(
            f"\ndt between fixes (s): n={len(dts)} min={min(dts):.1f} p25={q(0.25):.1f} median={q(0.5):.1f} p75={q(0.75):.1f} max={max(dts):.1f}"
        )

    # Sequences of being inside the inner radius (relevant to ENTRY_CONFIRM_POINTS=3)
    seqs = inside_sequences(points, INNER_RADIUS_M)
    print(f"\nConsecutive points inside inner radius (<= {INNER_RADIUS_M}m): {len(seqs)} sequences")
    seqs.sort(key=lambda x: x[2], reverse=True)
    top_runs = seqs[:10]
    print("Top inside-run lengths (run_len):")
    for start_idx, start_ts, run_len, max_d in top_runs:
        print(f"- start={start_ts.isoformat()} run_len={run_len} max_home_dist={max_d:.1f}m")

    # Show earliest few enter sequences and whether they reach 3 consecutive points
    seqs_by_time = sorted(seqs, key=lambda x: x[0])
    print("\nFirst few enter sequences (to check inside streak flicker):")
    for start_idx, start_ts, run_len, max_d in seqs_by_time[:10]:
        flag = "OK>=3" if run_len >= 3 else "NO"
        print(f"- enter={start_ts.isoformat()} run_len={run_len} max_home_dist={max_d:.1f}m {flag}")

    # Show jumps near first enter and first leave
    def show_near(center_idx: int | None, label: str):
        if center_idx is None:
            return
        window = 60
        t0 = points[max(0, center_idx - window)].ts
        t1 = points[min(len(points) - 1, center_idx + window)].ts
        near = [j for j in jumps if t0 <= j.to_ts <= t1]
        near.sort(key=lambda x: x.step_m, reverse=True)
        print(f"\nJumps near {label}: {len(near)}")
        for j in near[:10]:
            implied = f"{j.implied_kmh:.1f} km/h" if j.implied_kmh is not None else "n/a"
            print(
                f"  - to={j.to_ts.isoformat()} step={j.step_m:.0f}m implied={implied} "
                f"home={j.to_home_m:.0f}m ({'OUT' if j.outside_cur else 'IN'})"
            )

    show_near(enter_idx, "first enter")
    show_near(leave_idx, "first leave")
    if top_runs:
        show_near(top_runs[0][0], "longest inside run")


if __name__ == "__main__":
    main()

