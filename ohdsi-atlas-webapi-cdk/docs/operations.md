
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
2. Run `pnpm exec cdk diff`.
3. Deploy.
4. Wake stack.
5. Check `/WebAPI/info`.
6. Run ATLAS smoke test.
7. Scale down.

```bash
pnpm exec cdk deploy \
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
pnpm exec cdk destroy
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
| 503 returns during login     | Idle scaler missed ALB auth/cold-start activity    | Confirm scaler counts ALB-level `RequestCount`            |
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
