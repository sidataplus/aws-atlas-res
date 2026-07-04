# ap-southeast-1 OHDSI ATLAS/WebAPI Deployment

This is the deployment and respawn path for account `248189943046`, region `ap-southeast-1`.

As of `2026-07-04`, the live ATLAS/WebAPI and RES demo stacks have been fully torn down for cost control. The reusable deployment records remain here so the environment can be recreated later with fresh stack outputs, IPs, secrets, and load balancer hostnames.

## Current Targets

* ATLAS/WebAPI domain: `ohdsi.research.sidata.plus`
* Route53 hosted zone: `research.sidata.plus`
* Hosted zone ID: `Z07193262KF170QB7THGG`
* Downstream RES domains in the same hosted zone: `res.research.sidata.plus`, `vdi.research.sidata.plus`
* Cognito domain prefix: `ohdsi-synpuf-auth-248189943046-sg1`
* SynPUF prefix: `s3://synpuf-omop/cmsdesynpuf1k/`
* Aurora PostgreSQL engine: `16.6`
* NAT gateways: `1`, required for the private RES subnets to reach bootstrap artifacts and AWS APIs

## DNS Delegation Gate

The parent domain `sidata.plus` is hosted in Cloudflare. Before deploying the certificate-backed stack, add NS records for `research.sidata.plus` at the parent zone:

```text
ns-1905.awsdns-46.co.uk
ns-580.awsdns-08.net
ns-1465.awsdns-55.org
ns-413.awsdns-51.com
```

Verify public delegation before deploy:

```bash
dig +short NS research.sidata.plus
```

Do not deploy the HTTPS stack until those four nameservers resolve publicly; ACM DNS validation depends on that delegation.

## Commands

```bash
export CDK_DEFAULT_ACCOUNT=248189943046
export CDK_DEFAULT_REGION=ap-southeast-1
export AWS_REGION=ap-southeast-1
export AWS_DEFAULT_REGION=ap-southeast-1

pnpm install
pnpm test
pnpm run build

pnpm exec cdk synth \
  -c siteName=ohdsi-synpuf \
  -c domainName=ohdsi.research.sidata.plus \
  -c hostedZoneId=Z07193262KF170QB7THGG \
  -c hostedZoneName=research.sidata.plus \
  -c cognitoDomainPrefix=ohdsi-synpuf-auth-248189943046-sg1 \
  -c auroraPostgresEngineVersion=16.6 \
  -c autoPauseSeconds=900 \
  -c natGateways=1 \
  -c webDbMaxAcu=2 \
  -c omopDbMaxAcu=8 \
  -c synpufS3Uri=s3://synpuf-omop/cmsdesynpuf1k/
```

Use the same context for `cdk diff` and `cdk deploy`. Do not rely on the placeholder defaults in `cdk.json` for this live stack.

If the AWS CLI is authenticated but CDK cannot see credentials, export short-lived credentials inside the shell before `cdk diff` or `cdk deploy`:

```bash
eval "$(aws configure export-credentials --format env)"
```

## Post-Deploy Order

1. Save CloudFormation outputs.
2. Create Cognito user `max@sidata.plus`.
3. Run `./scripts/run-init-task.sh OhdsiAtlasWebApiStack schemas`.
4. Wake ATLAS/WebAPI once from `LauncherUrl`.
5. Run `./scripts/run-init-task.sh OhdsiAtlasWebApiStack load-synpuf`.
6. Run `./scripts/run-init-task.sh OhdsiAtlasWebApiStack register-source`.
7. Verify ATLAS login, `/WebAPI/info`, SynPUF source visibility, vocabulary search, and a simple cohort.

## Lessons Learned During ap-southeast-1 Bring-Up

* CDK commands may need explicit exported credentials even when `aws sts get-caller-identity` works. Use `eval "$(aws configure export-credentials --format env)"` in the same shell before `pnpm exec cdk diff` or `pnpm exec cdk deploy`.
* On Apple Silicon builders, Docker assets used by Fargate must be built for `linux/amd64`. The init runner asset is pinned to that platform to avoid `exec format error`.
* WebAPI 2.14 must receive the metadata schema through unambiguous Spring Boot configuration. The stack sets `SPRING_APPLICATION_JSON` so Hibernate and Flyway both use `webapi`; otherwise WebAPI can boot against the default `ohdsi` schema and fail on `relation "ohdsi.source" does not exist`.
* The public `s3://synpuf-omop/cmsdesynpuf1k/` prefix stores the 1k files as `*.csv.bz2`. The init runner supports `.csv.bz2`, `.txt.bz2`, and `.tsv.bz2` in addition to gzip/plain delimited files.
* `register-source` uses separate parameterized statements. Psycopg 3 rejects multiple SQL commands in one prepared statement, so deletes and inserts are executed separately.
* The init helper prints the ECS container exit code, but a non-zero exit does not currently make the shell script fail. Always inspect the exit code table and CloudWatch init log stream after `load-synpuf` or `register-source`.
* Cognito users created with temporary passwords remain in `FORCE_CHANGE_PASSWORD`. In browser testing, a wrong copied password reports `Incorrect username or password`, while a correct temporary password can fall into Cognito Hosted UI's generic `Error in authentication` path for the ALB/OAuth flow. Do not treat that as an ECS/WebAPI outage; inspect the Cognito user state before changing account credentials.
* The ATLAS invitation sentence ended with punctuation after the temporary password. For this deployment, the final period was not part of the password; using the password without the period reached the Cognito `Change Password` challenge for user `max`.
* The launcher `wake` endpoint can restore scale-to-zero services without an ECS redeploy. After waking, check launcher `/status`, ECS service events, and the WebAPI log group before debugging ALB/Cognito.
* The idle scaler must count ALB-level requests, not only ATLAS/WebAPI target-group requests. Cognito Hosted UI login, ALB authentication, and cold-start 503 checks can create real user activity before either target group has a `RequestCount`; if the scheduled scaler sees only target-group metrics, it can scale services back to zero while a user is completing login.
* A live-stack CDK diff must include `hostedZoneId`, `hostedZoneName`, `domainName`, the deployed Cognito domain prefix, the SynPUF prefix, and `natGateways=1`. Omitting `hostedZoneId` makes the stack synthesize the non-custom-domain path, which proposes deleting the ACM certificate, HTTPS listener, Route53 alias, and Cognito callback/logout URLs. Abort any diff that is not limited to the intended resources.
* The 503 observed after completing Cognito password change was caused by scale-to-zero, not by Cognito. Launcher `/status` showed both ECS services at desired count `0` and no healthy targets. A wake fixed the immediate 503, but the scheduled idle scaler then raced cold start until it was patched to include ALB-level `RequestCount`.
* After WebAPI comes up, ATLAS can keep displaying `Application initialization failed` from an earlier failed initialization attempt. Verify `/WebAPI/info` in the authenticated browser session, then hard navigate back to `https://ohdsi.research.sidata.plus/atlas/#/home`; the Home page should show ATLAS and WebAPI `2.14.0` release notes.
* `Data Sources` showing `CMS DE-SynPUF OMOP` proves source registration is visible through WebAPI. `Error loading report` on the source dashboard is separate from base access and usually means Achilles/report artifacts have not been loaded for that source yet.
* After the user completed the Cognito password challenge, Cognito user `max` was `CONFIRMED` and enabled. Browser verification reached `https://ohdsi.research.sidata.plus/atlas/#/home` with no visible error alerts and showed both ATLAS and WebAPI `2.14.0` release notes.
* RES private subnet IDs must be real egress subnets. During bring-up, the ATLAS VPC created `private-res-egress` subnets with `natGateways=0`; they were tagged private but had only local routes. RES EC2 instances launched and passed EC2 checks, but `/cluster-manager/*` and `/vdc/*` target groups failed because bootstrap could not reach S3, DynamoDB, Secrets Manager, SSM, CloudWatch, or package repositories. Keep `natGateways=1` for shared RES deployments unless equivalent VPC endpoints and artifact access are in place.
* Keep ATLAS and RES CDK commands pinned to `ap-southeast-1` in the same shell. During RES follow-up, an ambient `AWS_REGION=ap-southeast-7` made CDK synthesize asset URLs and policy ARNs for the wrong region before deploy; abort any synth/diff with a region mismatch.
* The shared `research.sidata.plus` hosted zone now carries separate HTTPS names for ATLAS, RES Web UI, and RES VDI/DCV. ATLAS uses ACM on its ALB, RES Web UI uses ACM on its ALB, and RES VDI/DCV needs an exportable certificate/key in Secrets Manager because the VDC external NLB is TCP pass-through to the DCV gateway.

## Full Cost Teardown on 2026-07-04

The cost-control teardown removed the live stack rather than only scaling services to zero:

* Deleted downstream `ResearchOsResStack` first so shared-VPC dependencies were removed before ATLAS networking.
* Deleted `OhdsiAtlasWebApiStack` after RES completed.
* Verified no active ELBv2 load balancers, NAT gateways, Elastic IPs, EC2 instances, EBS volumes, RDS DB instances, or RDS DB clusters remain in `ap-southeast-1`.
* Verified NAT gateway `nat-0d17a4b00984b52d4` and public IP `13.213.178.40` were deleted.
* Deleted orphaned RES security group `sg-0e2f1fd961b9a2822` (`res-ohdsi-shared-storage-security-group`) after it blocked final ATLAS VPC deletion.
* Verified only `CDKToolkit` remains as an active CloudFormation stack.

CloudFormation retained Cognito user pool `ap-southeast-1_pDv0OTSbC` (`ohdsi-synpuf-users`) because the stack marked it `DELETE_SKIPPED`. It is not a networking cost, but future deploys should treat this as stale identity state unless intentionally reused.

Route53 hosted zone `research.sidata.plus` remains delegated with these records only:

* zone `NS` and `SOA`
* ACM validation CNAME for `ohdsi.research.sidata.plus`
* ACM validation CNAME for `res.research.sidata.plus`

The stale `vdi.research.sidata.plus` CNAME that pointed at deleted NLB `res-ohdsi-vdc-external-nlb-0417460f5ab9f442.elb.ap-southeast-1.amazonaws.com` was removed and the Route53 change reached `INSYNC`.

RDS created two final manual cluster snapshots during delete:

* `ohdsiatlaswebapistack-snapshot-syntheticomopdbcluster-vylxed9aqw33`
* `ohdsiatlaswebapistack-snapshot-webapimetadatadbcluster-8diexaflnkft`

Both snapshots reported `AllocatedStorage=0` at teardown. Do not delete snapshots without explicit approval because snapshot deletion is irreversible.

Approximate remaining monthly cost after teardown is about `$0.55/month`, dominated by the public Route53 hosted zone. Other retained artifacts are tiny: CDK bootstrap S3 assets are about `2.4 MB`, CDK ECR image assets are about `365 MB`, retained CloudWatch logs are only a few MB, and the retained RES EFS file system has `24,576` bytes.

To respawn ATLAS/WebAPI, use the commands in this document as a fresh deployment. Preserve the same hosted zone if it is still delegated; otherwise recreate the hosted zone and update parent DNS before deploying certificate-backed resources. After ATLAS deploy completes, rerun the init tasks and regenerate RES context from the new CloudFormation outputs.

## Last Verified Deployed State Before Teardown

Before the `2026-07-04` cost teardown, the ATLAS/WebAPI stack was deployed in `ap-southeast-1` with Cognito-protected HTTPS and a shared VPC shape suitable for the downstream RES stack.

Key CloudFormation outputs to preserve for RES and operations:

* `LauncherUrl`: `https://7ihy0jb6lc.execute-api.ap-southeast-1.amazonaws.com`
* `AtlasUrl`: `https://ohdsi.research.sidata.plus/atlas/`
* `WebApiInfoUrl`: `https://ohdsi.research.sidata.plus/WebAPI/info`
* `CognitoUserPoolId`: `ap-southeast-1_pDv0OTSbC`
* `CognitoUserPoolDomainUrl`: `https://ohdsi-synpuf-auth-248189943046-sg1.auth.ap-southeast-1.amazoncognito.com`
* `VpcId`, `VpcCidr`, `AvailabilityZones`, `PublicSubnetIds`, and `PrivateSubnetIds` for RES context generation
* `OmopDbEndpoint`, `WebDbEndpoint`, `OmopDbSecretArn`, `WebApiDbSecretArn`, and `OmopDbSecurityGroupId`

Post-deploy verification completed during bring-up:

* CloudFormation reached a complete state after the scale-to-zero Lambda update.
* Cognito user `max` is `CONFIRMED` and enabled after the user completed the first-login password challenge.
* Launcher `/status` reported both ECS services active, ATLAS desired/running count `1/1`, WebAPI desired/running count `1/2`, and all ALB targets healthy.
* Browser verification reached the ATLAS Home route at `https://ohdsi.research.sidata.plus/atlas/#/home` and showed ATLAS `2.14.0` and WebAPI `2.14.0` release notes with no visible error alerts.
* The ATLAS Data Sources page listed `CMS DE-SynPUF OMOP`, confirming the SynPUF source registration is visible through WebAPI.

## Post-Deploy Checks

* Use launcher `/status` as the first health check after idle periods; it gives ECS service counts and target-group health in one place.
* If the browser returns `503` after Cognito login, call launcher `wake`, wait for healthy targets, and inspect the idle scaler logs before redeploying.
* If ATLAS shows stale initialization errors while `/WebAPI/info` works, hard navigate to `https://ohdsi.research.sidata.plus/atlas/#/home` or clear the browser session.
* Treat `Error loading report` on the SynPUF source dashboard as an Achilles/report-artifact gap unless source registration, vocabulary search, or WebAPI health checks are also failing.
* Keep every live `cdk diff` and `cdk deploy` pinned to the current custom-domain context; context omissions can synthesize destructive-looking changes unrelated to the intended update.
