# ResearchOS RES CDK sibling stack

This CDK app deploys Research and Engineering Studio on AWS as a sibling stack next to an OHDSI ATLAS/WebAPI CDK deployment.

It is designed to reuse, where practical:

- Existing ATLAS Cognito User Pool
- Existing Cognito domain
- Existing VPC/subnets
- Existing OMOP/WebAPI endpoint metadata
- Existing SynPUF public S3 data source
- Existing OMOP DB security group, optionally

RES itself is normally deployed using the official AWS RES CloudFormation template URL, wrapped by CDK as a nested stack. If an account/region rejects a setting in that upstream template, the wrapper can upload a local patched template asset with `-c resTemplatePath=...`.

## Recommended directory layout

```text
parent-folder/
├── ohdsi-atlas-webapi-cdk/
└── researchos-res-cdk/
````

## Install

```bash
cd researchos-res-cdk
pnpm install
pnpm run build
```

## Generate context from ATLAS stack outputs

```bash
./scripts/atlas-outputs-to-context.sh OhdsiAtlasWebApiStack cdk.context.local.json
cat cdk.context.local.json
```

Review blanks. The earlier ATLAS stack may not export every value RES needs. Generated context and intermediate output are written under repo `temp/`.

## Minimal deploy shape

```bash
pnpm exec cdk deploy \
  -c resEnvironmentName=res-ohdsi \
  -c administratorEmail="you@example.org" \
  -c sshKeyPair="my-existing-ec2-keypair" \
  -c clientIp="x.x.x.x/32" \
  -c cognitoUserPoolId="us-east-1_XXXXXXXXX" \
  -c cognitoUserPoolDomainUrl="https://your-domain.auth.us-east-1.amazoncognito.com" \
  -c vpcId="vpc-xxxxxxxx" \
  -c vpcCidr="10.0.0.0/16" \
  -c availabilityZones="us-east-1a,us-east-1b" \
  -c loadBalancerSubnetIds="subnet-public-a,subnet-public-b" \
  -c infrastructureHostSubnetIds="subnet-private-a,subnet-private-b" \
  -c vdiSubnetIds="subnet-private-a,subnet-private-b" \
  -c atlasUrl="https://ohdsi.example.org/atlas" \
  -c webApiUrl="https://ohdsi.example.org/WebAPI" \
  -c omopDbEndpoint="example.cluster-xyz.us-east-1.rds.amazonaws.com" \
  -c omopDbSecretArn="arn:aws:secretsmanager:us-east-1:123456789012:secret:omop" \
  -c omopDbSecurityGroupId="sg-xxxxxxxx"
```

## Public Web UI domain

The upstream RES template falls back to a self-signed `*.idea.default` certificate when no custom Web UI domain and certificate are provided. That is enough for stack creation, but real browser testing against the raw ALB hostname fails TLS validation.

To expose the RES Web UI through a trusted public URL, provide a custom Web UI hostname and the Route53 hosted zone that can validate the ACM certificate:

```bash
pnpm exec cdk deploy \
  -c customDomainNameForWebApp="res.example.org" \
  -c hostedZoneId="Z1234567890ABC" \
  -c hostedZoneName="example.org"
```

When `acmCertificateArnForWebApp` is omitted, the wrapper creates a DNS-validated ACM certificate and passes it to RES as `ACMCertificateARNforWebApp`. The wrapper also creates a `CNAME` record for the custom Web UI hostname by looking up the RES external ALB by name after the nested RES stack updates.

For browser access, the wrapper also adds a managed `/*` HTTPS listener rule that forwards root/static Web UI requests to the cluster-manager target group. The upstream RES API/service routes keep their higher priorities, so `/cluster-manager/*`, `/vdc/*`, `/awsproxy/*`, and `/res/*` continue to route to their original targets.

## Public VDI/DCV domain

The Web UI custom domain does not cover browser-based VDI connections. The RES Connect button opens the VDC external NLB / DCV connection-gateway path. That NLB uses TCP pass-through, so the gateway needs its own certificate/key pair.

Use an exportable publicly trusted certificate for the VDI hostname, store the certificate chain and private key in separate Secrets Manager secrets, create DNS for the VDI hostname, and pass:

```bash
pnpm exec cdk deploy \
  -c customDomainNameForVdi="vdi.example.org" \
  -c certificateSecretArnForVdi="arn:aws:secretsmanager:REGION:ACCOUNT:secret:cert" \
  -c privateKeySecretArnForVdi="arn:aws:secretsmanager:REGION:ACCOUNT:secret:key"
```

Managed ACM public certificates are not suitable for this gateway path because ACM does not export private keys. If using Let's Encrypt or another short-lived public certificate, record the expiry date and renewal process in the deployment runbook.

## Cognito

If `cognitoUserPoolId` is provided, this stack:

1. Adds RES-required custom attributes if missing:

   * `custom:aws_region`
   * `custom:cluster_name`
   * `custom:password_last_set`
   * `custom:password_max_age`
   * `custom:uid`
2. Ensures these Cognito groups exist:

   * `admins`
   * `atlas`
   * `res`

RES grants Cognito users in the `admins` group administrator privileges after synchronization.

## Data sharing

The stack creates:

* Secrets Manager data catalog secret
* SSM parameters under `/researchos/shared`
* IAM managed policy for RES VDI/project roles
* Optional OMOP DB security-group ingress

Attach the output `ResOhdsiDataAccessPolicyArn` to RES project/VDI roles that need to read ATLAS/WebAPI/OMOP discovery metadata.

## Outputs

Important outputs:

* `ResNestedStackId`
* `ResEnvironmentName`
* `ResDataCatalogSecretArn`
* `ResOhdsiDataAccessPolicyArn`
* `ResDataClientSecurityGroupId`
* `ResWebAppUrl`, when `customDomainNameForWebApp` is configured
* `LinuxVdiOhdsiProfileS3Uri`
* `AtlasUrlSsmParameter`
* `WebApiUrlSsmParameter`
* `OmopEndpointSsmParameter`

## Caveats

* This stack does not magically make RES free at idle. RES VDIs and infrastructure components have their own lifecycle and cost model.
* Cognito-native RES users can use Linux VDIs, not Windows VDIs.
* Existing Cognito custom attributes cannot be deleted after they are created.
* If your ATLAS stack did not output VPC/subnet/security group IDs, provide them manually.
* Pin `CDK_DEFAULT_REGION`, `AWS_REGION`, and `AWS_DEFAULT_REGION` in the same shell as `cdk synth`, `cdk diff`, and `cdk deploy`; wrong ambient region values can render bad asset URLs and IAM/SSM/DynamoDB ARNs even before deploy.
* For production, restrict `clientIp`, use private networking, configure budgets, and review RES-created IAM/security groups after deployment.

## ap-southeast-1 notes

See [`ap-southeast-1-deployment.md`](ap-southeast-1-deployment.md) for the live `res-ohdsi` deployment path, including exact RES parameter spellings, boolean casing, `IAMResourcePath=/res/`, and the local Lambda-memory-capped template workaround for regions/accounts that reject the upstream backend Lambda `MemorySize: 4096`.
