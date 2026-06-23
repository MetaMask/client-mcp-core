#!/usr/bin/env bash

set -e
set -o pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  yarn build:ios-runner && yarn build:axsnapshot
else
  echo "Skipping native sanity check on non-Darwin"
fi
