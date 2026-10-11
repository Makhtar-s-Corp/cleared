#!/usr/bin/env bash
# Copy legacy Cleared paths to their new names. No source is removed.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
mode=${1:---dry-run}
case "$mode" in --dry-run|--apply) ;; *) echo 'usage: migrate-from-ferme.sh [--dry-run|--apply]' >&2; exit 2 ;; esac
copy_if_missing() {
  local source=$1 target=$2
  [ -e "$source" ] || return 0
  if [ -e "$target" ]; then printf 'keep %s (already exists)\n' "$target"; return 0; fi
  printf 'copy %s -> %s\n' "$source" "$target"
  if [ "$mode" = --apply ]; then mkdir -p "$(dirname "$target")"; cp -a -- "$source" "$target"; fi
}
copy_if_missing "$ORCH_REPO/.ferme" "$ORCH_REPO/.cleared"
copy_if_missing "${XDG_CONFIG_HOME:-$HOME/.config}/ferme/project" "${XDG_CONFIG_HOME:-$HOME/.config}/cleared/project"
copy_if_missing "${XDG_STATE_HOME:-$HOME/.local/state}/ferme/$(basename "$ORCH_REPO")" "${XDG_STATE_HOME:-$HOME/.local/state}/cleared/$(basename "$ORCH_REPO")"
for source in "$HOME"/.config/systemd/user/ferme-*; do
  [ -e "$source" ] || continue
  target=${source/\/ferme-/\/cleared-}
  if [ ! -e "$target" ]; then
    copy_if_missing "$source" "$target"
    if [ "$mode" = --apply ]; then sed -i 's/ferme-/cleared-/g' "$target"; fi
  fi
done
printf 'Run serve/install.sh after applying to enable the new services. Legacy files stay in place.\n'
