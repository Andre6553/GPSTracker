#!/usr/bin/env python3
"""Ensure Lovelace HACS lux-power-distribution-card resource URL has cache-buster query params."""
import json
import shutil
import sys

path = "/var/lib/homeassistant/homeassistant/.storage/lovelace_resources"

# Keys avoid clashing with hacstag= — append only if missing.
DEFAULT_PARAMS = [
    ("spatial_pvlabels", "1"),
    ("spatial_gridhz", "1"),
    ("spatial_loadpct", "1"),
    ("spatial_upscorner", "1"),
    ("spatial_gridups", "1"),
]

if len(sys.argv) > 1:
    path = sys.argv[1]


def ensure_query_param(url: str, key: str, value: str) -> tuple[str, bool]:
    needle = f"{key}="
    if needle in url:
        return url, False
    sep = "&" if "?" in url else "?"
    return url + sep + f"{key}={value}", True


shutil.copy2(path, path + ".bak-cachebust")
with open(path, encoding="utf-8") as f:
    data = json.load(f)

changed = False
for item in data.get("data", {}).get("items", []):
    url = item.get("url", "")
    if "lux-power-distribution-card.js" not in url:
        continue
    new_url = url
    for k, v in DEFAULT_PARAMS:
        new_url, c = ensure_query_param(new_url, k, v)
        changed = changed or c
    item["url"] = new_url

if not changed:
    print("No lux-power resource updated (already has all params).", file=sys.stderr)
    sys.exit(0)

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

print("OK:", path)
