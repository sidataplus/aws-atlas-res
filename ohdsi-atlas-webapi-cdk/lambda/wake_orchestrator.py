import datetime as dt
import json
import os
from typing import Any, Dict, List, Tuple

import boto3

ECS = boto3.client("ecs")
ELB = boto3.client("elbv2")
CW = boto3.client("cloudwatch")

CLUSTER = os.environ["ECS_CLUSTER"]
ATLAS_SERVICE = os.environ["ATLAS_SERVICE"]
WEBAPI_SERVICE = os.environ["WEBAPI_SERVICE"]
SERVICES = [ATLAS_SERVICE, WEBAPI_SERVICE]
DESIRED_COUNT_ON_WAKE = int(os.environ.get("DESIRED_COUNT_ON_WAKE", "1"))
IDLE_SCALE_DOWN_MINUTES = int(os.environ.get("IDLE_SCALE_DOWN_MINUTES", "120"))
ATLAS_TG_ARN = os.environ["ATLAS_TG_ARN"]
WEBAPI_TG_ARN = os.environ["WEBAPI_TG_ARN"]
ATLAS_TG_FULL_NAME = os.environ["ATLAS_TG_FULL_NAME"]
WEBAPI_TG_FULL_NAME = os.environ["WEBAPI_TG_FULL_NAME"]
LOAD_BALANCER_FULL_NAME = os.environ["LOAD_BALANCER_FULL_NAME"]
ALB_BASE_URL = os.environ["ALB_BASE_URL"].rstrip("/")
ATLAS_URL = os.environ["ATLAS_URL"]
WEBAPI_INFO_URL = os.environ["WEBAPI_INFO_URL"]


def response(status_code: int, body: Any, content_type: str = "application/json") -> Dict[str, Any]:
    if content_type == "application/json":
        payload = json.dumps(body, default=str)
    else:
        payload = str(body)
    return {
        "statusCode": status_code,
        "headers": {
            "content-type": content_type,
            "cache-control": "no-store",
        },
        "body": payload,
    }


def html_response(html: str) -> Dict[str, Any]:
    return response(200, html, "text/html; charset=utf-8")


def update_service(service: str, desired: int) -> None:
    ECS.update_service(cluster=CLUSTER, service=service, desiredCount=desired)


def describe_ecs_services() -> Dict[str, Any]:
    data = ECS.describe_services(cluster=CLUSTER, services=SERVICES)
    out: Dict[str, Any] = {}
    for svc in data.get("services", []):
        out[svc["serviceName"]] = {
            "desiredCount": svc.get("desiredCount", 0),
            "runningCount": svc.get("runningCount", 0),
            "pendingCount": svc.get("pendingCount", 0),
            "status": svc.get("status"),
            "deployments": [
                {
                    "status": d.get("status"),
                    "desiredCount": d.get("desiredCount"),
                    "runningCount": d.get("runningCount"),
                    "pendingCount": d.get("pendingCount"),
                    "rolloutState": d.get("rolloutState"),
                }
                for d in svc.get("deployments", [])
            ],
        }
    return out


def target_health(target_group_arn: str) -> Dict[str, Any]:
    data = ELB.describe_target_health(TargetGroupArn=target_group_arn)
    states: List[str] = []
    reason_counts: Dict[str, int] = {}
    for item in data.get("TargetHealthDescriptions", []):
        health = item.get("TargetHealth", {})
        state = health.get("State", "unknown")
        reason = health.get("Reason", state)
        states.append(state)
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
    return {
        "targetCount": len(states),
        "healthyCount": sum(1 for s in states if s == "healthy"),
        "states": states,
        "reasons": reason_counts,
    }


def status_payload() -> Dict[str, Any]:
    ecs_services = describe_ecs_services()
    atlas_health = target_health(ATLAS_TG_ARN)
    webapi_health = target_health(WEBAPI_TG_ARN)
    ready = atlas_health["healthyCount"] >= 1 and webapi_health["healthyCount"] >= 1
    return {
        "ready": ready,
        "cluster": CLUSTER,
        "services": ecs_services,
        "targets": {
            "atlas": atlas_health,
            "webapi": webapi_health,
        },
        "urls": {
            "albBaseUrl": ALB_BASE_URL,
            "atlas": ATLAS_URL,
            "webapiInfo": WEBAPI_INFO_URL,
        },
    }


def wake() -> Dict[str, Any]:
    for service in SERVICES:
        update_service(service, DESIRED_COUNT_ON_WAKE)
    payload = status_payload()
    payload["message"] = "Wake signal sent. ECS is starting ATLAS/WebAPI; Aurora resumes when containers connect. Humanity survives another loading screen."
    return payload


def sleep() -> Dict[str, Any]:
    for service in SERVICES:
        update_service(service, 0)
    payload = status_payload()
    payload["message"] = "Scale-down signal sent. ECS desiredCount=0 for ATLAS/WebAPI."
    return payload


def request_count_for_target_group(target_group_full_name: str, minutes: int) -> float:
    now = dt.datetime.now(dt.UTC)
    start = now - dt.timedelta(minutes=minutes)
    period = max(60, min(3600, minutes * 60))
    data = CW.get_metric_statistics(
        Namespace="AWS/ApplicationELB",
        MetricName="RequestCount",
        Dimensions=[
            {"Name": "LoadBalancer", "Value": LOAD_BALANCER_FULL_NAME},
            {"Name": "TargetGroup", "Value": target_group_full_name},
        ],
        StartTime=start,
        EndTime=now,
        Period=period,
        Statistics=["Sum"],
    )
    return float(sum(point.get("Sum", 0.0) for point in data.get("Datapoints", [])))


def request_count_for_load_balancer(minutes: int) -> float:
    now = dt.datetime.now(dt.UTC)
    start = now - dt.timedelta(minutes=minutes)
    period = max(60, min(3600, minutes * 60))
    data = CW.get_metric_statistics(
        Namespace="AWS/ApplicationELB",
        MetricName="RequestCount",
        Dimensions=[
            {"Name": "LoadBalancer", "Value": LOAD_BALANCER_FULL_NAME},
        ],
        StartTime=start,
        EndTime=now,
        Period=period,
        Statistics=["Sum"],
    )
    return float(sum(point.get("Sum", 0.0) for point in data.get("Datapoints", [])))


def idle_down() -> Dict[str, Any]:
    atlas_count = request_count_for_target_group(ATLAS_TG_FULL_NAME, IDLE_SCALE_DOWN_MINUTES)
    webapi_count = request_count_for_target_group(WEBAPI_TG_FULL_NAME, IDLE_SCALE_DOWN_MINUTES)
    load_balancer_count = request_count_for_load_balancer(IDLE_SCALE_DOWN_MINUTES)
    total = atlas_count + webapi_count + load_balancer_count
    if total <= 0:
        for service in SERVICES:
            update_service(service, 0)
        action = "scaled_down"
    else:
        action = "kept_running"
    return {
        "action": action,
        "idleWindowMinutes": IDLE_SCALE_DOWN_MINUTES,
        "requestCount": total,
        "atlasRequestCount": atlas_count,
        "webapiRequestCount": webapi_count,
        "loadBalancerRequestCount": load_balancer_count,
        "status": status_payload(),
    }


def launcher_html() -> str:
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OHDSI ATLAS Launcher</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e5e7eb; }}
    main {{ width: min(760px, calc(100% - 32px)); background: #111827; border: 1px solid #334155; border-radius: 20px; padding: 28px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }}
    h1 {{ margin: 0 0 8px; font-size: 1.6rem; }}
    p {{ color: #cbd5e1; line-height: 1.55; }}
    button {{ background: #38bdf8; color: #082f49; border: 0; border-radius: 12px; padding: 12px 18px; font-weight: 700; cursor: pointer; }}
    button:disabled {{ opacity: .55; cursor: wait; }}
    pre {{ white-space: pre-wrap; background: #020617; color: #d1d5db; padding: 16px; border-radius: 12px; overflow: auto; max-height: 320px; }}
    .bar {{ width: 100%; height: 10px; background: #1e293b; border-radius: 999px; overflow: hidden; margin: 16px 0; }}
    .bar > div {{ height: 100%; width: 0%; background: #38bdf8; transition: width .35s ease; }}
    a {{ color: #7dd3fc; }}
  </style>
</head>
<body>
<main>
  <h1>OHDSI ATLAS is asleep 💤</h1>
  <p>This launcher starts ATLAS and WebAPI on ECS Fargate. Aurora Serverless resumes when WebAPI connects. Cold start is expected; invoices are apparently less cute when systems run for nobody.</p>
  <button id="wake">Wake ATLAS/WebAPI</button>
  <div class="bar"><div id="bar"></div></div>
  <p id="message">Idle. Press the button.</p>
  <pre id="status"></pre>
  <p>ATLAS URL: <a href="{ATLAS_URL}">{ATLAS_URL}</a></p>
</main>
<script>
const btn = document.getElementById('wake');
const msg = document.getElementById('message');
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');
let ticks = 0;
function progress(p) {{ bar.style.width = Math.max(0, Math.min(100, p)) + '%'; }}
async function getStatus() {{
  const r = await fetch('/status', {{ cache: 'no-store' }});
  return await r.json();
}}
async function poll() {{
  ticks += 1;
  const s = await getStatus();
  statusEl.textContent = JSON.stringify(s, null, 2);
  const atlasTargets = s.targets?.atlas?.healthyCount || 0;
  const webapiTargets = s.targets?.webapi?.healthyCount || 0;
  const pct = s.ready ? 100 : Math.min(95, 20 + ticks * 5 + (atlasTargets + webapiTargets) * 20);
  progress(pct);
  if (s.ready) {{
    msg.textContent = 'Ready. Redirecting to ATLAS.';
    setTimeout(() => window.location.href = s.urls.atlas, 1200);
  }} else {{
    msg.textContent = 'Starting ECS tasks and waiting for target health. This can take a few minutes.';
    setTimeout(poll, 7000);
  }}
}}
btn.addEventListener('click', async () => {{
  btn.disabled = true;
  msg.textContent = 'Sending wake signal...';
  progress(10);
  const r = await fetch('/wake', {{ method: 'POST', cache: 'no-store' }});
  const s = await r.json();
  statusEl.textContent = JSON.stringify(s, null, 2);
  poll();
}});
</script>
</body>
</html>"""


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    # EventBridge scheduled scale-down event
    if event.get("action") == "idle-down":
        return idle_down()

    path = event.get("rawPath") or event.get("path") or "/"
    method = (event.get("requestContext", {}).get("http", {}).get("method") or event.get("httpMethod") or "GET").upper()

    try:
        if path == "/" and method == "GET":
            return html_response(launcher_html())
        if path == "/wake" and method == "POST":
            return response(200, wake())
        if path == "/sleep" and method == "POST":
            return response(200, sleep())
        if path == "/status" and method == "GET":
            return response(200, status_payload())
        return response(404, {"error": "not_found", "path": path, "method": method})
    except Exception as exc:  # keep HTML page alive even when AWS acts like AWS
        return response(500, {"error": type(exc).__name__, "message": str(exc)})
