#!/usr/bin/env bash
# Provision AWS resources required for the AWS Marketplace SaaS listing.
#
# Creates:
#   1. SNS topic `three-ws-marketplace-subscription` (us-east-1)
#   2. Topic policy allowing aws-marketplace.amazonaws.com to publish
#   3. IAM user `three-ws-marketplace` with the four marketplace actions
#   4. Access key pair for that user
#
# Prereqs:
#   - aws CLI v2 configured with admin creds on the seller AWS account
#   - jq installed
#
# Outputs are printed at the end; paste them into:
#   - AMMP product page (SNS Topic ARN)
#   - Vercel project env vars (AWS_MP_ACCESS_KEY_ID, AWS_MP_SECRET_ACCESS_KEY)
#
# Idempotent: re-running is safe — existing resources are reused, only new
# access keys are issued if the user has fewer than 2 active keys.

set -euo pipefail

REGION="us-east-1"
TOPIC_NAME="three-ws-marketplace-subscription"
USER_NAME="three-ws-marketplace"
POLICY_NAME="three-ws-marketplace-policy"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "[*] Provisioning on AWS account $ACCOUNT_ID in $REGION"

# ─── 1. SNS topic ────────────────────────────────────────────────────────────
echo "[*] Creating SNS topic $TOPIC_NAME (idempotent)"
TOPIC_ARN="$(aws sns create-topic \
  --name "$TOPIC_NAME" \
  --region "$REGION" \
  --query TopicArn \
  --output text)"
echo "    Topic ARN: $TOPIC_ARN"

# ─── 2. Topic policy: allow AWS Marketplace to publish ───────────────────────
echo "[*] Applying topic policy (allow aws-marketplace.amazonaws.com to publish)"
POLICY_JSON=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowMarketplacePublish",
    "Effect": "Allow",
    "Principal": { "Service": "aws-marketplace.amazonaws.com" },
    "Action": "sns:Publish",
    "Resource": "$TOPIC_ARN",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "$ACCOUNT_ID" }
    }
  }]
}
EOF
)
aws sns set-topic-attributes \
  --topic-arn "$TOPIC_ARN" \
  --attribute-name Policy \
  --attribute-value "$POLICY_JSON" \
  --region "$REGION" >/dev/null

# ─── 3. IAM user + policy ────────────────────────────────────────────────────
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

# ─── 4. Access keys ──────────────────────────────────────────────────────────
EXISTING_KEYS="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'length(AccessKeyMetadata)' --output text)"
if [ "$EXISTING_KEYS" -ge 2 ]; then
  echo "[!] User already has $EXISTING_KEYS access keys (AWS limit is 2)."
  echo "    Delete an existing key first if you need a new one."
  KEY_OUTPUT=""
else
  echo "[*] Issuing new access key"
  KEY_OUTPUT="$(aws iam create-access-key --user-name "$USER_NAME")"
fi

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "DONE. Paste these values into Vercel env vars + AMMP."
echo "════════════════════════════════════════════════════════════════════════"
echo ""
echo "AWS_MP_SNS_TOPIC_ARN=$TOPIC_ARN"
echo "AWS_MP_REGION=$REGION"
if [ -n "$KEY_OUTPUT" ]; then
  ACCESS_KEY_ID="$(echo "$KEY_OUTPUT" | jq -r .AccessKey.AccessKeyId)"
  SECRET_ACCESS_KEY="$(echo "$KEY_OUTPUT" | jq -r .AccessKey.SecretAccessKey)"
  echo "AWS_MP_ACCESS_KEY_ID=$ACCESS_KEY_ID"
  echo "AWS_MP_SECRET_ACCESS_KEY=$SECRET_ACCESS_KEY"
  echo ""
  echo "[!] The secret access key is shown ONCE. Save it now."
fi
echo ""
echo "AWS_MP_PRODUCT_CODE = <assigned by AMMP after product creation>"
echo ""
echo "Next steps:"
echo "  1. Set the env vars above in Vercel (production + preview)"
echo "  2. In AMMP → Products → SaaS → Create new SaaS product"
echo "  3. Paste the SNS Topic ARN into the product's notification topic field"
echo "  4. AMMP will assign the AWS_MP_PRODUCT_CODE — add it to Vercel"
echo "  5. Submit limited (private) listing for end-to-end test"
