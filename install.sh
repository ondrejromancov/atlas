#!/usr/bin/env bash
# Symlink Atlas Claude Code commands, agents, and wrapper scripts into ~/.claude.
# Usage: ./install.sh

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$script_dir
claude_dir=${HOME:?}/.claude
timestamp=$(date +%Y%m%d%H%M%S)

linked_count=0
backup_count=0
up_to_date_count=0

backup_destination() {
  local dest=$1
  local backup=$dest.bak.$timestamp
  local suffix=1

  while [[ -e "$backup" || -L "$backup" ]]; do
    backup=$dest.bak.$timestamp.$suffix
    suffix=$((suffix + 1))
  done

  mv -- "$dest" "$backup"
  backup_count=$((backup_count + 1))
  echo "Moved existing $dest to $backup"
}

ensure_link() {
  local target=$1
  local dest=$2
  local parent
  local current

  parent=$(dirname -- "$dest")
  mkdir -p -- "$parent"

  if [[ -L "$dest" ]]; then
    current=$(readlink -- "$dest")
    if [[ "$current" == "$target" ]]; then
      up_to_date_count=$((up_to_date_count + 1))
      echo "$dest up to date"
      return
    fi
    backup_destination "$dest"
  elif [[ -e "$dest" ]]; then
    backup_destination "$dest"
  fi

  ln -s -- "$target" "$dest"
  linked_count=$((linked_count + 1))
  echo "Linked $dest -> $target"
}

mkdir -p -- "$claude_dir/commands" "$claude_dir/agents" "$claude_dir/atlas"

ensure_link "$repo_root/commands/atlas.md" "$claude_dir/commands/atlas.md"

shopt -s nullglob
agent_files=("$repo_root"/agents/atlas-*.md)
shopt -u nullglob

for agent_file in "${agent_files[@]}"; do
  ensure_link "$agent_file" "$claude_dir/agents/$(basename -- "$agent_file")"
done

ensure_link "$repo_root/scripts" "$claude_dir/atlas/scripts"

echo "Summary: linked $linked_count target(s), backed up $backup_count existing path(s), and found $up_to_date_count link(s) already up to date under $claude_dir."
