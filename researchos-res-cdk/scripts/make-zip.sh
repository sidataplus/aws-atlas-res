#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
cd ..
rm -f researchos-res-cdk.zip
zip -r researchos-res-cdk.zip researchos-res-cdk \
  -x "*/node_modules/*" "*/cdk.out/*" "*/.git/*" "*/dist/*" "*/.DS_Store"
echo "Wrote researchos-res-cdk.zip"
