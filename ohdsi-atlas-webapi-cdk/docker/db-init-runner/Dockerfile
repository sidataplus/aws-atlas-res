FROM public.ecr.aws/docker/library/python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl postgresql-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir boto3 psycopg[binary] requests

WORKDIR /app
COPY init_synpuf.py /app/init_synpuf.py
ENTRYPOINT ["python", "/app/init_synpuf.py"]
