#!/usr/bin/env bash
# Provision the AWS-side resources the three.ws AWS Marketplace SaaS listing needs.
#
# Creates, idempotently:
#   1. IAM user `three-ws-marketplace` + inline policy + access key
#      (ResolveCustomer / BatchMeterUsage / MeterUsage / GetEntitlements)
#   2. An EventBridge connection holding the shared secret header
#   3. An EventBridge API destination pointing at the lifecycle webhook
#   4. An IAM role EventBridge assumes to invoke that destination
#   5. An SQS dead-letter queue for relays the webhook rejects
#   6. An EventBridge rule on the default bus matching
#      `source: aws.agreement-marketplace`, targeting the API destination
#
# Why EventBridge and not SNS: AWS Marketplace made the Concurrent Agreements
# integration mandatory for new SaaS products on 2026-06-01. Lifecycle events for
# a new listing land on the seller account's DEFAULT event bus, and SNS does not
# carry the LicenseArn those events are keyed on. The seller never supplies an
# SNS topic ARN either. AWS creates and owns the notification topics and hands
# them over on the product overview page AFTER product creation. An earlier
# version of this script created a `three-ws-marketplace-subscription` topic that
# nothing consumed; this version does not recreate it. If a previous run left one
# on the account, delete it (`aws sns delete-topic`) so nobody mistakes it for
# the listing's real notification topic.
#
# EventBridge cannot POST to an external HTTPS endpoint on its own, which is why
# the rule targets an API destination. The destination's connection attaches the
# `x-three-ws-marketplace-secret` header, and the webhook refuses any delivery
# that does not carry it, and that header is the whole authentication story for
# relay, so treat the generated secret like a credential.
#
# Prereqs:
#   - aws CLI v2 configured with admin creds on seller account 155407237916
#   - jq and openssl installed
#
# Env overrides:
#   AWS_MP_EVENT_SECRET   reuse an existing secret instead of generating one
#   WEBHOOK_URL           override the target endpoint (default https://three.ws/...)
#
# Re-running is safe: existing resources are updated in place, and a new access
# key is only issued when the user has room for one (AWS allows 2).

set -euo pipefail

REGION="us-east-1"
USER_NAME="three-ws-marketplace"
POLICY_NAME="three-ws-marketplace-policy"
CONNECTION_NAME="three-ws-marketplace-connection"
DESTINATION_NAME="three-ws-marketplace-webhook"
RULE_NAME="three-ws-marketplace-agreements"
ROLE_NAME="three-ws-marketplace-eventbridge"
DLQ_NAME="three-ws-marketplace-dlq"
SECRET_HEADER="x-three-ws-marketplace-secret"
WEBHOOK_URL="${WEBHOOK_URL:-https://three.ws/api/aws-marketplace/subscription}"

for tool in aws jq openssl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "[!] $tool is required" >&2; exit 1; }
done

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "[*] Provisioning on AWS account $ACCOUNT_ID in $REGION"

EVENT_SECRET="${AWS_MP_EVENT_SECRET:-$(openssl rand -hex 32)}"
SECRET_WAS_GENERATED=$([ -n "${AWS_MP_EVENT_SECRET:-}" ] && echo "no" || echo "yes")

# ─── 1. IAM user + policy ────────────────────────────────────────────────────
echo "[*] Creating IAM user $USER_NAME (idempotent)"
if ! aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  aws iam create-user --user-name "$USER_NAME" >/dev/null
fi

echo "[*] Attaching inline policy $POLICY_NAME"
aws iam put-user-policy \
  --user-name "$USER_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "aws-marketplace:ResolveCustomer",
        "aws-marketplace:BatchMeterUsage",
        "aws-marketplace:MeterUsage",
        "aws-marketplace:GetEntitlements"
      ],
      "Resource": "*"
    }]
  }'

EXISTING_KEYS="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)"
if [ "$EXISTING_KEYS" -ge 2 ]; then
  echo "[!] User already has $EXISTING_KEYS access keys (AWS limit is 2)."
  echo "    Delete an existing key first if you need a new one."
  KEY_OUTPUT=""
else
  echo "[*] Issuing new access key"
  KEY_OUTPUT="$(aws iam create-access-key --user-name "$USER_NAME")"
fi

# ─── 2. EventBridge connection (carries the shared secret) ───────────────────
echo "[*] Creating EventBridge connection $CONNECTION_NAME (idempotent)"
AUTH_PARAMS="$(jq -nc --arg name "$SECRET_HEADER" --arg value "$EVENT_SECRET" \
  '{ApiKeyAuthParameters: {ApiKeyName: $name, ApiKeyValue: $value}}')"

if aws events describe-connection --name "$CONNECTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  CONNECTION_ARN="$(aws events update-connection \
    --name "$CONNECTION_NAME" \
    --authorization-type API_KEY \
    --auth-parameters "$AUTH_PARAMS" \
    --region "$REGION" \
    --query ConnectionArn --output text)"
else
  CONNECTION_ARN="$(aws events create-connection \
    --name "$CONNECTION_NAME" \
    --description "Shared secret header for the three.ws AWS Marketplace lifecycle webhook" \
    --authorization-type API_KEY \
    --auth-parameters "$AUTH_PARAMS" \
    --region "$REGION" \
    --query ConnectionArn --output text)"
fi
echo "    Connection: $CONNECTION_ARN"

# A connection becomes usable only once its secret has been stored. Targeting an
# AUTHORIZING destination fails at put-targets, so wait it out rather than
# leaving the operator to re-run the script and wonder why.
echo "[*] Waiting for the connection to become AUTHORIZED"
for _ in $(seq 1 30); do
  STATE="$(aws events describe-connection --name "$CONNECTION_NAME" --region "$REGION" --query ConnectionState --output text)"
  [ "$STATE" = "AUTHORIZED" ] && break
  sleep 2
done
[ "$STATE" = "AUTHORIZED" ] || { echo "[!] Connection stuck in state $STATE" >&2; exit 1; }

# ─── 3. API destination ──────────────────────────────────────────────────────
echo "[*] Creating API destination $DESTINATION_NAME → $WEBHOOK_URL (idempotent)"
if aws events describe-api-destination --name "$DESTINATION_NAME" --region "$REGION" >/dev/null 2>&1; then
  DESTINATION_ARN="$(aws events update-api-destination \
    --name "$DESTINATION_NAME" \
    --connection-arn "$CONNECTION_ARN" \
    --invocation-endpoint "$WEBHOOK_URL" \
    --http-method POST \
    --invocation-rate-limit-per-second 20 \
    --region "$REGION" \
    --query ApiDestinationArn --output text)"
else
  DESTINATION_ARN="$(aws events create-api-destination \
    --name "$DESTINATION_NAME" \
    --description "three.ws AWS Marketplace agreement + license lifecycle webhook" \
    --connection-arn "$CONNECTION_ARN" \
    --invocation-endpoint "$WEBHOOK_URL" \
    --http-method POST \
    --invocation-rate-limit-per-second 20 \
    --region "$REGION" \
    --query ApiDestinationArn --output text)"
fi
echo "    Destination: $DESTINATION_ARN"

# ─── 4. Dead-letter queue ────────────────────────────────────────────────────
# A lifecycle event that the webhook 5xxs is the one event we cannot afford to
# drop: it is the difference between a cancelled buyer losing access and keeping
# it. EventBridge retries, then discards, unless a DLQ is attached.
echo "[*] Creating dead-letter queue $DLQ_NAME (idempotent)"
DLQ_URL="$(aws sqs create-queue --queue-name "$DLQ_NAME" --region "$REGION" --query QueueUrl --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --region "$REGION" --query 'Attributes.QueueArn' --output text)"
aws sqs set-queue-attributes \
  --queue-url "$DLQ_URL" \
  --region "$REGION" \
  --attributes "$(jq -nc --arg arn "$DLQ_ARN" --arg account "$ACCOUNT_ID" '{
    Policy: ({
      Version: "2012-10-17",
      Statement: [{
        Sid: "AllowEventBridgeDeadLetter",
        Effect: "Allow",
        Principal: { Service: "events.amazonaws.com" },
        Action: "sqs:SendMessage",
        Resource: $arn,
        Condition: { StringEquals: { "aws:SourceAccount": $account } }
      }]
    } | tostring)
  }')" >/dev/null
echo "    DLQ: $DLQ_ARN"

# ─── 5. IAM role EventBridge assumes to invoke the destination ───────────────
echo "[*] Creating IAM role $ROLE_NAME (idempotent)"
TRUST_POLICY="$(jq -nc --arg account "$ACCOUNT_ID" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Service: "events.amazonaws.com" },
    Action: "sts:AssumeRole",
    Condition: { StringEquals: { "aws:SourceAccount": $account } }
  }]
}')"
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$TRUST_POLICY" >/dev/null
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" >/dev/null
fi
ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "invoke-api-destination" \
  --policy-document "$(jq -nc --arg arn "$DESTINATION_ARN" '{
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "events:InvokeApiDestination", Resource: $arn }]
  }')"
echo "    Role: $ROLE_ARN"

# ─── 6. Rule on the default bus ──────────────────────────────────────────────
# AWS Marketplace delivers agreement and license events to the DEFAULT bus of
# the seller account. The pattern matches the whole source rather than an
# enumerated detail-type list so a new event type AWS adds still reaches the
# webhook, which acknowledges anything it takes no action on.
echo "[*] Creating rule $RULE_NAME on the default event bus (idempotent)"
RULE_ARN="$(aws events put-rule \
  --name "$RULE_NAME" \
  --event-bus-name default \
  --description "Relay AWS Marketplace agreement + license events to three.ws" \
  --event-pattern '{"source":["aws.agreement-marketplace"]}' \
  --state ENABLED \
  --region "$REGION" \
  --query RuleArn --output text)"
echo "    Rule: $RULE_ARN"

# IAM role propagation can lag rule creation by a few seconds; put-targets fails
# with a validation error rather than retrying on its own.
sleep 5
aws events put-targets \
  --rule "$RULE_NAME" \
  --event-bus-name default \
  --region "$REGION" \
  --targets "$(jq -nc --arg arn "$DESTINATION_ARN" --arg role "$ROLE_ARN" --arg dlq "$DLQ_ARN" '[{
    Id: "three-ws-webhook",
    Arn: $arn,
    RoleArn: $role,
    DeadLetterConfig: { Arn: $dlq },
    RetryPolicy: { MaximumRetryAttempts: 10, MaximumEventAgeInSeconds: 3600 }
  }]')" >/dev/null

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "DONE. Set these on the Cloud Run service (production env lives there)."
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "AWS_MP_REGION=$REGION"
if [ "$SECRET_WAS_GENERATED" = "yes" ]; then
  echo "AWS_MP_EVENT_SECRET=$EVENT_SECRET"
  echo "    ^ generated now and stored in the EventBridge connection. Save it."
else
  echo "AWS_MP_EVENT_SECRET=<unchanged; reused from the environment>"
fi
if [ -n "$KEY_OUTPUT" ]; then
  echo "AWS_MP_ACCESS_KEY_ID=$(echo "$KEY_OUTPUT" | jq -r .AccessKey.AccessKeyId)"
  echo "AWS_MP_SECRET_ACCESS_KEY=$(echo "$KEY_OUTPUT" | jq -r .AccessKey.SecretAccessKey)"
  echo "    ^ the secret access key is shown ONCE. Save it now."
fi
echo ""
echo "AWS_MP_PRODUCT_CODE = <assigned by AMMP after product creation, add it last>"
echo ""
echo "Apply with (--update-env-vars MERGES; --set-env-vars would wipe every other var):"
echo "  gcloud run services update three-ws-api --region us-central1 \\"
echo "    --update-env-vars AWS_MP_ACCESS_KEY_ID=…,AWS_MP_SECRET_ACCESS_KEY=…,AWS_MP_REGION=$REGION,AWS_MP_EVENT_SECRET=…"
echo ""
echo "Next steps:"
echo "  1. Set the env vars above on Cloud Run."
echo "  2. AMMP → AI agents & tools products → Create, delivery method API-based (SaaS)."
echo "     Registration URL: https://three.ws/api/aws-marketplace/register"
echo "     Pricing: Free. EULA: Standard Contract (SCMP)."
echo "  3. AMMP assigns the product code. Set AWS_MP_PRODUCT_CODE on Cloud Run."
echo "  4. Check the product overview page for the notification configuration AWS"
echo "     issued. If it also lists a legacy aws-mp-subscription-notification-<code>"
echo "     SNS topic, set AWS_MP_SNS_TOPIC_ARN to THAT ARN (never a self-created one)"
echo "     and add an HTTPS subscription to $WEBHOOK_URL as a secondary leg."
echo "  5. Subscribe from a test account while the listing is limited, and confirm"
echo "     the register → welcome → issue-key round trip."
echo "  6. Request changes → Update visibility → Public (AWS Seller Operations"
echo "     review, 7-10 business days)."
