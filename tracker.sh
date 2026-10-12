#!/usr/bin/env bash
# Shell entry point for the configured ticket tracker.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/lib/tracker/adapters/dispatch.sh" "$@"
