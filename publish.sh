#!/bin/bash
set -euo pipefail

# Publish the exact archive that passed CI, without rebuilding it. Supply
# credentials through the environment (for example with `op run`).
if [[ $# != 1 || ! -f "$1" ]]; then
  echo "Usage: VSCE_PAT=... OVSX_PAT=... ./publish.sh extension.vsix" >&2
  exit 1
fi
: "${VSCE_PAT:?Set VSCE_PAT using your secret manager}"
: "${OVSX_PAT:?Set OVSX_PAT using your secret manager}"

yarn verify:package "$1"
yarn vsce publish --packagePath "$1"
npx --yes ovsx@1.3.0 publish "$1"
