#!/usr/bin/env bash
#
# Publish the three.ws AWS Marketplace EULA to a public S3 bucket so the
# AWS Marketplace Management Portal "Custom EULA URL" validator can read it.
#
# AWS Marketplace requires the custom EULA to live in a publicly accessible
# S3 bucket. New buckets have Block Public Access ON by default, so this
# script disables it for THIS bucket only and attaches a read-only policy
# scoped to the single EULA object.
#
# Requires: AWS CLI v2, credentials with S3 admin rights (NOT the scoped
# marketplace IAM user from aws-marketplace-provision.sh).
#
# Usage:
#   ./scripts/aws-eula-publish.sh
#
set -euo pipefail

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGION="${AWS_MP_REGION:-us-east-1}"
BUCKET="three-ws-legal-${ACCOUNT_ID}"
KEY="aws-marketplace-eula.html"
SRC="$(cd "$(dirname "$0")/.." && pwd)/public/legal/aws-marketplace-eula.html"

if [[ ! -f "$SRC" ]]; then
  echo "EULA file not found at $SRC" >&2
  exit 1
fi

echo "Account:  $ACCOUNT_ID"
echo "Region:   $REGION"
echo "Bucket:   $BUCKET"
echo

# 1. Create the bucket (idempotent — ignore if it already exists).
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket already exists, reusing it."
else
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
  echo "Bucket created."
fi

# 2. Allow public bucket policies on THIS bucket (leave account-level BPA intact).
aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
echo "Block Public Access relaxed for this bucket."

# 3. Read-only bucket policy scoped to the single EULA object.
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadEULA",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET}/${KEY}"
    }
  ]
}
JSON
)"
echo "Public-read policy attached (scoped to ${KEY} only)."

# 4. Upload the EULA with an explicit HTML content type.
aws s3api put-object \
  --bucket "$BUCKET" \
  --key "$KEY" \
  --body "$SRC" \
  --content-type "text/html; charset=utf-8" >/dev/null
echo "EULA uploaded."

# 5. Print the public URL for the AWS Marketplace portal.
if [[ "$REGION" == "us-east-1" ]]; then
  URL="https://${BUCKET}.s3.amazonaws.com/${KEY}"
else
  URL="https://${BUCKET}.s3.${REGION}.amazonaws.com/${KEY}"
fi

echo
echo "Done. Paste this into AWS Marketplace > Configure EULA > Custom EULA URL:"
echo
echo "  $URL"
echo
echo "Verify it loads publicly:"
echo "  curl -sI \"$URL\" | head -n 1"
