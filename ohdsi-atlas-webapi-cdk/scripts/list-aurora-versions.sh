#!/usr/bin/env bash
set -euo pipefail
REGION="${1:-${AWS_REGION:-us-east-1}}"
aws rds describe-orderable-db-instance-options \
  --region "$REGION" \
  --engine aurora-postgresql \
  --db-instance-class db.serverless \
  --query 'sort_by(OrderableDBInstanceOptions,&EngineVersion)[].EngineVersion' \
  --output text | tr '\t' '\n' | sort -V | uniq
