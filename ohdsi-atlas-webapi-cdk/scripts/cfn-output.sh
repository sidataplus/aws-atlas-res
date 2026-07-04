#!/usr/bin/env bash
set -euo pipefail
STACK="${1:?stack name required}"
KEY="${2:?output key required}"
aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='$KEY'].OutputValue | [0]" \
  --output text
