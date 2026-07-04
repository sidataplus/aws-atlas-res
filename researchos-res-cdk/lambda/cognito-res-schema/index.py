import json
import boto3
from botocore.exceptions import ClientError

cognito = boto3.client("cognito-idp")

REQUIRED_ATTRIBUTES = [
    {
        "Name": "aws_region",
        "AttributeDataType": "String",
        "Mutable": True,
        "Required": False,
        "StringAttributeConstraints": {"MinLength": "0", "MaxLength": "64"},
    },
    {
        "Name": "cluster_name",
        "AttributeDataType": "String",
        "Mutable": True,
        "Required": False,
        "StringAttributeConstraints": {"MinLength": "0", "MaxLength": "128"},
    },
    {
        "Name": "password_last_set",
        "AttributeDataType": "Number",
        "Mutable": True,
        "Required": False,
        "NumberAttributeConstraints": {"MinValue": "0", "MaxValue": "9999999999999"},
    },
    {
        "Name": "password_max_age",
        "AttributeDataType": "Number",
        "Mutable": True,
        "Required": False,
        "NumberAttributeConstraints": {"MinValue": "0", "MaxValue": "9999999999999"},
    },
    {
        "Name": "uid",
        "AttributeDataType": "Number",
        "Mutable": True,
        "Required": False,
        "NumberAttributeConstraints": {"MinValue": "2000200001", "MaxValue": "4294967294"},
    },
]


def _existing_custom_attributes(user_pool_id: str) -> set[str]:
    pool = cognito.describe_user_pool(UserPoolId=user_pool_id)["UserPool"]
    names = set()
    for attr in pool.get("SchemaAttributes", []):
        name = attr.get("Name", "")
        names.add(name)
        if name.startswith("custom:"):
            names.add(name.replace("custom:", "", 1))
    return names


def _ensure_required_attributes(user_pool_id: str) -> list[str]:
    existing = _existing_custom_attributes(user_pool_id)
    missing = [attr for attr in REQUIRED_ATTRIBUTES if attr["Name"] not in existing]

    if not missing:
        return []

    try:
        cognito.add_custom_attributes(
            UserPoolId=user_pool_id,
            CustomAttributes=missing,
        )
    except ClientError as exc:
        message = str(exc)
        # Race-safe-ish behavior. CloudFormation retries are a lifestyle now.
        if "already exists" not in message and "Duplicate" not in message:
            raise

    return [attr["Name"] for attr in missing]


def _ensure_group(user_pool_id: str, group_name: str) -> bool:
    try:
        cognito.get_group(UserPoolId=user_pool_id, GroupName=group_name)
        return False
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise

    cognito.create_group(
        UserPoolId=user_pool_id,
        GroupName=group_name,
        Description=f"Managed by ResearchOsResStack for RES/OHDSI integration: {group_name}",
    )
    return True


def on_event(event, context):
    request_type = event.get("RequestType")
    props = event.get("ResourceProperties", {})
    user_pool_id = props.get("UserPoolId")
    groups = props.get("Groups", [])

    if not user_pool_id:
        raise ValueError("UserPoolId is required")

    if request_type == "Delete":
        # Cognito custom attributes cannot be deleted. No-op by design.
        return {
            "PhysicalResourceId": f"res-cognito-schema-{user_pool_id}",
            "Data": {
                "Deleted": "false",
                "Reason": "Cognito custom attributes are retained"
            },
        }

    added_attributes = _ensure_required_attributes(user_pool_id)

    created_groups = []
    for group in groups:
        if not group:
            continue
        group_name = str(group).strip()
        if not group_name:
            continue
        if len(group_name) > 6 or group_name.lower() != group_name:
            raise ValueError(
                f"RES Cognito group '{group_name}' violates RES constraint: max six lowercase letters"
            )
        if _ensure_group(user_pool_id, group_name):
            created_groups.append(group_name)

    return {
        "PhysicalResourceId": f"res-cognito-schema-{user_pool_id}",
        "Data": {
            "AddedAttributes": ",".join(added_attributes),
            "CreatedGroups": ",".join(created_groups),
        },
    }
