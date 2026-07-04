#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://research-engineering-studio-us-east-1.s3.amazonaws.com/releases/latest/ResearchAndEngineeringStudio.template.json}"

python3 - "$URL" <<'PY'
import json
import sys
import urllib.request

url = sys.argv[1]
with urllib.request.urlopen(url) as r:
    template = json.loads(r.read().decode("utf-8"))

params = template.get("Parameters", {})
for name, spec in sorted(params.items()):
    default = spec.get("Default", "")
    desc = spec.get("Description", "")
    print(f"{name}\tdefault={default}\t{desc[:140]}")
PY
