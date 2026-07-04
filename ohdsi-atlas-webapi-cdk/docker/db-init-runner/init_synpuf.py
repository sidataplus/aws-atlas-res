import bz2
import csv
import gzip
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

import boto3
import psycopg
import requests
from botocore import UNSIGNED
from botocore.config import Config

secrets = boto3.client("secretsmanager")
s3_unsigned = boto3.client("s3", config=Config(signature_version=UNSIGNED))


def log(msg: str) -> None:
    print(msg, flush=True)


def get_secret(secret_arn: str) -> dict:
    value = secrets.get_secret_value(SecretId=secret_arn)["SecretString"]
    return json.loads(value)


def connect(host: str, dbname: str, secret_arn: str):
    secret = get_secret(secret_arn)
    return psycopg.connect(
        host=host,
        port=5432,
        dbname=dbname,
        user=secret["username"],
        password=secret["password"],
        autocommit=True,
    )


def ident(name: str) -> str:
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        raise ValueError(f"Unsafe SQL identifier: {name}")
    return name


def clean_identifier(name: str) -> str:
    x = re.sub(r"[^A-Za-z0-9_]+", "_", name.strip().lower())
    x = re.sub(r"_+", "_", x).strip("_")
    if not x:
        x = "col"
    if re.match(r"^[0-9]", x):
        x = f"c_{x}"
    return x[:63]


def create_schema(conn, schema: str) -> None:
    with conn.cursor() as cur:
        cur.execute(f"CREATE SCHEMA IF NOT EXISTS {ident(schema)}")


def run_sql(conn, sql: str) -> None:
    with conn.cursor() as cur:
        cur.execute(sql)


def run_sql_file(conn, path: Path, schema: str) -> None:
    sql = path.read_text()
    sql = sql.replace("@cdmDatabaseSchema", schema)
    sql = sql.replace("@vocabDatabaseSchema", schema)
    sql = sql.replace("@resultsDatabaseSchema", schema)
    sql = sql.replace("@target_database_schema", schema)
    log(f"Executing SQL file: {path}")
    run_sql(conn, sql)


def parse_s3_uri(uri: str) -> Tuple[str, str]:
    if not uri.startswith("s3://"):
        raise ValueError(f"Expected s3:// URI, got: {uri}")
    parsed = urlparse(uri)
    bucket = parsed.netloc
    prefix = parsed.path.lstrip("/")
    return bucket, prefix


def list_s3_objects(uri: str) -> List[str]:
    bucket, prefix = parse_s3_uri(uri)
    keys: List[str] = []
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3_unsigned.list_objects_v2(**kwargs)
        keys.extend(item["Key"] for item in resp.get("Contents", []))
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return keys


def download_s3_object(uri: str, dest: Path) -> Path:
    bucket, key = parse_s3_uri(uri)
    dest.parent.mkdir(parents=True, exist_ok=True)
    s3_unsigned.download_file(bucket, key, str(dest))
    return dest


def download_http(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return dest


def maybe_open_text(path: Path):
    if str(path).endswith(".bz2"):
        return bz2.open(path, "rt", newline="")
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", newline="")
    return open(path, "rt", newline="")


def infer_delimiter(path: Path) -> str:
    with maybe_open_text(path) as f:
        first = f.readline()
    # SynPUF exports vary by version; let the file tell us, because hardcoding CSV delimiters is how bugs breed.
    if first.count("\t") > first.count(","):
        return "\t"
    return ","


def table_name_from_key(key: str) -> str:
    name = Path(key).name.lower()
    for suffix in [".csv.bz2", ".txt.bz2", ".tsv.bz2", ".csv.gz", ".txt.gz", ".tsv.gz", ".csv", ".txt", ".tsv"]:
        if name.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return clean_identifier(name)


def existing_table(conn, schema: str, table: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = %s AND table_name = %s
            """,
            (schema, table),
        )
        return cur.fetchone() is not None


def create_text_table_from_header(conn, schema: str, table: str, path: Path, delimiter: str) -> None:
    with maybe_open_text(path) as f:
        reader = csv.reader(f, delimiter=delimiter)
        header = next(reader)
    columns = []
    seen = set()
    for i, col in enumerate(header):
        c = clean_identifier(col or f"col_{i + 1}")
        base = c
        n = 2
        while c in seen:
            c = f"{base}_{n}"
            n += 1
        seen.add(c)
        columns.append(c)
    col_sql = ", ".join(f"{ident(c)} text" for c in columns)
    run_sql(conn, f"CREATE TABLE IF NOT EXISTS {ident(schema)}.{ident(table)} ({col_sql})")


def copy_file(conn, schema: str, table: str, path: Path, delimiter: str) -> None:
    delimiter_sql = "E'\\t'" if delimiter == "\t" else "','"
    log(f"Loading {path.name} -> {schema}.{table} using delimiter={repr(delimiter)}")
    with maybe_open_text(path) as f, conn.cursor() as cur:
        with cur.copy(f"COPY {ident(schema)}.{ident(table)} FROM STDIN WITH (FORMAT csv, HEADER true, DELIMITER {delimiter_sql}, QUOTE '\"')") as cp:
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                cp.write(chunk)


def command_schemas() -> None:
    web = connect(os.environ["WEB_DB_HOST"], os.environ["WEB_DB_NAME"], os.environ["WEB_DB_SECRET_ARN"])
    omop = connect(os.environ["OMOP_DB_HOST"], os.environ["OMOP_DB_NAME"], os.environ["OMOP_DB_SECRET_ARN"])
    for schema in [os.environ.get("WEBAPI_SCHEMA", "webapi")]:
        log(f"Creating WebAPI schema {schema}")
        create_schema(web, schema)
    for schema in [os.environ.get("CDM_SCHEMA", "cdm_synpuf"), os.environ.get("RESULTS_SCHEMA", "results_synpuf"), os.environ.get("TEMP_SCHEMA", "temp_synpuf")]:
        log(f"Creating OMOP schema {schema}")
        create_schema(omop, schema)
    web.close()
    omop.close()


def command_load_synpuf() -> None:
    omop = connect(os.environ["OMOP_DB_HOST"], os.environ["OMOP_DB_NAME"], os.environ["OMOP_DB_SECRET_ARN"])
    cdm_schema = os.environ.get("CDM_SCHEMA", "cdm_synpuf")
    create_schema(omop, cdm_schema)

    ddl_uri = os.environ.get("CDM_DDL_URI", "").strip()
    if ddl_uri:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "cdm_ddl.sql"
            if ddl_uri.startswith("s3://"):
                download_s3_object(ddl_uri, path)
            elif ddl_uri.startswith("http://") or ddl_uri.startswith("https://"):
                download_http(ddl_uri, path)
            else:
                path = Path(ddl_uri)
            run_sql_file(omop, path, cdm_schema)
    else:
        log("No CDM_DDL_URI supplied. Missing tables will be created from file headers as TEXT. Good enough for smoke tests; not good enough for serious OMOP analytics, naturally.")

    dataset_uri = os.environ.get("SYNPUF_S3_URI", "s3://synpuf-omop/").rstrip("/") + "/"
    keys = [
        k for k in list_s3_objects(dataset_uri)
        if k.lower().endswith((".csv", ".csv.bz2", ".csv.gz", ".txt", ".txt.bz2", ".txt.gz", ".tsv", ".tsv.bz2", ".tsv.gz"))
    ]
    if not keys:
        raise RuntimeError(f"No delimited files found under {dataset_uri}. Run: aws s3 ls --no-sign-request {dataset_uri}")

    with tempfile.TemporaryDirectory() as td:
        tempdir = Path(td)
        for key in keys:
            uri = f"s3://{parse_s3_uri(dataset_uri)[0]}/{key}"
            local = tempdir / Path(key).name
            log(f"Downloading {uri}")
            download_s3_object(uri, local)
            table = table_name_from_key(key)
            delimiter = infer_delimiter(local)
            if not existing_table(omop, cdm_schema, table):
                create_text_table_from_header(omop, cdm_schema, table, local, delimiter)
            copy_file(omop, cdm_schema, table, local, delimiter)
    omop.close()


def command_register_source() -> None:
    web = connect(os.environ["WEB_DB_HOST"], os.environ["WEB_DB_NAME"], os.environ["WEB_DB_SECRET_ARN"])
    omop_secret = get_secret(os.environ["OMOP_DB_SECRET_ARN"])

    webapi_schema = os.environ.get("WEBAPI_SCHEMA", "webapi")
    source_key = os.environ.get("SOURCE_KEY", "SYNPUF")
    source_name = os.environ.get("SOURCE_NAME", "CMS DE-SynPUF OMOP")
    cdm_schema = os.environ.get("CDM_SCHEMA", "cdm_synpuf")
    vocab_schema = os.environ.get("VOCAB_SCHEMA", cdm_schema)
    results_schema = os.environ.get("RESULTS_SCHEMA", "results_synpuf")
    temp_schema = os.environ.get("TEMP_SCHEMA", "temp_synpuf")
    omop_host = os.environ["OMOP_DB_HOST"]
    omop_db_name = os.environ["OMOP_DB_NAME"]

    jdbc = f"jdbc:postgresql://{omop_host}:5432/{omop_db_name}"

    delete_daimons_sql = f"""
    DELETE FROM {ident(webapi_schema)}.source_daimon
    WHERE source_id IN (SELECT source_id FROM {ident(webapi_schema)}.source WHERE source_key = %s);
    """
    delete_source_sql = f"""
    DELETE FROM {ident(webapi_schema)}.source WHERE source_key = %s;
    """
    insert_source_sql = f"""
    WITH new_source AS (
      INSERT INTO {ident(webapi_schema)}.source (
        source_id, source_name, source_key, source_connection, source_dialect, username, password
      )
      VALUES (
        (SELECT COALESCE(MAX(source_id), 0) + 1 FROM {ident(webapi_schema)}.source),
        %s, %s, %s, 'postgresql', %s, %s
      )
      RETURNING source_id
    )
    INSERT INTO {ident(webapi_schema)}.source_daimon (
      source_daimon_id, source_id, daimon_type, table_qualifier, priority
    )
    SELECT base_id + row_number() over (), source_id, daimon_type, table_qualifier, priority
    FROM new_source
    CROSS JOIN (SELECT COALESCE(MAX(source_daimon_id), 0) AS base_id FROM {ident(webapi_schema)}.source_daimon) x
    CROSS JOIN (VALUES
      (0, %s, 0),
      (1, %s, 1),
      (2, %s, 0),
      (5, %s, 0)
    ) AS v(daimon_type, table_qualifier, priority);
    """
    with web.cursor() as cur:
        cur.execute(delete_daimons_sql, (source_key,))
        cur.execute(delete_source_sql, (source_key,))
        cur.execute(
            insert_source_sql,
            (
                source_name,
                source_key,
                jdbc,
                omop_secret["username"],
                omop_secret["password"],
                cdm_schema,
                vocab_schema,
                results_schema,
                temp_schema,
            ),
        )
    log(f"Registered OHDSI WebAPI source {source_key} -> {jdbc}")
    web.close()


def main() -> None:
    command = os.environ.get("INIT_COMMAND") or (sys.argv[1] if len(sys.argv) > 1 else "schemas")
    log(f"INIT_COMMAND={command}")
    if command == "schemas":
        command_schemas()
    elif command == "load-synpuf":
        command_load_synpuf()
    elif command == "register-source":
        command_register_source()
    elif command == "all":
        command_schemas()
        command_load_synpuf()
        command_register_source()
    else:
        raise SystemExit(f"Unknown INIT_COMMAND={command}. Use schemas, load-synpuf, register-source, all.")


if __name__ == "__main__":
    main()
