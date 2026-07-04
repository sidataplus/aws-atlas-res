#!/usr/bin/env bash
set -euo pipefail

# Edit these. The universe remains stubbornly unable to infer your subnets.
export AWS_REGION="${AWS_REGION:-us-east-1}"

npx cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail="you@example.org" \
  -c sshKeyPair="my-existing-ec2-keypair" \
  -c clientIp="0.0.0.0/0" \
  -c cognitoUserPoolId="us-east-1_XXXXXXXXX" \
  -c cognitoUserPoolDomainUrl="https://your-domain.auth.${AWS_REGION}.amazoncognito.com" \
  -c vpcId="vpc-xxxxxxxx" \
  -c vpcCidr="10.0.0.0/16" \
  -c availabilityZones="${AWS_REGION}a,${AWS_REGION}b" \
  -c loadBalancerSubnetIds="subnet-public-a,subnet-public-b" \
  -c infrastructureHostSubnetIds="subnet-private-a,subnet-private-b" \
  -c vdiSubnetIds="subnet-private-a,subnet-private-b" \
  -c atlasUrl="https://ohdsi.example.org/atlas" \
  -c webApiUrl="https://ohdsi.example.org/WebAPI" \
  -c omopDbEndpoint="example.cluster-xyz.${AWS_REGION}.rds.amazonaws.com" \
  -c omopDbSecretArn="arn:aws:secretsmanager:${AWS_REGION}:123456789012:secret:omop" \
  -c omopDbSecurityGroupId="sg-xxxxxxxx" \
  -c synpufS3Uri="s3://synpuf-omop/"
