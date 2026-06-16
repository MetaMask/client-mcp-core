#!/usr/bin/env bash

set -e
set -o pipefail

if [[ -n $SKIP_PREPACK ]]; then
  echo "Notice: skipping prepack."
  exit 0
fi

yarn build
yarn build:native:sanity

chmod +x dist/cli/mm.cjs
