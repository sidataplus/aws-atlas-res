
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
| Login wake collapses  | Idle scaler only sees target-group traffic | Count ALB-level requests as activity                    |
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
