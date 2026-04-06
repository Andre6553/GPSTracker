#!/usr/bin/env python3
"""Merge lux-power-dashboard-views.yaml `views` into HA .storage/lovelace.* JSON (dashboard config)."""
import json
import shutil
import sys
from pathlib import Path

import yaml


def main() -> None:
    if len(sys.argv) < 3:
        print(
            "Usage: apply-lux-views-to-ha-storage.py <lux-power-dashboard-views.yaml> <lovelace.storage.json>",
            file=sys.stderr,
        )
        sys.exit(2)
    yaml_path = Path(sys.argv[1])
    storage_path = Path(sys.argv[2])

    with open(yaml_path, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    if not doc or "views" not in doc:
        print("YAML must have a top-level 'views' key.", file=sys.stderr)
        sys.exit(1)

    backup = storage_path.with_suffix(storage_path.suffix + ".bak-views")
    shutil.copy2(storage_path, backup)

    with open(storage_path, encoding="utf-8") as f:
        storage = json.load(f)

    storage.setdefault("data", {}).setdefault("config", {})["views"] = doc["views"]

    with open(storage_path, "w", encoding="utf-8") as f:
        json.dump(storage, f, indent=2)

    print("OK:", storage_path)
    print("Backup:", backup)


if __name__ == "__main__":
    main()
