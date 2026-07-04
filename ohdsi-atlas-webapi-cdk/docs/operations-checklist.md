
# Operations Checklist

Use this before declaring the environment usable. Humanity loves a launch party before the thing works. Resist.

## Deployment checklist

* [ ] `pnpm install` completed.
* [ ] Route53 hosted zone exists and parent DNS delegates to its NS records.
* [ ] `pnpm exec cdk synth` completed.
* [ ] `pnpm exec cdk diff` reviewed.
* [ ] `pnpm exec cdk deploy` completed.
* [ ] Stack outputs saved.
* [ ] Cognito test user created.
* [ ] Schemas initialized.
* [ ] SynPUF loaded.
* [ ] WebAPI source registered.
* [ ] Init task exit-code table checked for `exitCode = 0`.
* [ ] Init CloudWatch log checked after failed or suspicious task runs.
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

## Known Bring-Up Fixes

* If WebAPI fails during `PermissionService.postConstruct` with `relation "ohdsi.source" does not exist`, verify the deployed task definition includes `SPRING_APPLICATION_JSON` with `datasource.ohdsi.schema`, `spring.jpa.properties.hibernate.default_schema`, and Flyway schema placeholders set to `webapi`.
* If `load-synpuf` says no delimited files exist under `s3://synpuf-omop/cmsdesynpuf1k/`, confirm the init runner image includes `.bz2` support. The 1k public prefix uses `.csv.bz2` objects.
* If `register-source` fails with `cannot insert multiple commands into a prepared statement`, use the current init runner, which splits deletes and inserts into separate psycopg executions.

## Cost check

Review:

* ALB running
* ECS tasks at 0 when idle
* Aurora paused when idle
* CloudWatch log growth
* NAT gateway absent unless intentionally added
  MD

echo "Wrote docs/*.md"
