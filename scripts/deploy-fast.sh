#!/usr/bin/env bash
# Despliegue rápido sin CloudFormation: actualiza el código de las Lambdas y el dashboard.
# Uso: scripts/deploy-fast.sh [api|dashboard|all]   (env: ENV=dev, AWS_REGION=us-east-1)
# La infraestructura (IAM, tablas, URLs) sigue en infra/ (CDK); esto solo sube código.
set -euo pipefail

ENV="${ENV:-dev}"
PREFIX="magicode-${ENV}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
WHAT="${1:-all}"

bundle_lambda() { # $1 = entry (ruta relativa al repo), $2 = función
  local entry="$1" fn="$2" dir="$OUT/$2"
  mkdir -p "$dir"
  npx esbuild "$ROOT/$entry" --bundle --platform=node --target=node22 --format=cjs --minify \
    --sourcemap --external:@aws-sdk/* --external:pg-native --outfile="$dir/index.js" --log-level=warning
  (cd "$dir" && zip -qr ../"$fn".zip .)
  aws lambda update-function-code --function-name "$PREFIX-$fn" --zip-file "fileb://$OUT/$fn.zip" \
    --query 'LastUpdateStatus' --output text | xargs echo "  $PREFIX-$fn:"
}

deploy_api() {
  echo "▸ build contracts/metrics"
  npm run build -w @magicode/contracts -w @magicode/metrics --silent >/dev/null
  echo "▸ Lambdas"
  bundle_lambda apps/api/src/index.ts api
  bundle_lambda apps/api/src/projector.ts projector
  bundle_lambda apps/api/src/task-sync.ts task-sync
  bundle_lambda apps/api/src/migrator.ts migrator
}

deploy_dashboard() {
  echo "▸ build dashboard"
  npm run build -w @magicode/dashboard --silent >/dev/null
  local bucket dist
  bucket=$(aws cloudformation describe-stacks --stack-name "MagicodeStack-${ENV}" \
    --query "Stacks[0].Outputs[?OutputKey=='DashboardBucket'].OutputValue" --output text)
  dist=$(aws cloudformation describe-stacks --stack-name "MagicodeStack-${ENV}" \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
  # config.json lo escribe el stack (apiUrl, demoMode): no se pisa.
  aws s3 sync "$ROOT/apps/dashboard/dist/dashboard/browser" "s3://$bucket/" \
    --exclude config.json --delete --only-show-errors
  aws s3 cp "$ROOT/apps/dashboard/dist/dashboard/browser/index.html" "s3://$bucket/index.html" \
    --cache-control no-cache --content-type text/html --only-show-errors
  aws cloudfront create-invalidation --distribution-id "$dist" --paths '/*' \
    --query Invalidation.Status --output text | xargs echo "  CloudFront:"
}

case "$WHAT" in
  api) deploy_api ;;
  dashboard) deploy_dashboard ;;
  all) deploy_api; deploy_dashboard ;;
  *) echo "uso: $0 [api|dashboard|all]"; exit 1 ;;
esac
echo "✓ listo ($WHAT)"
