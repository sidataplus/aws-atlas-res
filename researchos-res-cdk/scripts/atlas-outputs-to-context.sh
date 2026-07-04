#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${1:-OhdsiAtlasWebApiStack}"
OUT="${2:-cdk.context.local.json}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="${TEMP_DIR:-$SCRIPT_DIR/../../temp}"
ATLAS_OUTPUTS_JSON="${ATLAS_OUTPUTS_JSON:-$TEMP_DIR/atlas-outputs-for-context.json}"

mkdir -p "$TEMP_DIR"

aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' \
  --output json > "$ATLAS_OUTPUTS_JSON"

python3 - "$STACK_NAME" "$OUT" "$ATLAS_OUTPUTS_JSON" <<'PY'
import json
import sys
from pathlib import Path

stack_name = sys.argv[1]
out = Path(sys.argv[2])
atlas_outputs_json = Path(sys.argv[3])

outputs = json.loads(atlas_outputs_json.read_text())
m = {o["OutputKey"]: o.get("OutputValue", "") for o in outputs}

context = {
  "atlasStackName": stack_name,

  "cognitoUserPoolId": m.get("CognitoUserPoolId", ""),
  "cognitoUserPoolDomainUrl": m.get("CognitoUserPoolDomainUrl", ""),
  "cognitoDomainPrefix": "",

  "atlasUrl": m.get("AtlasUrl", ""),
  "webApiUrl": m.get("WebApiInfoUrl", "").replace("/info", ""),

  "omopDbEndpoint": m.get("OmopDbEndpoint", ""),
  "webDbEndpoint": m.get("WebDbEndpoint", ""),

  "omopDbSecretArn": m.get("OmopDbSecretArn", ""),
  "webDbSecretArn": m.get("WebApiDbSecretArn", ""),

  "vpcId": m.get("VpcId", ""),
  "vpcCidr": m.get("VpcCidr", ""),
  "availabilityZones": m.get("AvailabilityZones", ""),

  "publicSubnetIds": m.get("PublicSubnetIds", ""),
  "privateSubnetIds": m.get("PrivateSubnetIds", ""),

  "loadBalancerSubnetIds": m.get("PublicSubnetIds", ""),
  "infrastructureHostSubnetIds": m.get("PrivateSubnetIds", ""),
  "vdiSubnetIds": m.get("PrivateSubnetIds", ""),

  "omopDbSecurityGroupId": m.get("OmopDbSecurityGroupId", "")
}

out.write_text(json.dumps(context, indent=2) + "\n")
print(f"Wrote {out}")
print("Review blanks before deploy. CloudFormation outputs are not telepathy, sadly.")
PY
