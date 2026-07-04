#!/usr/bin/env bash
set -euo pipefail
STACK="${1:-OhdsiAtlasWebApiStack}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER="$($SCRIPT_DIR/cfn-output.sh "$STACK" EcsClusterName)"
ATLAS="$($SCRIPT_DIR/cfn-output.sh "$STACK" AtlasServiceName)"
WEBAPI="$($SCRIPT_DIR/cfn-output.sh "$STACK" WebApiServiceName)"
aws ecs update-service --cluster "$CLUSTER" --service "$ATLAS" --desired-count 0 >/dev/null
aws ecs update-service --cluster "$CLUSTER" --service "$WEBAPI" --desired-count 0 >/dev/null
echo "Scaled $ATLAS and $WEBAPI to desiredCount=0"
