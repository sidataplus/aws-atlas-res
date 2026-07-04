#!/usr/bin/env bash
set -euo pipefail
STACK="${1:-OhdsiAtlasWebApiStack}"
COMMAND="${2:-schemas}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLUSTER="$($SCRIPT_DIR/cfn-output.sh "$STACK" EcsClusterName)"
TASK_DEF="$($SCRIPT_DIR/cfn-output.sh "$STACK" InitTaskDefinitionArn)"
SG="$($SCRIPT_DIR/cfn-output.sh "$STACK" ServiceSecurityGroupId)"
SUBNETS="$($SCRIPT_DIR/cfn-output.sh "$STACK" PublicSubnetIds)"

IFS=',' read -ra SUBNET_ARR <<< "$SUBNETS"
SUBNET_JSON="$(printf '"%s",' "${SUBNET_ARR[@]}" | sed 's/,$//')"

OVERRIDES=$(cat <<JSON
{"containerOverrides":[{"name":"db-init","environment":[{"name":"INIT_COMMAND","value":"$COMMAND"}]}]}
JSON
)

NETWORK=$(cat <<JSON
{"awsvpcConfiguration":{"subnets":[$SUBNET_JSON],"securityGroups":["$SG"],"assignPublicIp":"ENABLED"}}
JSON
)

echo "Running init task: command=$COMMAND cluster=$CLUSTER taskDefinition=$TASK_DEF"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --launch-type FARGATE \
  --task-definition "$TASK_DEF" \
  --network-configuration "$NETWORK" \
  --overrides "$OVERRIDES" \
  --query 'tasks[0].taskArn' \
  --output text)

echo "Task ARN: $TASK_ARN"
echo "Waiting for task to stop..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason}' \
  --output table
