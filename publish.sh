#!/bin/bash
set -euo pipefail

# Publish the exact archive that passed CI, without rebuilding it. Supply
# credentials through the environment (for example with `op run`).
if [[ $# == 1 ]]; then
  registry=all
  archive=$1
elif [[ $# == 2 ]]; then
  registry=$1
  archive=$2
else
  echo "Usage: ./publish.sh [all|marketplace|open-vsx] extension.vsix" >&2
  exit 1
fi
if [[ ! -f "$archive" ]]; then
  echo "VSIX does not exist: $archive" >&2
  exit 1
fi
case "$registry" in
  all|marketplace|open-vsx) ;;
  *) echo "Unknown registry: $registry" >&2; exit 1 ;;
esac
if [[ "$registry" != open-vsx ]]; then
  : "${VSCE_PAT:?Set VSCE_PAT using your secret manager}"
fi
if [[ "$registry" != marketplace ]]; then
  : "${OVSX_PAT:?Set OVSX_PAT using your secret manager}"
fi

yarn verify:package "$archive"
if [[ "$registry" != open-vsx ]]; then
  yarn vsce publish --packagePath "$archive"
fi
if [[ "$registry" != marketplace ]]; then
  npx --yes ovsx@1.3.0 publish "$archive"
fi
