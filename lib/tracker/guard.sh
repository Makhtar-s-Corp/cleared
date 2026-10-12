#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")/.." && pwd)/common.sh"
[ -f "${1:-}" ] || die "no text file to check"
guard_text "$1"
