
set -euo pipefail

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
MAX_RECEIVE_COUNT="${MAX_RECEIVE_COUNT:-5}"

aws_cli() { aws --endpoint-url "$ENDPOINT" "$@"; }

DLQ_URL=$(aws_cli sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl --output text)

DLQ_ARN=$(aws_cli sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)

ATTRS_FILE="$(mktemp)"
cat > "$ATTRS_FILE" <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

aws_cli sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "file://${ATTRS_FILE}" >/dev/null
rm -f "$ATTRS_FILE"

echo "SQS queues ready: wager-transactions.fifo (DLQ after ${MAX_RECEIVE_COUNT} receives)"
