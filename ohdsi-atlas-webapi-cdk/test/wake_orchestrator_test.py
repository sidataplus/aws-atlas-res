import importlib
import os
import sys
import types
import unittest


class FakeClient:
    def __init__(self, service_name):
        self.service_name = service_name
        self.updated_services = []

    def update_service(self, **kwargs):
        self.updated_services.append(kwargs)

    def describe_services(self, **kwargs):
        return {
            "services": [
                {
                    "serviceName": os.environ["ATLAS_SERVICE"],
                    "desiredCount": 1,
                    "runningCount": 1,
                    "pendingCount": 0,
                    "status": "ACTIVE",
                    "deployments": [],
                },
                {
                    "serviceName": os.environ["WEBAPI_SERVICE"],
                    "desiredCount": 1,
                    "runningCount": 1,
                    "pendingCount": 0,
                    "status": "ACTIVE",
                    "deployments": [],
                },
            ]
        }

    def describe_target_health(self, **kwargs):
        return {"TargetHealthDescriptions": []}

    def get_metric_statistics(self, **kwargs):
        dimensions = {
            item["Name"]: item["Value"]
            for item in kwargs.get("Dimensions", [])
        }
        if "LoadBalancer" in dimensions and "TargetGroup" not in dimensions:
            return {"Datapoints": [{"Sum": 3.0}]}
        return {"Datapoints": []}


class WakeOrchestratorTest(unittest.TestCase):
    def setUp(self):
        self.clients = {}
        fake_boto3 = types.SimpleNamespace(client=self.client)
        sys.modules["boto3"] = fake_boto3
        os.environ.update({
            "ECS_CLUSTER": "cluster",
            "ATLAS_SERVICE": "atlas",
            "WEBAPI_SERVICE": "webapi",
            "DESIRED_COUNT_ON_WAKE": "1",
            "IDLE_SCALE_DOWN_MINUTES": "30",
            "ATLAS_TG_ARN": "atlas-tg-arn",
            "WEBAPI_TG_ARN": "webapi-tg-arn",
            "ATLAS_TG_FULL_NAME": "targetgroup/atlas/123",
            "WEBAPI_TG_FULL_NAME": "targetgroup/webapi/123",
            "LOAD_BALANCER_FULL_NAME": "app/alb/123",
            "ALB_BASE_URL": "https://example.test",
            "ATLAS_URL": "https://example.test/atlas/",
            "WEBAPI_INFO_URL": "https://example.test/WebAPI/info",
        })
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))
        sys.modules.pop("wake_orchestrator", None)
        self.module = importlib.import_module("wake_orchestrator")

    def client(self, service_name):
        client = FakeClient(service_name)
        self.clients[service_name] = client
        return client

    def test_idle_down_keeps_services_running_when_alb_has_recent_auth_activity(self):
        result = self.module.idle_down()

        self.assertEqual("kept_running", result["action"])
        self.assertEqual(3.0, result["loadBalancerRequestCount"])
        self.assertEqual([], self.clients["ecs"].updated_services)


if __name__ == "__main__":
    unittest.main()
