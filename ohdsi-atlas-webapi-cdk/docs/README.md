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
pnpm install

./scripts/list-aurora-versions.sh us-east-1

aws s3 ls --no-sign-request s3://synpuf-omop/

pnpm exec cdk bootstrap

pnpm exec cdk deploy \
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
