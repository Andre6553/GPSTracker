#!/usr/bin/env python3
"""Append cache-buster to Lovelace HACS resource URL for lux-power-distribution-card."""
import json
import shutil
import sys

path = "/var/lib/homeassistant/homeassistant/.storage/lovelace_resources"
suffix = "spatial_pvlabels=1"

if len(sys.argv) > 1:
    path = sys.argv[1]

shutil.copy2(path, path + ".bak-cachebust")
with open(path, encoding="utf-8") as f:
    data = json.load(f)

changed = False
for item in data.get("data", {}).get("items", []):
    url = item.get("url", "")
    if "lux-power-distribution-card.js" in url and "spatial_pvlabels" not in url:
        sep = "&" if "?" in url else "?"
        item["url"] = url + sep + suffix
        changed = True

if not changed:
    print("No lux-power resource updated (missing or already busted).", file=sys.stderr)
    sys.exit(1)

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)

print("OK:", path)
