
# Configuration Reference

This stack is configured primarily through CDK context values.

Pass values with:

```bash
pnpm exec cdk deploy -c key=value
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
pnpm exec cdk deploy \
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
