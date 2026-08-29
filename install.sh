#!/usr/bin/env bash
#
# install.sh — wire this repo into the live pi config via symlinks.
#
# The repo is the source of truth. Files under ~/.pi/agent and ~/.agents/skills
# are replaced with symlinks pointing into this repo, so edits here are picked
# up by pi immediately (extensions on /reload or restart).
#
# Usage:
#   ./install.sh            Link everything (backs up any existing real files)
#   ./install.sh --status   Show link status without changing anything
#   ./install.sh --restore  Restore all backups made by a previous run
#
# Excluded by design: MCP servers (~/.pi/mcp.json), auth.json, caches,
# sessions, npm packages (pi manages those itself).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="$HOME/.my-pi-backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
# NOTE: backups must NOT be left inside ~/.pi/agent/extensions/ or
# ~/.agents/skills/ — pi scans those directories recursively and would load
# backup copies as duplicate extensions/skills. All backups go to BACKUP_ROOT.

# ── Link map ────────────────────────────────────────────────────────────────
# repo path (relative) | target path (absolute, supports $HOME)
LINKS=(
  "pi/agent/extensions/startup-banner.ts|$HOME/.pi/agent/extensions/startup-banner.ts"
  "pi/agent/extensions/atuin.ts|$HOME/.pi/agent/extensions/atuin.ts"
  "pi/agent/extensions/ask|$HOME/.pi/agent/extensions/ask"
  "pi/agent/pi-coding-agent.svg|$HOME/.pi/agent/pi-coding-agent.svg"
  "pi/settings.json|$HOME/.pi/agent/settings.json"
  "skills/caveman|$HOME/.agents/skills/caveman"
  "skills/caveman-commit|$HOME/.agents/skills/caveman-commit"
  "skills/caveman-compress|$HOME/.agents/skills/caveman-compress"
  "skills/caveman-help|$HOME/.agents/skills/caveman-help"
  "skills/caveman-review|$HOME/.agents/skills/caveman-review"
  "skills/caveman-stats|$HOME/.agents/skills/caveman-stats"
  "skills/cavecrew|$HOME/.agents/skills/cavecrew"
  "skills/pr-readiness|$HOME/.agents/skills/pr-readiness"
  "skills/project-recap|$HOME/.agents/skills/project-recap"
  "skills/session-recap|$HOME/.agents/skills/session-recap"
  "skills/obsidian-ingest|$HOME/.agents/skills/obsidian-ingest"
  "skills/graphify-vault-query|$HOME/.agents/skills/graphify-vault-query"
)

# Skill directories tracked here and now installed (reworked to be
# vault-agnostic in v2):
GENERIC_SKILLS=(
  "obsidian-ingest"
  "graphify-vault-query"
)

backup_target() {
  local target="$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ]; then
      # Existing symlink: just remove it (its source lives elsewhere).
      rm "$target"
    else
      # Preserve path structure inside the backup root so restores are unambiguous.
      local safe_name
      safe_name="$(echo "$target" | sed "s|^$HOME|HOME|; s|/|_|g")"
      mkdir -p "$BACKUP_ROOT/$TIMESTAMP"
      local backup="$BACKUP_ROOT/$TIMESTAMP/$safe_name"
      mv "$target" "$backup"
      printf '%s\t%s\n' "$target" "$safe_name" >>"$BACKUP_ROOT/$TIMESTAMP/manifest"
      echo "  backed up: $target -> $backup"
    fi
  fi
}

link_one() {
  local repo_path="$1"
  local target="$2"

  if [ ! -e "$REPO_DIR/$repo_path" ]; then
    echo "  ERROR: repo file missing: $repo_path" >&2
    return 1
  fi

  mkdir -p "$(dirname "$target")"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$REPO_DIR/$repo_path" ]; then
    echo "  already linked: $target"
    return 0
  fi

  backup_target "$target"
  ln -s "$REPO_DIR/$repo_path" "$target"
  echo "  linked: $target -> $repo_path"
}

status_one() {
  local repo_path="$1"
  local target="$2"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$REPO_DIR/$repo_path" ]; then
    echo "  OK       $target"
  elif [ -L "$target" ]; then
    echo "  FOREIGN  $target -> $(readlink "$target")"
  elif [ -e "$target" ]; then
    echo "  REAL     $target (not linked — run ./install.sh)"
  else
    echo "  MISSING  $target"
  fi
}

restore_all() {
  # Restore from the most recent backup set using its manifest.
  if [ ! -d "$BACKUP_ROOT" ]; then
    echo "No backups found at $BACKUP_ROOT"
    return 0
  fi
  local latest
  latest="$(ls -d "$BACKUP_ROOT"/*/ 2>/dev/null | sort | tail -1)"
  if [ -z "$latest" ] || [ ! -f "$latest/manifest" ]; then
    echo "No backup manifest found in $BACKUP_ROOT"
    return 0
  fi
  latest="${latest%/}"
  echo "Restoring from $latest ..."
  local restored=0 target backup
  while IFS=$'\t' read -r target backup; do
    [ -n "$target" ] && [ -e "$latest/$backup" ] || continue
    if [ -L "$target" ]; then rm "$target"; fi
    mv "$latest/$backup" "$target"
    echo "  restored: $target"
    restored=1
  done <"$latest/manifest"
  [ "$restored" -eq 1 ] || echo "  backup set is empty."
  rm -f "$latest/manifest"
  rmdir "$latest" 2>/dev/null || true
}

case "${1:-}" in
  --status)
    echo "my-pi link status (repo: $REPO_DIR)"
    for entry in "${LINKS[@]}"; do
      IFS='|' read -r repo_path target <<<"$entry"
      status_one "$repo_path" "$target"
    done
    ;;
  --restore)
    restore_all
    ;;
  install|"")
    echo "Installing my-pi config -> symlinks into live pi config..."
    for entry in "${LINKS[@]}"; do
      IFS='|' read -r repo_path target <<<"$entry"
      link_one "$repo_path" "$target"
    done
    echo ""
    echo "Done. Restart pi or run /reload to pick up extension changes."
    echo ""
    echo "Vault-agnostic skills now installed: ${GENERIC_SKILLS[*]}"
    echo "Optional: run 'atuin hook install pi' if you use atuin (extension no-ops safely without it)."
    ;;
  *)
    echo "Usage: $0 [--status|--restore]" >&2
    exit 1
    ;;
esac
