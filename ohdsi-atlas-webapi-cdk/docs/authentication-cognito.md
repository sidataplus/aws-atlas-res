
# Cognito Authentication

## Authentication pattern

This sandbox uses Cognito at the Application Load Balancer layer.

```text
Browser
  -> ALB HTTPS listener
  -> authenticate-cognito action
  -> ATLAS or WebAPI target group
```

This gives a simple perimeter gate for both `/atlas/*` and `/WebAPI/*`.

## Why ALB-level Cognito?

Advantages:

* Simple browser login.
* Works well for sandbox deployments.
* Keeps unauthenticated users away from ATLAS and WebAPI endpoints.
* Avoids WebAPI-native OIDC complexity during initial deployment.

Tradeoffs:

* WebAPI may not receive rich application-level role information.
* OHDSI WebAPI internal permissions are not fully enforced by Cognito alone.
* Programmatic API access is awkward.
* Fine-grained ATLAS/WebAPI authorization still needs WebAPI security configuration or a broker layer.

## Recommended sandbox pattern

```text
Cognito authenticates the browser.
ALB enforces login.
ATLAS and WebAPI are reachable only after login.
```

## Recommended production pattern

```text
Cognito -> ResearchOS / WebAPI Broker -> WebAPI
                         |
                         └── audit, authorization, project policy
```

ATLAS should be treated as an expert/admin interface in production, not the general researcher UX.

## Cognito user pool

The stack creates or configures:

* User Pool
* App client
* Hosted UI domain
* OAuth scopes
* Callback URLs
* Logout URLs

Typical scopes:

```text
openid
email
profile
```

## Callback URLs

For ALB authentication, the callback URL should follow this pattern:

```text
https://\<domain\>/oauth2/idpresponse
```

Common mistake:

```text
https://\<domain\>/atlas/\#/welcome/
```

That is an ATLAS route, not the ALB identity provider callback. Humans see a URL box and immediately feed it the nearest URL-shaped object. Nature is cruel.

## Creating a user

```bash
USER_POOL_ID=$(./scripts/cfn-output.sh OhdsiAtlasWebApiStack CognitoUserPoolId)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username you@example.org \
  --user-attributes Name=email,Value=you@example.org Name=email_verified,Value=true
```

## Logout behavior

Logout usually needs both:

1. ATLAS/WebAPI session cleared, if applicable.
2. Cognito hosted UI logout URL.

For ALB auth, expect session cookies from the ALB and Cognito. Redirect loops usually mean the callback URL, domain, HTTPS listener, or app client settings are wrong.

## WebAPI native security

This CDK sandbox does not fully configure WebAPI-native security by default.

For production, configure one of:

| Option                   | Use when                                      |
| ------------------------ | --------------------------------------------- |
| WebAPI OIDC with Cognito | ATLAS/WebAPI should directly understand users |
| ResearchOS Broker        | ResearchOS owns authz, audit, and governance  |
| ALB auth only            | Sandbox or coarse perimeter protection        |

Cognito authentication is not the same as OHDSI authorization. Login proves identity; it does not prove a user should generate cohorts against a source.
