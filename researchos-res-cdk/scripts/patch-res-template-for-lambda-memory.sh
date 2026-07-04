#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://research-engineering-studio-us-east-1.s3.amazonaws.com/releases/latest/ResearchAndEngineeringStudio.template.json}"
OUT="${2:-../temp/ResearchAndEngineeringStudio.lambda-memory-3008.template.json}"
MAX_MEMORY_MB="${MAX_MEMORY_MB:-3008}"
REMOVE_RESERVED_CONCURRENCY="${REMOVE_RESERVED_CONCURRENCY:-true}"

mkdir -p "$(dirname "$OUT")"

python3 - "$URL" "$OUT" "$MAX_MEMORY_MB" "$REMOVE_RESERVED_CONCURRENCY" <<'PY'
import json
import sys
import urllib.request
from pathlib import Path

url = sys.argv[1]
out = Path(sys.argv[2])
max_memory_mb = int(sys.argv[3])
remove_reserved_concurrency = sys.argv[4].lower() in {"1", "true", "yes", "y"}

template = json.loads(urllib.request.urlopen(url).read().decode("utf-8"))
memory_patches = []
reserved_concurrency_patches = []

for logical_id, resource in template.get("Resources", {}).items():
    if resource.get("Type") != "AWS::Lambda::Function":
        continue
    properties = resource.get("Properties", {})
    memory_size = properties.get("MemorySize")
    if isinstance(memory_size, int) and memory_size > max_memory_mb:
        properties["MemorySize"] = max_memory_mb
        memory_patches.append((logical_id, memory_size, max_memory_mb))

    if remove_reserved_concurrency and "ReservedConcurrentExecutions" in properties:
        old_reserved = properties.pop("ReservedConcurrentExecutions")
        reserved_concurrency_patches.append((logical_id, old_reserved))

out.write_text(json.dumps(template, indent=2, sort_keys=True) + "\n")

for logical_id, old, new in memory_patches:
    print(f"{logical_id}: MemorySize {old} -> {new}")
for logical_id, old in reserved_concurrency_patches:
    print(f"{logical_id}: removed ReservedConcurrentExecutions {old}")
print(f"Wrote {out}")
PY
