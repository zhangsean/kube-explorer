#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BASE_OUT="${1:-kube-explorer-linux-amd64}"
MIN_OUT="${2:-kube-explorer-linux-amd64-min}"
UPX_OUT="${3:-kube-explorer-linux-amd64-min.upx}"

echo "==> Building base linux/amd64 binary: ${BASE_OUT}"
GOOS=linux GOARCH=amd64 go build -tags embed -o "${BASE_OUT}" .

echo "==> Building minimized linux/amd64 binary: ${MIN_OUT}"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 GOMAXPROCS=2 \
  go build -p 1 -tags embed -trimpath -ldflags "-s -w -buildid=" -o "${MIN_OUT}" .

if command -v upx >/dev/null 2>&1; then
  echo "==> UPX compressing: ${UPX_OUT}"
  cp -f "${MIN_OUT}" "${UPX_OUT}"
  upx --best --lzma -q "${UPX_OUT}"
else
  echo "==> UPX not found, skipping UPX compression"
fi

echo
echo "==> Output sizes"
wc -c "${BASE_OUT}" "${MIN_OUT}" 2>/dev/null || true
if [ -f "${UPX_OUT}" ]; then
  wc -c "${UPX_OUT}"
fi

echo
echo "Done."
