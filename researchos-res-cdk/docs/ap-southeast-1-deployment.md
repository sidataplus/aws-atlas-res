# ap-southeast-1 RES Deployment

This RES stack is intended to deploy after `OhdsiAtlasWebApiStack` completes in account `248189943046`, region `ap-southeast-1`.

As of `2026-07-04`, the live RES and ATLAS demo stacks have been fully torn down for cost control. This document preserves the deployment record, fixes, and respawn path; any future demo should be treated as a fresh deploy with new stack outputs, IPs, secrets, and load balancer hostnames.

## Current Targets

* RES environment name: `res-ohdsi`
* Administrator email: `max@sidata.plus`
* EC2 key pair name: `res-ohdsi-ap-southeast-1`
* RES Web UI domain: `res.research.sidata.plus`
* RES VDI/DCV domain: `vdi.research.sidata.plus`
* Local private key path: `temp/res-ohdsi-ap-southeast-1.pem`
* Temporary RES client CIDR: `0.0.0.0/0`
* Shared data prefix: `/researchos/shared`

The client CIDR is intentionally temporary for bring-up and should be narrowed after access is verified.

## Prerequisites

ATLAS/WebAPI must be deployed first and must output these values:

* `CognitoUserPoolId`
* `CognitoUserPoolDomainUrl`
* `AtlasUrl`
* `WebApiInfoUrl`
* `VpcId`
* `VpcCidr`
* `AvailabilityZones`
* `PublicSubnetIds`
* `PrivateSubnetIds`
* `OmopDbEndpoint`
* `WebDbEndpoint`
* `OmopDbSecretArn`
* `WebApiDbSecretArn`
* `OmopDbSecurityGroupId`

## Commands

```bash
export CDK_DEFAULT_ACCOUNT=248189943046
export CDK_DEFAULT_REGION=ap-southeast-1
export AWS_REGION=ap-southeast-1
export AWS_DEFAULT_REGION=ap-southeast-1

pnpm install
pnpm run build

./scripts/atlas-outputs-to-context.sh OhdsiAtlasWebApiStack cdk.context.local.json
cat cdk.context.local.json
```

Review the generated context and deploy with the generated values plus RES-specific context:

```bash
eval "$(aws configure export-credentials --format env)"

pnpm exec cdk synth \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c customDomainNameForWebApp=res.research.sidata.plus \
  -c customDomainNameForVdi=vdi.research.sidata.plus \
  -c certificateSecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-certificate-SbrwQi \
  -c privateKeySecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-private-key-H8l75U \
  -c hostedZoneId=Z07193262KF170QB7THGG \
  -c hostedZoneName=research.sidata.plus

pnpm exec cdk diff \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c customDomainNameForWebApp=res.research.sidata.plus \
  -c customDomainNameForVdi=vdi.research.sidata.plus \
  -c certificateSecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-certificate-SbrwQi \
  -c privateKeySecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-private-key-H8l75U \
  -c hostedZoneId=Z07193262KF170QB7THGG \
  -c hostedZoneName=research.sidata.plus

pnpm exec cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c customDomainNameForWebApp=res.research.sidata.plus \
  -c customDomainNameForVdi=vdi.research.sidata.plus \
  -c certificateSecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-certificate-SbrwQi \
  -c privateKeySecretArnForVdi=arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:res-ohdsi-vdi-research-sidata-plus-private-key-H8l75U \
  -c hostedZoneId=Z07193262KF170QB7THGG \
  -c hostedZoneName=research.sidata.plus
```

If the account/region Lambda API rejects the upstream RES backend Lambda memory size or Lambda reserved concurrency settings, generate and use a local patched RES template asset:

```bash
./scripts/patch-res-template-for-lambda-memory.sh \
  https://research-engineering-studio-us-east-1.s3.amazonaws.com/releases/latest/ResearchAndEngineeringStudio.template.json \
  ../temp/ResearchAndEngineeringStudio.lambda-memory-3008.template.json

pnpm exec cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c resTemplatePath=../temp/ResearchAndEngineeringStudio.lambda-memory-3008.template.json
```

If the RES finalizer fails while creating `clusteradmin` because the generated temporary password is shorter than the shared ATLAS Cognito pool policy, patch the finalizer nested template and point the top-level RES template at it. Keep the patched Lambda zip and nested template in the CDK bootstrap bucket so CloudFormation can fetch them:

```bash
curl -fsSL \
  https://s3.ap-southeast-1.amazonaws.com/research-engineering-studio-ap-southeast-1/releases/2026.06/140a8866abcdac6b172f4b3deff7213ce205c8aeaf0e208f74408852b17b0d61 \
  -o ../temp/resfinalizer.2026-06.template.json

curl -fsSL \
  https://s3.ap-southeast-1.amazonaws.com/research-engineering-studio-ap-southeast-1/releases/2026.06/f1a0522405a64798b311d5a4c3750c6f881ebdd94c98afa41667ac6df9e109ce.zip \
  -o ../temp/resfinalizer-ddb-populator.2026-06.zip

# Patch handler.py so the TemporaryPassword appends an additional random value plus Aa1!.
# Re-zip and upload the patched zip and nested template to:
# s3://cdk-hnb659fds-assets-248189943046-ap-southeast-1/res-patches/

pnpm exec cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c resTemplatePath=../temp/ResearchAndEngineeringStudio.apse1-patched.template.json
```

If the first RES create rolls back after the wrapper-created EFS file system is retained, verify whether the retained file system has mount targets. If it has no mount targets, reuse the retained file system and have the wrapper recreate mount targets in the private subnets:

```bash
aws efs describe-mount-targets \
  --region ap-southeast-1 \
  --file-system-id fs-xxxxxxxxxxxxxxxxx

pnpm exec cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail=max@sidata.plus \
  -c sshKeyPair=res-ohdsi-ap-southeast-1 \
  -c clientIp=0.0.0.0/0 \
  -c createEfs=false \
  -c efsFileSystemId=fs-xxxxxxxxxxxxxxxxx \
  -c createEfsMountTargets=true \
  -c resTemplatePath=../temp/ResearchAndEngineeringStudio.lambda-memory-3008.template.json
```

## Lessons Learned During ap-southeast-1 Bring-Up

* `atlas-outputs-to-context.sh` must map ATLAS `WebApiDbSecretArn` to RES `webDbSecretArn`; the older `WebDbSecretArn` spelling leaves the value blank.
* Keep generated context and downloaded/derived templates under repo `temp/`, not `/tmp`, so deployment evidence stays together and follows the repo instructions.
* The upstream RES template requires exact parameter names. Use `ClientIp`, `SharedHomeFileSystemId`, and `DomainTLSCertificateSecretArn`; older spellings such as `ClientIP`, `SharedHomeFilesystemID`, and `DomainTLSCertificateSecretARN` are rejected or ignored.
* The upstream RES template requires optional parameters to be present even when empty, including AD, proxy, custom-domain, and prefix-list fields.
* RES boolean casing is mixed: `IsLoadBalancerInternetFacing` expects lowercase `true`/`false`, while `EnableLdapIDMapping` and `DisableADJoin` expect `True`/`False`.
* `IAMResourcePath=/` fails the upstream constraint. The wrapper defaults to `/res/`.
* In this account/region, the upstream RES backend Lambda `MemorySize: 4096` was rejected with `Member must have value less than or equal to 3008`. The local patched template caps Lambda memory values above the limit to `3008`.
* The account's Lambda concurrent-executions quota in `ap-southeast-1` was `10`, and AWS requires at least `10` unreserved executions. The upstream template reserves concurrency for two Cognito-related Lambdas, which fails with `decreases account's UnreservedConcurrentExecution below its minimum value of [10]`. The local patched template removes `ReservedConcurrentExecutions`.
* ATLAS uses a Cognito minimum password length of `14`. The upstream RES finalizer Lambda calls `auth_utils.generate_password()` for the `clusteradmin` temporary password, which can be too short and fail with `Password not long enough`. Patch the finalizer Lambda to append a second generated password and `Aa1!`, then patch the finalizer nested template URL in the top-level RES template.
* After a nested RES stack failure, wait for the parent `ResearchOsResStack` rollback to reach `ROLLBACK_COMPLETE` before retrying with a patched template; CloudFormation will reject updates while rollback is still in progress.
* The wrapper-created EFS file system uses `RemovalPolicy.RETAIN`. If a create rolls back, CloudFormation can leave an EFS file system with deleted mount targets. Prefer reusing it with `createEfs=false`, `efsFileSystemId=...`, and `createEfsMountTargets=true` instead of creating an orphaned second file system.
* The upstream RES shared-storage stack uses fixed security group names. A failed rollback left `res-ohdsi-shared-storage-security-group` tagged to an earlier deleted nested stack. Verify it has no ENIs before deleting the orphan; otherwise the next deploy fails with `Security Group with res-ohdsi-shared-storage-security-group already exists`.
* The default RES external ALB uses an imported self-signed certificate for `res-ohdsi.idea.default`. Browser verification against the raw `*.elb.amazonaws.com` hostname fails with `ERR_CERT_AUTHORITY_INVALID`; use `customDomainNameForWebApp`, a Route53 hosted zone, and an ACM certificate for real browser testing.
* The RES VDI/DCV Connect button is separate from the Web UI ALB. It opens the VDC external NLB path, where TLS is served by the DCV connection gateway behind a TCP listener. ACM on the Web UI ALB does not fix DCV browser TLS. Configure `CustomDomainNameforVDI` plus `CertificateSecretARNforVDI` and `PrivateKeySecretARNforVDI`, and create a DNS record such as `vdi.research.sidata.plus -> res-ohdsi-vdc-external-nlb-0417460f5ab9f442.elb.ap-southeast-1.amazonaws.com`.
* Public ACM certificates are not exportable, so the VDI/DCV gateway needs a certificate/key pair from an exportable public-certificate workflow. For this validation deployment, `uvx --with certbot-dns-route53 --with 'botocore[crt]' certbot certonly --dns-route53 -d vdi.research.sidata.plus ...` issued a Let's Encrypt certificate, saved under `temp/letsencrypt/`, expiring on `2026-10-02`.
* Store the VDI certificate chain and private key in two Secrets Manager secrets and pass their ARNs to RES. Do not document or commit the private key contents. Plan renewal before the certificate expiry date and update both Secrets Manager versions plus the gateway if the secret ARNs change.
* The RES-generated DCV launch URL can still appear as the raw VDC external NLB hostname and includes a short-lived `authToken` query parameter. Treat that token as a bearer secret: do not paste it into docs, commits, logs, or screenshots. For custom-domain validation, preserve only the session fragment and use the `vdi.research.sidata.plus` hostname instead of the raw `*.elb.ap-southeast-1.amazonaws.com` hostname.
* When the wrapper diff proposes unrelated EFS or mount-target replacement, do not deploy it as part of a VDI TLS fix. A safer live fix is a nested product-stack update with `--use-previous-template`, `UsePreviousValue` for all existing parameters, and explicit values only for `CustomDomainNameforVDI`, `CertificateSecretARNforVDI`, and `PrivateKeySecretARNforVDI`.
* Updating the VDI/DCV custom-domain certificate rolls the `dcvconnectiongatewayasg` and CloudFormation intentionally pauses for `PT25M` after adding a replacement gateway instance. Expect the VDC nested stack to remain `UPDATE_IN_PROGRESS` during that bake.
* The RES wrapper cannot read the cluster external ALB DNS name through `ResearchEngineeringStudioProductStack` outputs because the value is produced one nested stack deeper. Use the wrapper's ELBv2 lookup custom resource for the public Web UI CNAME instead of referencing a grandchild nested-stack output.
* The upstream external ALB default action can remain a fixed JSON `{"success":true,"message":"OK"}` response even after the RES services are healthy. The invitation URL points at the ALB root, while cluster-manager serves web resources from `/`; the wrapper therefore adds a managed low-priority `/*` listener rule that forwards browser root/static requests to the cluster-manager target group without stealing the higher-priority `/cluster-manager/*`, `/vdc/*`, `/awsproxy/*`, or `/res/*` routes.
* A long RES deployment can outlive local AWS session credentials. If CDK monitoring stops with `ExpiredToken`, refresh credentials and check CloudFormation directly; the stack may still be running.
* On this workstation, an ambient `AWS_REGION=ap-southeast-7` caused CDK to synthesize/diff against the wrong region until `CDK_DEFAULT_REGION`, `AWS_REGION`, and `AWS_DEFAULT_REGION` were all pinned to `ap-southeast-1` in the same shell.
* The wrong-region problem can appear even during `cdk synth`: S3 asset URLs, IAM policy ARNs, and DynamoDB/SSM ARNs rendered with `ap-southeast-7`. Abort any synth/diff showing the wrong region before deploy.
* `privateSubnetIds`, `infrastructureHostSubnetIds`, and `vdiSubnetIds` must be private subnets with real outbound egress. RES EC2 hosts need S3, DynamoDB, Secrets Manager, SSM, CloudWatch, package repositories, and release artifact access during bootstrap. If the shared ATLAS VPC private subnet route tables contain only the local VPC route, EC2 status checks can pass while the RES ALB target groups remain unhealthy on `/healthcheck`.
* The `clusteradmin` invitation email rendered the temporary password in a blockquote. In this deployment, the leading `>` character was part of the actual password; omitting it produced `Error in authenticating given username/password combination`, while including it reached the required `Change Password` challenge.
* A healthy RES ALB target group is necessary but not sufficient for browser readiness. Verify all three layers: CloudFormation stack status, target health for cluster-manager and VDC, and the browser route at `https://res.research.sidata.plus/`.
* After the wrapper-managed `/*` listener rule is deployed, the RES root should render the React Web UI login route, not the upstream fixed JSON `{"success":true,"message":"OK"}` response. If root returns JSON, inspect the external HTTPS listener for the low-priority `/*` forward rule to `res-ohdsi-cm-ext-ae72f4e0`.
* Browser sessions are separate. Seeing the RES login form in the Codex in-app browser means that browser has no active RES session; it does not contradict healthy RES infrastructure. Complete the `clusteradmin` password challenge in the same browser before using the browser as proof of authenticated RES access.
* Do not treat forced password-change pages as deployment failures. They are expected for newly created Cognito users. Final password-change submission is a user/account state change and should be done intentionally by the account holder.
* After the user completed the RES password challenge, Cognito user `clusteradmin` was `CONFIRMED` and enabled. Browser verification reached `https://res.research.sidata.plus/#/home/virtual-desktops` as `clusteradmin`, with `Virtual Desktops`, `Launch new virtual desktop`, and no visible error alerts.
* `clientIp=0.0.0.0/0` remains intentionally open only for initial validation. Do not redeploy a narrowed CIDR until a stable office, VPN, or administrator CIDR is known; otherwise the Web UI and VDI paths can become inaccessible during follow-up verification.
* Cognito user creation alone is not enough for RES native-user login. A synthetic Cognito user in the `res` group was rejected with `Error in authenticating given username/password combination` until a matching item existed in `res-ohdsi.accounts.users` and the Cognito `custom:uid` attribute matched that RES user-table `uid`.
* A normal RES researcher should have `role=user`, `sudo=false`, `enabled=true`, `is_active=true`, the primary `gid` for the `res` group, and a home directory such as `/home/<username>`. Do not clone the `clusteradmin` admin role or sudo flag for researcher validation accounts.
* A non-admin researcher also needs a RES project assignment before launching VDIs. For the synthetic validation user, create a project record, add a `project_member` role assignment with `actor_key=<username>:user` and `resource_key=<project_id>:project`, and assign the selected software stack to that project.
* The `res-ohdsi.vdc.controller.software-stacks` table key is `(base_os, stack_id)`, not `stack_id` alone. Updating only `stack_id` fails with a DynamoDB `ValidationException`.
* An empty software-stack `projects` list did not make the stack visible to the researcher project. Adding `res-validation` to the Ubuntu 24.04 stack's `projects` list made the stack selectable in the launch modal.
* DynamoDB filter expressions must alias reserved attribute names such as `owner`; use `--expression-attribute-names '{"#o":"owner"}'` and filter on `#o`.
* Before relaunching failed VDIs, check the current AWS RES troubleshooting docs rather than changing instance sizes blindly. The official user guide says new desktops can take 10-15 minutes to become ready, includes a runbook entry for `VDIs stuck in Provisioning state`, and lists Ubuntu 22.04.03 as a supported Linux desktop OS. It does not list Ubuntu 24.04 in the supported OS list.
* Ubuntu 24.04 VDIs in this deployment showed `Hibernation is not supported for Ubuntu 24.04`; more importantly, both Ubuntu 24.04 validation launches reached EC2 `running` with healthy instance checks but stayed in RES `PROVISIONING` with empty `dcv_session_id` and delayed SSM RunCommand. Treat Ubuntu 24.04 as a failed validation stack until proven otherwise.
* The validation project was moved from `ss-base-ubuntu2404-x86-64-base` to the documented supported `ss-base-ubuntu2204-x86-64-base` stack before retrying the normal researcher VDI launch. The Ubuntu 22.04 stack auto-adjusts root storage to the stack minimum of 50 GB.
* A first validation launch with `t3.medium` reached EC2 `running` and passed status checks but remained in RES `PROVISIONING`; SSM only showed the early boot ping and RunCommand stayed `Delayed`. Terminate failed synthetic validation desktops through RES before relaunching so the project session quota and RES user-session table stay clean.
* A second Ubuntu 24.04 validation launch with `t3.large` reproduced the same failure mode. Rebooting only the synthetic VDI instance did not recover it: EC2 status checks returned healthy, but SSM commands stayed `Delayed` and RES still had no DCV session id. Terminate the bad VDI through RES and switch to a supported software stack.
* The VDI host console only shows early cloud-init and then redirects bootstrap output to `/root/bootstrap/logs/userdata.log`; after that point, use SSM if connected, RES controller logs, and the session table rather than relying on EC2 console output alone.
* RES VDI EC2 instances can launch with `KeyName: null`; the RES infrastructure key pair is not necessarily attached to VDI hosts. For diagnostics, use SSM when online, or SSM port forwarding through the cluster manager plus EC2 Instance Connect for a short-lived SSH key.
* On this workstation, the Session Manager plugin could be used without a system install by expanding the cached package under `temp/session-manager-plugin-pkg/` and prepending its binary directory to `PATH`.
* Ubuntu 22.04 first boot can exceed the nominal 10-15 minute desktop-ready window while it compiles `amazon-efs-utils`/`efs-proxy`, installs `ubuntu-desktop gdm3`, triggers a required reboot, then starts DCV. During the early phase `/var/log/dcv` and the `dcv` command may be absent; keep watching `/root/bootstrap/logs/install.log.*` before declaring the VDI stuck.
* For the successful Ubuntu 22.04 validation launch, SSM showed `dcvserver` active, `dcv list-sessions` returned `Session: 'console' (owner:resresearcher type:console)`, DynamoDB moved the session to `READY`, and the Web UI showed `MyDesktop1` as `Ready`.
* `READY` does not by itself prove a usable Ubuntu desktop. In this deployment the DCV console session was healthy and owned by `resresearcher`, but the browser still landed at the GDM greeter. Host evidence showed `dcvserver` active, `passwd -S resresearcher` with a password set, and no `resresearcher` graphical login session until GDM autologin was enabled.
* For this validation VDI, the live fix was to back up `/etc/gdm3/custom.conf`, set `WaylandEnable=false`, `AutomaticLoginEnable=true`, and `AutomaticLogin=resresearcher` under `[daemon]`, then restart `gdm3`. Afterward `loginctl` showed an active `resresearcher` seat session, `gnome-shell` was running, and the browser DCV canvas advanced to the Ubuntu desktop.
* After the desktop is usable, Ubuntu can still lock the session and return the browser to a password prompt. For this validation VDI, the fix was `loginctl unlock-sessions` plus GNOME settings for `resresearcher`: `org.gnome.desktop.screensaver lock-enabled false`, `org.gnome.desktop.session idle-delay 0`, and `org.gnome.desktop.lockdown disable-lock-screen true`.
* The first logged-in Ubuntu desktop showed the first-run wizard. During validation, skip Ubuntu Pro, select `No, don't send system info` on the telemetry page, keep Location Services off, finish the wizard, and decline the Ubuntu 24.04 upgrade prompt so the supported Ubuntu 22.04 stack is not upgraded in place.
* `bootstrap/linux-vdi/ohdsi_profile.sh` now includes `ohdsi-enable-gdm-autologin <linux-user>` and `ohdsi-disable-gnome-screen-lock <linux-user>` as documented helpers for future console VDIs. Use them deliberately from a root-capable bootstrap path or SSM command, then restart `gdm3` after the autologin change; the current RES software-stack DynamoDB record does not contain a generic post-launch script hook, so do not assume these helpers run automatically just because the asset exists.
* The RES VDC controller runs under `supervisord` as `virtual-desktop-controller`; useful controller logs are under `/opt/idea/app/logs/` on the controller instance. The controller observed EC2 state transitions and mapped the session to the owner/session id even when the desktop host itself had not completed DCV registration.

## Last Verified Deployed State Before Teardown

Before the `2026-07-04` cost teardown, the RES deployment completed in `ap-southeast-1`; after the custom-domain and listener-rule updates, the parent stack reached `UPDATE_COMPLETE` and the nested deployment remained healthy.

Key wrapper outputs:

* `ResEnvironmentName`: `res-ohdsi`
* `ResNestedStackId`: `arn:aws:cloudformation:ap-southeast-1:248189943046:stack/ResearchOsResStack-ResearchEngineeringStudioProductStack-MHRT9K1WEXWX/081810c0-757e-11f1-b625-027d56a8c7dd`
* `ResDataCatalogSecretArn`: `arn:aws:secretsmanager:ap-southeast-1:248189943046:secret:ResearchOsSharedDataCatalog-7HLOVuUmzDgP-VJoDfC`
* `ResOhdsiDataAccessPolicyArn`: `arn:aws:iam::248189943046:policy/ResearchOsResStack-ResOhdsiDataAccessPolicy51708EF0-kwriT1gPBva8`
* `ResDataClientSecurityGroupId`: `sg-0ac6ab68c25a303fe`
* `ResSharedHomeFileSystemId`: `fs-0939200059be20a9d`
* `ResWebAppUrl`: `https://res.research.sidata.plus`
* `ResVdiUrl`: `https://vdi.research.sidata.plus`
* `ResTemplateUrl`: `https://s3.ap-southeast-1.amazonaws.com/cdk-hnb659fds-assets-248189943046-ap-southeast-1/5770311389c7556ea36e759ebb2466f8fd5d42aa356c45983a13bf6ab502dded.json`
* `LinuxVdiOhdsiProfileS3Uri`: `s3://cdk-hnb659fds-assets-248189943046-ap-southeast-1/c844f6f4bd38883c96800065ea79be6d54a5c17a791fdbbfe3795338d5d49861.sh`

Post-deploy verification:

* The nested RES product stack reached `UPDATE_COMPLETE` after the VDI custom-domain update.
* Cognito groups `admins`, `atlas`, and `res` exist in user pool `ap-southeast-1_pDv0OTSbC`.
* RES finalizer created Cognito user `clusteradmin` with email `max@sidata.plus`; after user password change, status is `CONFIRMED`.
* Synthetic non-admin user `resresearcher` exists for validation with a matching Cognito user, `custom:uid`, and RES native user-table record. Browser verification reached `https://res.research.sidata.plus/#/home/virtual-desktops` as `resresearcher`.
* Shared SSM parameters exist under `/researchos/shared`: ATLAS URL, WebAPI URL, OMOP endpoint, and OMOP schemas.
* Retained EFS `fs-0939200059be20a9d` has available mount targets in `subnet-02499041796ebde0b` and `subnet-04e8341a015764cc6`.
* Cluster-manager target group `res-ohdsi-cm-ext-ae72f4e0` has healthy instance target `i-0d6bff9a4880ef45b`.
* VDC target group `res-ohdsi-vdc-ext-a3cefb42` has healthy instance target `i-0f5e1af1d42cf034b`.
* `https://res.research.sidata.plus/` reaches the RES Web UI login route when no RES session is present and reaches the Virtual Desktops page after `clusteradmin` authentication.
* As `resresearcher`, the Web UI shows `My virtual desktops`, `Shared desktops`, and `Launch new virtual desktop`, but does not show the admin `Environment management` navigation.
* `openssl s_client -connect vdi.research.sidata.plus:443 -servername vdi.research.sidata.plus -brief` verifies a publicly trusted certificate for `CN=vdi.research.sidata.plus`.
* Browser verification as `resresearcher` loaded Amazon DCV for host `ip-10-0-2-176`; the generated launch URL may show the raw VDC external NLB hostname with a short-lived `authToken`, so record only the redacted hostname/session evidence in documentation.
* Host verification on EC2 instance `i-0e98cdde4b56ee979` showed Linux user `resresearcher`, DCV session `console` owned by `resresearcher`, connected browser clients, and RES session state `READY`.
* After enabling GDM autologin for the validation VDI, browser verification reached the logged-in Ubuntu desktop as `resresearcher`, completed the first-run wizard, declined the Ubuntu 24.04 upgrade prompt, and displayed a terminal with `RES desktop OK`, `user=resresearcher`, and host `ip-10-0-2-176`.
* After the session locked again, SSM verification showed the same active `resresearcher` seat session. `loginctl unlock-sessions` restored the browser to the desktop, and the GNOME lock/idle settings above were applied so this validation desktop does not require the Linux password during short idle periods.

## Post-Deploy Checks

* Parent and nested CloudFormation stacks are complete; after updates, expect `UPDATE_COMPLETE` on the parent and healthy nested stacks.
* Outputs include `ResNestedStackId`, `ResDataCatalogSecretArn`, `ResOhdsiDataAccessPolicyArn`, and `ResDataClientSecurityGroupId`.
* `https://res.research.sidata.plus` presents a public ACM certificate and reaches the RES Web UI without a browser TLS interstitial. If it returns only `{"success":true,"message":"OK"}`, verify that the wrapper-managed `/*` listener rule exists and forwards to the cluster-manager target group.
* `https://vdi.research.sidata.plus` presents a public certificate for the DCV gateway. If the RES Connect button opens the raw external NLB hostname, do not document the `authToken`; validate the custom domain separately and use the custom hostname for user-facing instructions.
* Cognito groups `admins`, `atlas`, and `res` exist.
* SSM parameters under `/researchos/shared` contain ATLAS, WebAPI, and OMOP discovery values.
* `clientIp` is tightened from `0.0.0.0/0` after initial access is confirmed and a stable office, VPN, or administrator CIDR is available.

## Full Cost Teardown and Demo Respawn

On `2026-07-04`, the environment moved from a reversible pause to a full cost-control teardown:

* Terminated validation VDI `i-0e98cdde4b56ee979`; its root volume `vol-0d4ad57409c2dea64` had `DeleteOnTermination=true` and was deleted.
* Deleted `ResearchOsResStack`; verified the RES external ALB, internal ALB, VDC external NLB, ASGs, Kinesis streams, DynamoDB tables, SSM parameters, Lambda functions, EC2 instances, and EBS volumes were gone.
* Deleted old empty `REVIEW_IN_PROGRESS` RES nested-stack shells left by earlier failed create attempts.
* Deleted `OhdsiAtlasWebApiStack` after RES completed so the shared VPC, NAT gateway, ATLAS ALB, ECS services, and Aurora clusters were removed cleanly.
* Removed stale Route53 `vdi.research.sidata.plus` CNAME after the VDC NLB was deleted.
* Scheduled the obsolete VDI certificate/key Secrets Manager secrets for recoverable deletion on `2026-07-11`:
  * `res-ohdsi-vdi-research-sidata-plus-certificate`
  * `res-ohdsi-vdi-research-sidata-plus-private-key`

Retained artifacts after teardown:

* Route53 public hosted zone `research.sidata.plus` remains delegated for easier respawn.
* Cognito user pool `ap-southeast-1_pDv0OTSbC` remains because ATLAS CloudFormation skipped deletion.
* RES shared-home EFS `fs-0939200059be20a9d` remains with `24,576` bytes and no mount targets.
* Two ATLAS RDS final snapshots remain with `AllocatedStorage=0`; do not delete snapshots without explicit approval because deletion is irreversible.
* CDK bootstrap stack/bucket/ECR repository remain. The retained CDK S3 assets are about `2.4 MB`; retained CDK ECR images are about `365 MB`.
* CloudWatch log groups remain for bring-up evidence and are only a few MB.

Approximate remaining monthly cost is about `$0.55/month`, mostly the Route53 hosted zone. There are no live load balancers, NAT gateways, EC2 instances, EBS volumes, RDS clusters, Kinesis streams, or active Secrets Manager secrets.

Respawn now requires a fresh deploy rather than scaling existing ASGs:

```bash
cd ../ohdsi-atlas-webapi-cdk
export CDK_DEFAULT_ACCOUNT=248189943046
export CDK_DEFAULT_REGION=ap-southeast-1
export AWS_REGION=ap-southeast-1
export AWS_DEFAULT_REGION=ap-southeast-1
eval "$(aws configure export-credentials --format env)"
pnpm install
pnpm run build
pnpm exec cdk deploy \
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

After ATLAS is healthy, rerun the ATLAS init tasks, regenerate RES context, recreate the VDI certificate/key secrets, and deploy RES with the same patched-template practices above. Because the old VDI certificate/key secrets are scheduled for deletion, do not reuse their ARNs unless they are restored before `2026-07-11`.

For a clean demo, prefer `createEfs=true` and let RES create a fresh shared-home file system. If the retained EFS must be reused, deploy with `createEfs=false`, `efsFileSystemId=fs-0939200059be20a9d`, and `createEfsMountTargets=true` only after confirming it still has no mount targets and the new ATLAS VPC/subnets are ready.

Recreate the normal researcher validation flow after RES deploy: create the non-admin Cognito/RES user pair, assign a project, use the supported Ubuntu 22.04 stack, launch a new VDI, and apply the documented GDM autologin and GNOME lock-disable helpers if the DCV console lands on the greeter.
