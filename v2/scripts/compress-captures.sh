#!/usr/bin/env bash
# Shrink the committed PNG captures under a folder (default docs/v2/ui-polish).
# Needs pngquant and optipng on the PATH; no npm dependency.
set -euo pipefail
dir="${1:-docs/v2/ui-polish}"
before=$(du -sb "$dir" | cut -f1)
find "$dir" -name '*.png' -print0 | xargs -0 -r pngquant --quality=80-95 --skip-if-larger --force --ext .png || true
find "$dir" -name '*.png' -print0 | xargs -0 -r optipng -quiet -o2
after=$(du -sb "$dir" | cut -f1)
echo "$dir: $before -> $after bytes"
