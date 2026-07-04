
# Deployment Guide

## Prerequisites

Install locally:

```bash
node --version
pnpm --version
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
export AWS_REGION=ap-southeast-1

aws sts get-caller-identity
```

## 1. Install dependencies

From the project root:

```bash
pnpm install
```

## 2. Check Aurora PostgreSQL versions

Aurora Serverless v2 scale-to-zero support depends on region and engine version.

```bash
./scripts/list-aurora-versions.sh ap-southeast-1
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
pnpm exec cdk synth \
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
pnpm exec cdk synth \
  -c siteName=ohdsi-synpuf-dev \
  -c enableAlbCognitoAuth=false \
  -c cognitoDomainPrefix=ohdsi-synpuf-dev-auth-123456
```

The second option is for isolated sandbox use only.

## 5. Bootstrap and deploy

```bash
pnpm exec cdk bootstrap
pnpm exec cdk diff
pnpm exec cdk deploy
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
pnpm exec cdk destroy
```

Check retained resources manually if you changed removal policies.
