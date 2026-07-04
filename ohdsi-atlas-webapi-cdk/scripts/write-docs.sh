#!/usr/bin/env bash
set -euo pipefail

mkdir -p docs

cat > docs/README.md <<'MD'
# OHDSI ATLAS/WebAPI CDK Documentation

This `docs/` directory documents the AWS CDK deployment for a cost-conscious OHDSI ATLAS/WebAPI sandbox using:

- OHDSI ATLAS
- OHDSI WebAPI
- Amazon Cognito authentication
- Application Load Balancer routing
- ECS Fargate services that can scale to zero
- Aurora Serverless v2 databases that can auto-pause when supported by the selected engine and region
- CMS DE-SynPUF OMOP data from the AWS Open Data Registry

This stack is intended as a synthetic-data OHDSI sandbox and a ResearchOS-compatible blueprint. It is not a hardened production PHI environment out of the box.

## Document map

| File | Purpose |
|---|---|
| [`architecture.md`](architecture.md) | System architecture, request flow, trust boundaries, scale-to-zero design |
| [`deployment.md`](deployment.md) | End-to-end deployment guide |
| [`configuration.md`](configuration.md) | CDK context keys, images, secrets, environment settings |
| [`authentication-cognito.md`](authentication-cognito.md) | Cognito, ALB authentication, WebAPI auth notes |
| [`scale-to-zero.md`](scale-to-zero.md) | Idle scaling, cold start behavior, cost caveats |
| [`database-and-omop.md`](database-and-omop.md) | WebAPI metadata DB, OMOP schemas, source registration |
| [`synpuf-loading.md`](synpuf-loading.md) | Loading CMS DE-SynPUF OMOP from public S3 |
| [`operations.md`](operations.md) | Runbook commands, logs, scaling, updates |
| [`security.md`](security.md) | Sandbox security model and production hardening checklist |
| [`troubleshooting.md`](troubleshooting.md) | Common failures and fixes |

## High-level architecture

```text
Browser
  -> Launcher API Gateway + Lambda
       -> ECS UpdateService desiredCount=1
       -> poll ALB target groups
       -> redirect to ATLAS

Browser
  -> ALB + optional Cognito authentication
       /atlas/*  -> ECS Fargate ATLAS
       /WebAPI/* -> ECS Fargate WebAPI

WebAPI
  -> Aurora Serverless v2 WebAPI metadata DB
  -> Aurora Serverless v2 synthetic OMOP DB

EventBridge scheduled rule
  -> Lambda idle scaler
       -> ECS desiredCount=0 after idle window
````

## Quick deployment sequence

```bash
npm install

./scripts/list-aurora-versions.sh us-east-1

aws s3 ls --no-sign-request s3://synpuf-omop/

npx cdk bootstrap

npx cdk deploy \
  -c siteName=ohdsi-synpuf \
  -c domainName=ohdsi.example.org \
  -c hostedZoneId=Z1234567890ABC \
  -c hostedZoneName=example.org \
  -c cognitoDomainPrefix=ohdsi-synpuf-auth-123456 \
  -c auroraPostgresEngineVersion=16.6 \
  -c autoPauseSeconds=900 \
  -c synpufS3Uri=s3://synpuf-omop/<chosen-prefix>/
```

Then initialize:

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

## Important limitations

This is a low-cost sandbox pattern, not a complete regulated production environment.

The main limitations are:

* The ALB does not scale to zero.
* Cognito is applied at the ALB layer in this sandbox.
* WebAPI native authorization is not fully configured by default.
* The OMOP data source is synthetic CMS DE-SynPUF, not real PHI.
* The init loader is meant for bootstrap and smoke testing.
* Production deployments should add WAF, private networking, VPC endpoints, stronger WebAPI authorization, CloudTrail review, backup policies, and ResearchOS/Broker governance.
  MD

cat > docs/architecture.md <<'MD'

# Architecture

## Purpose

This stack deploys a synthetic OHDSI ATLAS/WebAPI environment on AWS with aggressive idle-cost reduction.

The central idea is:

```text
Keep the expensive app tier at desiredCount=0 when idle.
Keep databases in serverless/auto-pause mode when idle.
Use a tiny launcher to wake the stack when a user arrives.
```

## Component diagram

```text
                                ┌────────────────────────────┐
                                │        Amazon Cognito       │
                                │  User Pool + Hosted Login   │
                                └─────────────┬──────────────┘
                                              │
                                              │ OIDC / ALB auth
                                              v
┌──────────────────────────────────────────────────────────────────────┐
│ Public entry                                                         │
│                                                                      │
│  Route53 + ACM                                                       │
│        │                                                             │
│        v                                                             │
│  Application Load Balancer                                           │
│        ├── /atlas/*  ─────────────▶ ECS Fargate ATLAS                │
│        └── /WebAPI/* ─────────────▶ ECS Fargate WebAPI               │
│                                      │                               │
│                                      │ JDBC                          │
└──────────────────────────────────────┼───────────────────────────────┘
                                       │
                                       v
┌──────────────────────────────────────────────────────────────────────┐
│ Aurora Serverless v2                                                  │
│                                                                      │
│  WebAPI metadata cluster                                              │
│    schema: webapi                                                     │
│                                                                      │
│  Synthetic OMOP cluster                                               │
│    schema: cdm_synpuf                                                 │
│    schema: results_synpuf                                             │
│    schema: temp_synpuf                                                │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Wake / idle orchestration                                             │
│                                                                      │
│  API Gateway + Lambda launcher                                        │
│      └── sets ECS desiredCount=1 and waits for healthy targets        │
│                                                                      │
│  EventBridge + Lambda idle scaler                                     │
│      └── sets ECS desiredCount=0 after inactivity                     │
└──────────────────────────────────────────────────────────────────────┘
```

## Runtime services

| Component          | AWS service               | Scale-to-zero behavior                         |
| ------------------ | ------------------------- | ---------------------------------------------- |
| ATLAS              | ECS Fargate service       | Desired count can be set to 0                  |
| WebAPI             | ECS Fargate service       | Desired count can be set to 0                  |
| WebAPI metadata DB | Aurora Serverless v2      | Can auto-pause if engine/region supports 0 ACU |
| OMOP DB            | Aurora Serverless v2      | Can auto-pause if engine/region supports 0 ACU |
| Launcher           | API Gateway + Lambda      | Event-driven                                   |
| Idle scaler        | EventBridge + Lambda      | Event-driven                                   |
| ALB                | Application Load Balancer | Does not scale to zero                         |
| Cognito            | User Pool                 | Managed service                                |

## Cold start flow

```text
1. User opens LauncherUrl.
2. Lambda calls ECS UpdateService:
     atlas desiredCount = 1
     webapi desiredCount = 1
3. Lambda polls target group health.
4. Aurora resumes when WebAPI connects.
5. Launcher redirects user to /atlas.
6. ALB/Cognito handles login.
7. User lands in ATLAS.
```

## Warm access flow

```text
1. User opens AtlasUrl.
2. ALB routes /atlas/* to ATLAS.
3. ATLAS calls /WebAPI/*.
4. WebAPI queries metadata and OMOP databases.
```

## Idle shutdown flow

```text
1. EventBridge invokes idle scaler periodically.
2. Lambda checks recent ALB request metrics.
3. If no recent traffic:
     atlas desiredCount = 0
     webapi desiredCount = 0
4. Aurora later auto-pauses if supported and idle.
```

## Trust boundaries

```text
Internet
  |
  v
ALB / Cognito auth boundary
  |
  v
ECS service security groups
  |
  v
Database security groups
```

## Non-goals

This stack intentionally avoids:

* Running always-on EC2 instances.
* Running NAT gateways by default.
* Hosting real PHI.
* Exposing WebAPI as a public unauthenticated API.
* Solving full OHDSI role-based authorization.
* Becoming a production ResearchOS deployment by itself.

For production, place ResearchOS or a WebAPI broker in front of WebAPI and treat ATLAS as an expert/admin interface.
MD

cat > docs/deployment.md <<'MD'

# Deployment Guide

## Prerequisites

Install locally:

```bash
node --version
npm --version
aws --version
docker --version
```

Recommended:

* Node.js 20 or later
* AWS CLI v2
* AWS CDK v2
* Docker
* An AWS account with permissions for CDK bootstrap and deployment
* Optional Route53 hosted zone for HTTPS + Cognito ALB authentication

Configure AWS:

```bash
export AWS_PROFILE=my-sandbox
export AWS_REGION=us-east-1

aws sts get-caller-identity
```

## 1. Install dependencies

From the project root:

```bash
npm install
```

## 2. Check Aurora PostgreSQL versions

Aurora Serverless v2 scale-to-zero support depends on region and engine version.

```bash
./scripts/list-aurora-versions.sh us-east-1
```

Pick a supported Aurora PostgreSQL engine version and pass it as CDK context.

## 3. Inspect the SynPUF bucket

The public dataset lives in the public AWS Open Data S3 bucket.

```bash
aws s3 ls --no-sign-request s3://synpuf-omop/
```

Choose the smallest useful prefix first. Start with 1k or 100k before trying the full dataset. This is called debugging with mercy, a habit humans invented and then mostly ignored.

## 4. Synthesize

With Route53 domain and Cognito-protected ALB:

```bash
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
  -c synpufS3Uri=s3://synpuf-omop/<chosen-prefix>/
```

Sandbox without DNS/Cognito on ALB:

```bash
npx cdk synth \
  -c siteName=ohdsi-synpuf-dev \
  -c enableAlbCognitoAuth=false \
  -c cognitoDomainPrefix=ohdsi-synpuf-dev-auth-123456
```

The second option is for isolated sandbox use only.

## 5. Bootstrap and deploy

```bash
npx cdk bootstrap
npx cdk diff
npx cdk deploy
```

Save the stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name OhdsiAtlasWebApiStack \
  --query "Stacks[0].Outputs"
```

## 6. Create a Cognito user

```bash
USER_POOL_ID=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack CognitoUserPoolId)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.org \
  --user-attributes Name=email,Value=you@example.org Name=email_verified,Value=true
```

## 7. Initialize schemas

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
```

Expected schemas:

```text
WebAPI metadata database:
  webapi

OMOP database:
  cdm_synpuf
  results_synpuf
  temp_synpuf
```

## 8. Wake the services

Open the launcher URL:

```bash
./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl
```

The launcher scales ATLAS and WebAPI from 0 to 1 task and redirects once healthy.

## 9. Load SynPUF

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
```

For stronger schema fidelity, provide a matching OMOP PostgreSQL DDL through the init task environment, if your project supports `CDM_DDL_URI`.

## 10. Register the WebAPI source

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

Then wake the stack again and check ATLAS data sources.

## 11. Verify

```bash
ATLAS_URL=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack AtlasUrl)
WEBAPI_INFO_URL=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack WebApiInfoUrl)

echo "$ATLAS_URL"
curl -i "$WEBAPI_INFO_URL"
```

In ATLAS, verify:

* Login works.
* WebAPI is reachable.
* SynPUF source is visible.
* Vocabulary search works.
* A simple cohort can be generated.

## 12. Scale down manually

```bash
./scripts/scale-down.sh OhdsiAtlasWebApiStack
```

Or:

```bash
LAUNCHER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)
curl -X POST "$LAUNCHER/sleep"
```

## 13. Destroy

For disposable environments:

```bash
npx cdk destroy
```

Check retained resources manually if you changed removal policies.
MD

cat > docs/configuration.md <<'MD'

# Configuration Reference

This stack is configured primarily through CDK context values.

Pass values with:

```bash
npx cdk deploy -c key=value
```

Or put them in `cdk.json`.

## Common context keys

| Key                           |       Required | Example                      | Purpose                                           |
| ----------------------------- | -------------: | ---------------------------- | ------------------------------------------------- |
| `siteName`                    |            Yes | `ohdsi-synpuf`               | Prefix/name used for resources                    |
| `domainName`                  |             No | `ohdsi.example.org`          | Public DNS name for ALB                           |
| `hostedZoneId`                | If DNS enabled | `Z1234567890ABC`             | Route53 hosted zone ID                            |
| `hostedZoneName`              | If DNS enabled | `example.org`                | Route53 hosted zone name                          |
| `enableAlbCognitoAuth`        |             No | `true`                       | Enables ALB Cognito auth when HTTPS is configured |
| `cognitoDomainPrefix`         |            Yes | `ohdsi-synpuf-auth-123456`   | Cognito hosted UI domain prefix                   |
| `auroraPostgresEngineVersion` |    Recommended | `16.6`                       | Aurora PostgreSQL version                         |
| `autoPauseSeconds`            |             No | `900`                        | Aurora idle seconds before pause, if supported    |
| `webDbMaxAcu`                 |             No | `2`                          | Max ACU for WebAPI metadata DB                    |
| `omopDbMaxAcu`                |             No | `8`                          | Max ACU for OMOP DB                               |
| `synpufS3Uri`                 |   Yes for load | `s3://synpuf-omop/<prefix>/` | Public SynPUF source prefix                       |
| `idleMinutes`                 |             No | `30`                         | Idle window before ECS scale-down                 |
| `webapiImage`                 |             No | pinned image tag             | WebAPI container image                            |
| `atlasImage`                  |             No | pinned image tag             | ATLAS container image                             |

## Recommended context file

Example `cdk.context.json`:

```json
{
  "siteName": "ohdsi-synpuf",
  "domainName": "ohdsi.example.org",
  "hostedZoneId": "Z1234567890ABC",
  "hostedZoneName": "example.org",
  "enableAlbCognitoAuth": true,
  "cognitoDomainPrefix": "ohdsi-synpuf-auth-123456",
  "auroraPostgresEngineVersion": "16.6",
  "autoPauseSeconds": 900,
  "webDbMaxAcu": 2,
  "omopDbMaxAcu": 8,
  "idleMinutes": 30,
  "synpufS3Uri": "s3://synpuf-omop/<chosen-prefix>/"
}
```

## Image pinning

Pin images explicitly.

Do not use `latest` for durable environments. `latest` is not a version; it is a tiny chaos portal with a Docker label.

Example:

```bash
npx cdk deploy \
  -c atlasImage=ohdsi/atlas:<tag> \
  -c webapiImage=ohdsi/webapi:<tag>
```

## Database settings

The stack uses two logical database roles:

| Database           | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| WebAPI metadata DB | WebAPI application metadata, security tables, source metadata |
| OMOP DB            | Synthetic OMOP CDM, vocabulary, results, temp schemas         |

Default schema names:

| Schema           | Purpose                        |
| ---------------- | ------------------------------ |
| `webapi`         | WebAPI metadata                |
| `cdm_synpuf`     | OMOP CDM + vocabulary          |
| `results_synpuf` | Cohorts and WebAPI results     |
| `temp_synpuf`    | Temporary SQL generation space |

## Secrets

Secrets should be stored in AWS Secrets Manager and injected into ECS tasks.

Do not commit:

* Database passwords
* Cognito client secrets
* WebAPI secrets
* Private Docker registry credentials
* Athena vocabulary credentials

## Network defaults

The low-cost default avoids a NAT gateway. ECS tasks may run in public subnets with restrictive security groups.

For production, prefer private subnets with VPC endpoints or a controlled NAT design.
MD

cat > docs/authentication-cognito.md <<'MD'

# Cognito Authentication

## Authentication pattern

This sandbox uses Cognito at the Application Load Balancer layer.

```text
Browser
  -> ALB HTTPS listener
  -> authenticate-cognito action
  -> ATLAS or WebAPI target group
```

This gives a simple perimeter gate for both `/atlas/*` and `/WebAPI/*`.

## Why ALB-level Cognito?

Advantages:

* Simple browser login.
* Works well for sandbox deployments.
* Keeps unauthenticated users away from ATLAS and WebAPI endpoints.
* Avoids WebAPI-native OIDC complexity during initial deployment.

Tradeoffs:

* WebAPI may not receive rich application-level role information.
* OHDSI WebAPI internal permissions are not fully enforced by Cognito alone.
* Programmatic API access is awkward.
* Fine-grained ATLAS/WebAPI authorization still needs WebAPI security configuration or a broker layer.

## Recommended sandbox pattern

```text
Cognito authenticates the browser.
ALB enforces login.
ATLAS and WebAPI are reachable only after login.
```

## Recommended production pattern

```text
Cognito -> ResearchOS / WebAPI Broker -> WebAPI
                         |
                         └── audit, authorization, project policy
```

ATLAS should be treated as an expert/admin interface in production, not the general researcher UX.

## Cognito user pool

The stack creates or configures:

* User Pool
* App client
* Hosted UI domain
* OAuth scopes
* Callback URLs
* Logout URLs

Typical scopes:

```text
openid
email
profile
```

## Callback URLs

For ALB authentication, the callback URL should follow this pattern:

```text
https://\<domain\>/oauth2/idpresponse
```

Common mistake:

```text
https://\<domain\>/atlas/\#/welcome/
```

That is an ATLAS route, not the ALB identity provider callback. Humans see a URL box and immediately feed it the nearest URL-shaped object. Nature is cruel.

## Creating a user

```bash
USER_POOL_ID=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack CognitoUserPoolId)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.org \
  --user-attributes Name=email,Value=you@example.org Name=email_verified,Value=true
```

## Logout behavior

Logout usually needs both:

1. ATLAS/WebAPI session cleared, if applicable.
2. Cognito hosted UI logout URL.

For ALB auth, expect session cookies from the ALB and Cognito. Redirect loops usually mean the callback URL, domain, HTTPS listener, or app client settings are wrong.

## WebAPI native security

This CDK sandbox does not fully configure WebAPI-native security by default.

For production, configure one of:

| Option                   | Use when                                      |
| ------------------------ | --------------------------------------------- |
| WebAPI OIDC with Cognito | ATLAS/WebAPI should directly understand users |
| ResearchOS Broker        | ResearchOS owns authz, audit, and governance  |
| ALB auth only            | Sandbox or coarse perimeter protection        |

Cognito authentication is not the same as OHDSI authorization. Login proves identity; it does not prove a user should generate cohorts against a source.
MD

cat > docs/scale-to-zero.md <<'MD'

# Scale-to-Zero Design

## Goal

The stack is optimized for environments that are not used 24/7.

Cold start is acceptable. The app should wake smoothly, show a loading experience, and then redirect users when services are ready.

## What scales down

| Component          | Scale-to-zero behavior                         |
| ------------------ | ---------------------------------------------- |
| ATLAS ECS service  | `desiredCount=0`                               |
| WebAPI ECS service | `desiredCount=0`                               |
| WebAPI metadata DB | Aurora Serverless v2 auto-pause when supported |
| OMOP DB            | Aurora Serverless v2 auto-pause when supported |
| Launcher           | Lambda, event-driven                           |
| Idle scaler        | Lambda, event-driven                           |

## What does not scale down

| Component       | Why                             |
| --------------- | ------------------------------- |
| ALB             | Always-on managed load balancer |
| Route53         | DNS hosted zone remains         |
| ACM certificate | Certificate remains             |
| CloudWatch logs | Stored logs remain              |
| Secrets Manager | Stored secrets remain           |
| S3 data         | Object storage remains          |

If absolute idle cost must be close to zero, replace ALB with a different access pattern. The ALB is practical for Cognito-authenticated browser access, but it is not free. Naturally, the one thing that stays awake is the toll booth.

## Wake sequence

```text
1. User opens LauncherUrl.
2. Lambda calls ECS UpdateService:
   - ATLAS desiredCount=1
   - WebAPI desiredCount=1
3. Lambda polls ALB target group health.
4. Aurora resumes when WebAPI connects.
5. Lambda returns redirect to /atlas.
```

## Idle shutdown sequence

```text
1. EventBridge invokes idle scaler.
2. Scaler checks recent ALB request counts.
3. If traffic is below threshold for idle window:
   - ATLAS desiredCount=0
   - WebAPI desiredCount=0
4. Databases auto-pause later if idle and supported.
```

## Tuning knobs

| Setting             | Effect                                            |
| ------------------- | ------------------------------------------------- |
| `idleMinutes`       | How long to wait before scaling ECS services down |
| `autoPauseSeconds`  | Aurora idle duration before auto-pause            |
| `webDbMaxAcu`       | Max capacity for WebAPI metadata DB               |
| `omopDbMaxAcu`      | Max capacity for OMOP DB                          |
| ECS task CPU/memory | Startup speed and runtime performance             |
| Health check path   | Determines when launcher considers service ready  |

## Manual wake

Open:

```bash
./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl
```

## Manual sleep

```bash
./scripts/scale-down.sh OhdsiAtlasWebApiStack
```

Or:

```bash
LAUNCHER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)
curl -X POST "$LAUNCHER/sleep"
```

## Cold start expectations

Cold start may include:

* ECS task placement time
* Container pull time
* JVM startup time for WebAPI
* ATLAS startup time
* Aurora resume time
* WebAPI metadata initialization on first launch

For smoother UX:

* Keep the launcher page explicit: “Starting ATLAS/WebAPI.”
* Poll every few seconds.
* Use a generous timeout.
* Redirect only after target groups are healthy.
* Consider a lightweight static loading page in front of the launcher.

## Common scale-to-zero gotchas

| Problem               | Cause                                      | Fix                                                     |
| --------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Launcher times out    | WebAPI JVM or Aurora resume is slow        | Increase launcher timeout, task CPU, or DB min capacity |
| ALB returns 503       | ECS service still at 0 or target unhealthy | Use LauncherUrl first                                   |
| Database never pauses | Connection pool keeps connections open     | Tune WebAPI datasource pool and idle settings           |
| Wakes too often       | Health checks or bots counted as traffic   | Tune idle metric logic                                  |
| Slow image pulls      | Large images or no cache                   | Pin smaller images or use regional ECR mirror           |
| MD                    |                                            |                                                         |

cat > docs/database-and-omop.md <<'MD'

# Database and OMOP Configuration

## Database layout

The stack separates WebAPI metadata from the synthetic OMOP database.

```text
Aurora cluster: WebAPI metadata
  schema: webapi

Aurora cluster: Synthetic OMOP
  schema: cdm_synpuf
  schema: results_synpuf
  schema: temp_synpuf
```

## Schema purposes

| Schema           | Access pattern              | Purpose                                                    |
| ---------------- | --------------------------- | ---------------------------------------------------------- |
| `webapi`         | Read/write by WebAPI        | WebAPI metadata, source definitions, security metadata     |
| `cdm_synpuf`     | Read-only to WebAPI         | OMOP CDM clinical tables and vocabulary tables             |
| `results_synpuf` | Read/write by WebAPI        | Cohort results, characterization results, Achilles outputs |
| `temp_synpuf`    | Create/read/write by WebAPI | Temporary tables during cohort generation                  |

## OHDSI convention

Clinical event and vocabulary tables are treated as CDM-side, read-only analytic inputs. Cohort and result artifacts live in a results schema where WebAPI and tools can write.

That separation matters. Otherwise one cohort-generation bug can start rummaging through your CDM like a raccoon in a medication cabinet.

## OMOP CDM v5.4 notes

The stack targets OMOP CDM-style data. The default synthetic source is CMS DE-SynPUF OMOP.

For strict CDM v5.4 schema fidelity:

1. Use the matching PostgreSQL DDL.
2. Create primary keys and indexes after bulk load when practical.
3. Validate table names and field names against the CDM spec.
4. Run Data Quality Dashboard if this becomes more than a smoke test.

The included SQL Server CDM v5.4 DDL references are useful for field-level checks, but this AWS stack uses PostgreSQL/Aurora unless you intentionally modify it.

## WebAPI source registration

WebAPI discovers CDM sources using metadata rows in the WebAPI schema.

Conceptually:

```text
webapi.source
  source_name
  source_key
  source_connection
  source_dialect

webapi.source_daimon
  daimon_type = 0 -> CDM schema
  daimon_type = 1 -> vocabulary schema
  daimon_type = 2 -> results schema
  daimon_type = 5 -> temp schema
```

Typical mapping:

| Daimon type | Schema           |
| ----------: | ---------------- |
|         `0` | `cdm_synpuf`     |
|         `1` | `cdm_synpuf`     |
|         `2` | `results_synpuf` |
|         `5` | `temp_synpuf`    |

## Result schema initialization

The results schema must contain WebAPI result tables before serious cohort generation and characterization.

Common options:

1. Use WebAPI DDL endpoint after WebAPI starts.
2. Use the init task if it includes result DDL generation.
3. Apply a known compatible results DDL script manually.

Example pattern:

```bash
curl "https://<domain>/WebAPI/ddl/results?dialect=postgresql&schema=results_synpuf&vocabSchema=cdm_synpuf&tempSchema=temp_synpuf&initConceptHierarchy=true" \
  -o results.sql

psql "$OMOP_DATABASE_URL" -f results.sql
```

## Vocabulary placement

For this synthetic sandbox, vocabulary tables can live in the same schema as CDM tables:

```text
cdm_synpuf.concept
cdm_synpuf.concept_ancestor
cdm_synpuf.vocabulary
...
```

For production, vocabulary may be shared across sources if carefully permissioned and versioned.

## Validation SQL

Count key tables:

```sql
SELECT COUNT(*) AS person_count
FROM cdm_synpuf.person;

SELECT COUNT(*) AS concept_count
FROM cdm_synpuf.concept;

SELECT COUNT(*) AS observation_period_count
FROM cdm_synpuf.observation_period;
```

Check source registration:

```sql
SELECT source_id, source_name, source_key, source_dialect
FROM webapi.source;

SELECT source_id, daimon_type, table_qualifier, priority
FROM webapi.source_daimon
ORDER BY source_id, daimon_type;
```

## Production guidance

For real institutional data:

* Do not load PHI into this sandbox.
* Use private networking.
* Use least-privilege DB roles.
* Separate loader and WebAPI service accounts.
* Track CDM version and vocabulary version in `cdm_source`.
* Run DQD and Achilles/ARES.
* Keep source-to-CDM ETL code versioned.
* Record provenance for every data refresh.
  MD

cat > docs/synpuf-loading.md <<'MD'

# Loading CMS DE-SynPUF OMOP

## Dataset

This stack expects synthetic OMOP data from the public AWS Open Data bucket:

```bash
aws s3 ls --no-sign-request s3://synpuf-omop/
```

Choose a prefix after inspecting the bucket. Do not hard-code a guessed path. S3 prefixes are not folklore-proof.

## Recommended load order

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

## Start small

Use the smallest dataset first.

Suggested progression:

```text
1k -> 100k -> full 2.3m
```

This catches:

* IAM failures
* S3 prefix mistakes
* delimiter/header problems
* schema mismatches
* WebAPI source registration problems
* missing result schema tables

## Init task modes

| Mode              | Purpose                                             |
| ----------------- | --------------------------------------------------- |
| `schemas`         | Create WebAPI, CDM, results, and temp schemas       |
| `load-synpuf`     | Load selected SynPUF OMOP files into CDM schema     |
| `register-source` | Insert WebAPI `source` and `source_daimon` metadata |

## Loading behavior

The bootstrap loader should:

1. Download or stream files from public S3.
2. Infer or map table names.
3. Load into `cdm_synpuf`.
4. Preserve headers.
5. Log row counts.
6. Fail loudly on missing required tables.

For serious validation, prefer explicit CDM DDL and typed loading over “create everything as text.”

## Required CDM tables

A minimal useful WebAPI/ATLAS source needs at least:

```text
person
observation_period
visit_occurrence
condition_occurrence
drug_exposure
procedure_occurrence
measurement
concept
concept_ancestor
concept_relationship
vocabulary
domain
concept_class
relationship
```

Additional tables improve functionality.

## Post-load checks

Run counts:

```sql
SELECT 'person' AS table_name, COUNT(*) AS row_count FROM cdm_synpuf.person
UNION ALL
SELECT 'observation_period', COUNT(*) FROM cdm_synpuf.observation_period
UNION ALL
SELECT 'condition_occurrence', COUNT(*) FROM cdm_synpuf.condition_occurrence
UNION ALL
SELECT 'drug_exposure', COUNT(*) FROM cdm_synpuf.drug_exposure
UNION ALL
SELECT 'concept', COUNT(*) FROM cdm_synpuf.concept;
```

Check CDM source metadata:

```sql
SELECT *
FROM cdm_synpuf.cdm_source;
```

Check empty critical tables:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'cdm_synpuf'
ORDER BY table_name;
```

## Common failures

| Symptom                 | Likely cause                                                  | Fix                                                 |
| ----------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| S3 access denied        | Missing `--no-sign-request` or wrong bucket policy assumption | Use public unsigned access                          |
| No files found          | Wrong prefix                                                  | Run `aws s3 ls --no-sign-request s3://synpuf-omop/` |
| Load fails on date      | Wrong delimiter or typed DDL mismatch                         | Inspect file headers and sample rows                |
| ATLAS source missing    | Source not registered or WebAPI not refreshed                 | Run `register-source`, then WebAPI source refresh   |
| Vocabulary search empty | Vocabulary tables missing or wrong daimon type                | Check `concept` and `source_daimon` type 1          |
| Cohort generation fails | Results/temp schema missing permissions                       | Check WebAPI DB user grants                         |

## Reloading

For a full reload:

1. Scale down WebAPI.
2. Truncate or recreate `cdm_synpuf`.
3. Run `schemas`.
4. Run `load-synpuf`.
5. Run `register-source`.
6. Wake WebAPI and refresh sources.

Do not reload while users are generating cohorts unless you enjoy explaining inconsistent counts.
MD

cat > docs/operations.md <<'MD'

# Operations Runbook

## Get stack outputs

```bash
./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl
./scripts/cfn-output.sh OhdsiAtlasWebApiStack AtlasUrl
./scripts/cfn-output.sh OhdsiAtlasWebApiStack WebApiInfoUrl
```

Or inspect all outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name OhdsiAtlasWebApiStack \
  --query "Stacks[0].Outputs"
```

## Describe current state

```bash
./scripts/describe.sh OhdsiAtlasWebApiStack
```

Expected information:

* ECS cluster
* ATLAS service desired/running count
* WebAPI service desired/running count
* ALB URL
* Launcher URL
* database endpoints
* init task definition

## Wake services

Open LauncherUrl in a browser:

```bash
open "$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)"
```

Or with curl:

```bash
curl -i "$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)"
```

## Sleep services

```bash
./scripts/scale-down.sh OhdsiAtlasWebApiStack
```

Or:

```bash
LAUNCHER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack LauncherUrl)
curl -X POST "$LAUNCHER/sleep"
```

## Run init tasks

```bash
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

## View ECS logs

List log groups:

```bash
aws logs describe-log-groups \
  --query "logGroups[?contains(logGroupName, 'ohdsi')].logGroupName"
```

Tail WebAPI logs:

```bash
aws logs tail /aws/ecs/ohdsi-synpuf/webapi --follow
```

Tail ATLAS logs:

```bash
aws logs tail /aws/ecs/ohdsi-synpuf/atlas --follow
```

Actual log group names may vary by `siteName`.

## Check ECS service status

```bash
CLUSTER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack EcsClusterName)
ATLAS_SERVICE=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack AtlasServiceName)
WEBAPI_SERVICE=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack WebApiServiceName)

aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$ATLAS_SERVICE" "$WEBAPI_SERVICE"
```

## Force redeploy service

```bash
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$WEBAPI_SERVICE" \
  --force-new-deployment
```

## Manual scale

Scale up:

```bash
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$WEBAPI_SERVICE" \
  --desired-count 1
```

Scale down:

```bash
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$WEBAPI_SERVICE" \
  --desired-count 0
```

## Database access

Use Secrets Manager to retrieve credentials. Do not paste passwords into shell history.

Recommended pattern:

```bash
aws secretsmanager get-secret-value \
  --secret-id <secret-id> \
  --query SecretString \
  --output text
```

Connect with `psql` from a controlled network path.

## Updating container images

1. Change image tag in CDK context.
2. Run `npx cdk diff`.
3. Deploy.
4. Wake stack.
5. Check `/WebAPI/info`.
6. Run ATLAS smoke test.
7. Scale down.

```bash
npx cdk deploy \
  -c webapiImage=ohdsi/webapi:<new-tag> \
  -c atlasImage=ohdsi/atlas:<new-tag>
```

## Backup posture

For disposable synthetic environments, backups may be minimal.

For anything important:

* Enable automated backups.
* Define retention.
* Snapshot before destructive loads.
* Test restore.
* Track CDM/vocabulary version.

## Cost monitoring

Set AWS Budgets for the account or tagged resources.

Watch:

* ALB hourly cost
* Aurora ACU usage
* CloudWatch log ingestion
* NAT gateway, if you add one
* S3 storage for copied data
* Data transfer

## Decommission

```bash
npx cdk destroy
```

Then check for retained:

* snapshots
* log groups
* hosted zone records
* ECR images
* S3 objects
* Secrets Manager secrets
  MD

cat > docs/security.md <<'MD'

# Security Notes

## Scope

This stack is for synthetic data, development, and ResearchOS/OHDSI integration testing.

It should not be used for PHI without hardening.

## Default security model

```text
User
  -> Cognito login
  -> ALB authenticated route
  -> ATLAS / WebAPI
  -> Aurora
```

The default sandbox relies primarily on ALB/Cognito authentication.

## Important warning

Cognito authentication is not the same as OHDSI authorization.

Authentication answers:

```text
Who are you?
```

Authorization answers:

```text
What are you allowed to do?
```

Those are not the same thing, despite humanity’s recurring attempt to combine them into one checkbox.

## Synthetic data only

The intended dataset is CMS DE-SynPUF OMOP synthetic data.

Do not load:

* PHI
* limited datasets
* re-identifiable patient data
* institutional extracts
* real claims/EHR data

unless the stack has been reviewed and hardened under your institutional policies.

## Secrets

Use AWS Secrets Manager for:

* DB passwords
* app secrets
* Cognito app client secret
* private registry credentials

Never commit secrets to:

* `cdk.json`
* `.env`
* Dockerfiles
* README files
* shell history
* screenshots

## Network posture

Sandbox:

```text
ALB public
ECS tasks controlled by security groups
Aurora accessible only from ECS/init tasks
```

Production preferred:

```text
ALB + WAF
Private ECS subnets
Private Aurora subnets
VPC endpoints
No direct database ingress
Centralized egress control
```

## IAM

Keep IAM permissions scoped.

Launcher Lambda needs:

* `ecs:UpdateService`
* `ecs:DescribeServices`
* target group health read permissions
* log write permissions

Idle scaler needs:

* ECS describe/update permissions
* CloudWatch metric read permissions
* log write permissions

Init task needs:

* S3 read for SynPUF
* Secrets Manager read for DB credentials
* network access to DB
* log write permissions

## WebAPI authorization

For production, configure one of:

| Pattern            | Notes                                         |
| ------------------ | --------------------------------------------- |
| WebAPI native OIDC | WebAPI/ATLAS understand user identity         |
| ResearchOS broker  | Preferred for project/data-product governance |
| ALB auth only      | Sandbox perimeter protection only             |

## Logging

CloudWatch logs should not contain:

* patient identifiers
* query results with small cells
* database passwords
* JWTs
* Cognito tokens
* source connection strings with credentials

## Hardening checklist

Before production:

* [ ] Use private subnets for ECS tasks.
* [ ] Add WAF to ALB.
* [ ] Enforce HTTPS only.
* [ ] Restrict outbound traffic.
* [ ] Add VPC endpoints for ECR, CloudWatch Logs, Secrets Manager, S3.
* [ ] Pin container image tags.
* [ ] Enable image scanning.
* [ ] Configure WebAPI-native security or ResearchOS broker.
* [ ] Enable CloudTrail.
* [ ] Set CloudWatch alarms.
* [ ] Set AWS Budgets.
* [ ] Review IAM least privilege.
* [ ] Enable database backups and snapshot policy.
* [ ] Use separate DB users for load and runtime.
* [ ] Run Data Quality Dashboard.
* [ ] Document CDM and vocabulary versions.
* [ ] Define minimum cell count and export policy.
* [ ] Review with institutional security/compliance.
  MD

cat > docs/troubleshooting.md <<'MD'

# Troubleshooting

## Quick diagnostic commands

```bash
./scripts/describe.sh OhdsiAtlasWebApiStack

aws cloudformation describe-stacks \
  --stack-name OhdsiAtlasWebApiStack \
  --query "Stacks[0].StackStatus"

CLUSTER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack EcsClusterName)
aws ecs list-services --cluster "$CLUSTER"
```

## Symptoms and fixes

| Symptom                      | Likely cause                                       | Fix                                                       |
| ---------------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| Launcher waits forever       | ECS task slow, image pull slow, Aurora resume slow | Increase timeout, increase task CPU, check ECS events     |
| ALB returns 503              | Target group has no healthy tasks                  | Use LauncherUrl first; check ECS desired/running count    |
| Cognito redirect loop        | Callback/logout URL mismatch                       | Check ALB callback URL and Cognito app client settings    |
| Cognito 500 from ALB         | HTTPS/listener/domain config issue                 | Verify ACM cert, domain, app client secret, callback URL  |
| ATLAS loads but WebAPI fails | ATLAS WebAPI URL mismatch or WebAPI unhealthy      | Check ATLAS config and `/WebAPI/info`                     |
| `/WebAPI/info` 502           | WebAPI task crashed or DB unavailable              | Tail WebAPI logs; check DB secret and SG                  |
| Source not visible in ATLAS  | WebAPI source metadata missing                     | Run `register-source`, refresh WebAPI source cache        |
| Vocabulary search empty      | Vocabulary tables missing or daimon type wrong     | Check `concept`, `concept_ancestor`, source_daimon type 1 |
| Cohort generation fails      | Results/temp schema missing or no grants           | Initialize result schema and grants                       |
| Init task cannot reach DB    | Security group/subnet/routing issue                | Check task subnet and DB inbound SG                       |
| S3 load finds no files       | Wrong SynPUF prefix                                | Run `aws s3 ls --no-sign-request s3://synpuf-omop/`       |
| Aurora never pauses          | Active connections remain                          | Tune connection pools and idle scaler timing              |
| CDK synth fails              | Missing context                                    | Add required `-c` values                                  |
| Docker build fails           | Docker not running                                 | Start Docker Desktop or daemon                            |

## ECS task fails immediately

Check service events:

```bash
CLUSTER=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack EcsClusterName)
WEBAPI_SERVICE=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack WebApiServiceName)

aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$WEBAPI_SERVICE" \
  --query "services[0].events[0:10]"
```

Check stopped task reason:

```bash
aws ecs list-tasks \
  --cluster "$CLUSTER" \
  --desired-status STOPPED

aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks <task-arn>
```

## WebAPI cannot connect to database

Check:

* Secret value is valid.
* JDBC URL uses the correct endpoint.
* DB security group allows inbound from WebAPI task SG.
* DB is not deleted or paused beyond connection timeout.
* WebAPI has the expected schema permissions.

## ATLAS cannot reach WebAPI

Check browser network tab.

Common issues:

```text
Wrong WebAPI URL
Missing trailing slash
ALB auth redirecting API call unexpectedly
CORS mismatch
WebAPI unhealthy
Path rule not matching /WebAPI/*
```

## WebAPI source registration check

Connect to WebAPI metadata DB:

```sql
SELECT source_id, source_name, source_key, source_dialect
FROM webapi.source;

SELECT source_id, daimon_type, table_qualifier, priority
FROM webapi.source_daimon
ORDER BY source_id, daimon_type;
```

Expected daimons:

```text
0 -> cdm_synpuf
1 -> cdm_synpuf
2 -> results_synpuf
5 -> temp_synpuf
```

## OMOP data check

```sql
SELECT COUNT(*) FROM cdm_synpuf.person;
SELECT COUNT(*) FROM cdm_synpuf.observation_period;
SELECT COUNT(*) FROM cdm_synpuf.concept;
SELECT COUNT(*) FROM cdm_synpuf.concept_ancestor;
```

If `person` has rows but `concept` does not, many ATLAS features will look broken.

## Cognito checklist

Verify:

* User pool domain exists.
* App client has a client secret if ALB requires one.
* Authorization code flow is enabled.
* Scopes include `openid`.
* Callback URL includes `/oauth2/idpresponse`.
* Logout URL matches your domain.
* ALB listener is HTTPS.
* ACM certificate is valid in the same region as ALB.

## Reset sandbox

For a synthetic disposable environment:

```bash
./scripts/scale-down.sh OhdsiAtlasWebApiStack
./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas
./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf
./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source
```

Then wake through the launcher.
MD

cat > docs/operations-checklist.md <<'MD'

# Operations Checklist

Use this before declaring the environment usable. Humanity loves a launch party before the thing works. Resist.

## Deployment checklist

* [ ] `npm install` completed.
* [ ] `npx cdk synth` completed.
* [ ] `npx cdk diff` reviewed.
* [ ] `npx cdk deploy` completed.
* [ ] Stack outputs saved.
* [ ] Cognito test user created.
* [ ] Schemas initialized.
* [ ] SynPUF loaded.
* [ ] WebAPI source registered.
* [ ] Launcher wakes services.
* [ ] ATLAS login works.
* [ ] `/WebAPI/info` returns success.
* [ ] SynPUF source appears in ATLAS.
* [ ] Vocabulary search works.
* [ ] Simple cohort generation works.
* [ ] Manual scale-down works.
* [ ] Idle scale-down works.
* [ ] Aurora auto-pause verified if expected.
* [ ] Budget alarm configured.

## Smoke test cohort

In ATLAS:

1. Create a new cohort definition.
2. Use a simple condition occurrence or drug exposure concept set.
3. Generate against SynPUF.
4. Confirm counts appear.
5. Check Jobs page for successful generation.

## Post-load validation

```sql
SELECT COUNT(*) AS persons
FROM cdm_synpuf.person;

SELECT COUNT(*) AS concepts
FROM cdm_synpuf.concept;

SELECT COUNT(*) AS obs_periods
FROM cdm_synpuf.observation_period;
```

## Source registration validation

```sql
SELECT source_name, source_key, source_dialect
FROM webapi.source;

SELECT daimon_type, table_qualifier
FROM webapi.source_daimon
ORDER BY daimon_type;
```

## Cost check

Review:

* ALB running
* ECS tasks at 0 when idle
* Aurora paused when idle
* CloudWatch log growth
* NAT gateway absent unless intentionally added
  MD

echo "Wrote docs/*.md"
