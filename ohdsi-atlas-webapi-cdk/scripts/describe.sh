#!/usr/bin/env bash
set -euo pipefail
STACK="${1:-OhdsiAtlasWebApiStack}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLUSTER="$($SCRIPT_DIR/cfn-output.sh "$STACK" EcsClusterName)"
ATLAS="$($SCRIPT_DIR/cfn-output.sh "$STACK" AtlasServiceName)"
WEBAPI="$($SCRIPT_DIR/cfn-output.sh "$STACK" WebApiServiceName)"
aws ecs describe-services --cluster "$CLUSTER" --services "$ATLAS" "$WEBAPI" \
  --query 'services[].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,status:status,deployments:deployments[].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,rollout:rolloutState}}' \
  --output json
