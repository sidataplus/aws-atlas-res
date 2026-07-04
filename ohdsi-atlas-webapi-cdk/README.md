# OHDSI ATLAS/WebAPI + CMS DE-SynPUF OMOP + Cognito on AWS CDK

This CDK project deploys a synthetic OHDSI sandbox:

```text
Browser
  -> Launcher API Gateway + Lambda
       -> ECS UpdateService desiredCount=1
       -> poll target-group health
       -> redirect to ATLAS

Browser
  -> ALB + optional Cognito authentication
       /atlas/*  -> ECS Fargate ATLAS service
       /WebAPI/* -> ECS Fargate WebAPI service

WebAPI
  -> Aurora Serverless v2 WebAPI metadata DB
  -> Aurora Serverless v2 synthetic OMOP DB

EventBridge Scheduler
  -> Lambda idle scaler
       -> ECS desiredCount=0 after idle window
```

The web services start at `desiredCount=0`. The launcher starts them on demand. Both Aurora clusters use Serverless v2 with `minCapacity=0`, so compute can auto-pause. Storage, snapshots, logs, the ALB, Route53, and API Gateway/Lambda remain as normal AWS billable resources because, tragically, cloud economics still exists.

## What scales to zero

| Component | Scale-to-zero behavior |
|---|---|
| ATLAS web app | ECS service starts at `desiredCount=0`; launcher wakes to 1 task |
| WebAPI service | ECS service starts at `desiredCount=0`; launcher wakes to 1 task |
| WebAPI metadata DB | Aurora Serverless v2 `minCapacity=0`, auto-pause after idle seconds |
| Synthetic OMOP DB | Aurora Serverless v2 `minCapacity=0`, auto-pause after idle seconds |
| Launcher | Lambda/API Gateway, no idle server |
| Idle scaler | EventBridge scheduled Lambda |
| ALB | Does **not** scale to zero |
| NAT Gateway | Deployed by default so RES private subnets have outbound bootstrap/API access |

## Important design choices

1. **Public app, private RES, isolated DB subnets.** ECS tasks run in public subnets with public IPs, but only accept inbound traffic from the ALB security group. Databases are in isolated private subnets. RES consumes the private subnet tier, so that tier has NAT egress by default for S3, DynamoDB, Secrets Manager, SSM, CloudWatch, package downloads, and other bootstrap/API calls. Set `-c natGateways=0` only if RES will not use this VPC or you provide equivalent VPC endpoints and artifact access.
2. **ALB-level Cognito auth.** WebAPI internal security is disabled in this sandbox and protected at the ALB listener. For a production ResearchOS deployment, put ResearchOS/WebAPI Broker in front and do not expose unrestricted WebAPI directly.
3. **Separate databases.** WebAPI metadata and synthetic OMOP are separate Aurora clusters so each can auto-pause independently.
4. **Synthetic only.** This stack is designed for CMS DE-SynPUF / SynPUF testing, not real patient data.
5. **Pinned OHDSI images.** Defaults use `ohdsi/atlas:2.14.0` and `ohdsi/webapi:2.14.0`. Change context values when you validate newer pairs.

## Prerequisites

- AWS CLI v2 configured with a profile that can create VPC, ECS, ECR asset, RDS, ALB, Cognito, Lambda, API Gateway, IAM, Route53, and ACM resources.
- Node.js 20+.
- Docker running locally, because CDK builds the DB init runner image.
- AWS CDK v2. Use `npx cdk` from this project.
- A Route53 hosted zone and DNS name if you want ALB + Cognito authentication.

ALB Cognito authentication requires HTTPS. If you do not provide `domainName`, `hostedZoneId`, and `hostedZoneName`, the stack still deploys but `AlbCognitoAuthEnabled=false` and the ALB endpoints are unauthenticated. That is only acceptable for a private/sandbox account with IP restriction added by you.

## 1. Inspect supported Aurora Serverless v2 versions

```bash
./scripts/list-aurora-versions.sh us-east-1
```

Pick an Aurora PostgreSQL version in your target region that supports Serverless v2 minimum capacity 0.

## 2. Inspect the SynPUF public bucket

```bash
aws s3 ls --no-sign-request s3://synpuf-omop/
```

The Open Data Registry documents 1k, 100k, and 2.3m person datasets, but you should inspect the bucket prefix before setting `synpufS3Uri`. Start tiny. Cloud bills do not become more scientific just because the dataset got bigger.

## 3. Configure CDK context

The default `cdk.json` is safe-ish for a synthetic sandbox, but the Cognito domain prefix must be globally unique in your AWS region.

Example with custom domain:

```bash
export AWS_PROFILE=my-sandbox
export AWS_REGION=us-east-1

npx cdk synth \
  -c siteName=ohdsi-synpuf \
  -c domainName=ohdsi.example.org \
  -c hostedZoneId=Z1234567890ABC \
  -c hostedZoneName=example.org \
  -c cognitoDomainPrefix=ohdsi-synpuf-auth-123456 \
  -c auroraPostgresEngineVersion=16.6 \
  -c autoPauseSeconds=900 \
  -c webDbMaxAcu=2 \
  -c omopDbMaxAcu=8 \
  -c synpufS3Uri=s3://synpuf-omop/<choose-prefix>/
```

For a throwaway sandbox without DNS/Cognito on ALB:

```bash
npx cdk synth \
  -c siteName=ohdsi-synpuf-dev \
  -c cognitoDomainPrefix=ohdsi-synpuf-dev-auth-123456 \
  -c enableAlbCognitoAuth=false
```

## 4. Install and bootstrap

```bash
npm install
npx cdk bootstrap
```

## 5. Diff and deploy

```bash
npx cdk diff
npx cdk deploy
```

Record the CloudFormation outputs:

- `LauncherUrl`
- `AtlasUrl`
- `WebApiInfoUrl`
- `CognitoUserPoolId`
- `EcsClusterName`
- `InitTaskDefinitionArn`

## 6. Create a Cognito user

```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name OhdsiAtlasWebApiStack \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue | [0]" \
  --output text)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.org \
  --user-attributes Name=email,Value=you@example.org Name=email_verified,Value=true
```

## 7. Initialize schemas

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
```

This creates:

- `webapi` schema in the WebAPI metadata DB.
- `cdm_synpuf`, `results_synpuf`, and `temp_synpuf` schemas in the synthetic OMOP DB.

## 8. Wake WebAPI once so Flyway initializes WebAPI tables

Open `LauncherUrl` from the CDK output and press **Wake ATLAS/WebAPI**.

The launcher starts ECS tasks and waits for target-group health. WebAPI creates its metadata tables during startup.

## 9. Load SynPUF data

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
```

By default, if no `CDM_DDL_URI` is supplied, the loader creates missing tables from file headers using `text` columns. That is acceptable for smoke-testing load mechanics. For serious OHDSI analytics, supply an OMOP CDM PostgreSQL DDL file matching the SynPUF dataset version:

```bash
# Example override pattern. Use an actual DDL URI that matches your chosen SynPUF CDM version.
aws ecs run-task ... \
  --overrides '{"containerOverrides":[{"name":"db-init","environment":[{"name":"INIT_COMMAND","value":"load-synpuf"},{"name":"CDM_DDL_URI","value":"s3://my-bucket/ddl/OMOPCDM_postgresql_5.x_ddl.sql"}]}]}'
```

## 10. Register the OMOP source in WebAPI

After WebAPI has started and created its metadata schema:

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

Then wake the app again and refresh sources:

```bash
curl -k "$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack WebApiInfoUrl)"
```

If ALB Cognito auth is enabled, use the ATLAS UI in a browser instead of raw `curl`.

## 11. Manual sleep

```bash
./scripts/scale-down.sh OhdsiAtlasWebApiStack
```

Or from the launcher API:

```bash
LAUNCHER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)
curl -X POST "$LAUNCHER/sleep"
```

## 12. Check service state

```bash
./scripts/describe.sh OhdsiAtlasWebApiStack
```

## 13. Destroy

For long-lived data, keep the default `removalPolicy=SNAPSHOT`. For throwaway dev stacks, you can deploy with `-c removalPolicy=DESTROY`.

```bash
npx cdk destroy
```

Default `removalPolicy=SNAPSHOT` keeps a final snapshot when CloudFormation deletes the clusters. Use `removalPolicy=DESTROY` only for throwaway sandboxes.

## Production hardening notes

For real institutional use:

- Use ResearchOS/WebAPI Broker instead of exposing WebAPI to normal users.
- Use VPC endpoints and mirrored ECR images instead of public-subnet ECS tasks if your security posture forbids public ENIs. This increases baseline cost.
- Add WAF and IP allowlists on the ALB.
- Enable CloudTrail organization trails, GuardDuty, Security Hub, and ECR image scanning.
- Replace WebAPI source-table plaintext database credentials with a site-approved OHDSI-compatible secret strategy if available.
- Do not load real patient-level data into this stack without governance, private connectivity, stronger authZ, and output controls.
