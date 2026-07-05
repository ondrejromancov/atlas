#!/usr/bin/env bash
# Run a ticket through codex with deterministic flags, stdin closed, logging, and dud detection.
# Usage: run-codex.sh <ticket-file> [--model M] [--effort E] [--cd DIR] [--local] [--provider lmstudio|ollama]

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-codex.sh <ticket-file> [--model M] [--effort E] [--cd DIR] [--local] [--provider lmstudio|ollama]
USAGE
}

require_value() {
  local option=$1
  local value=${2-}
  if [[ -z "$value" ]]; then
    echo "Missing value for $option" >&2
    usage
    exit 2
  fi
}

resolve_existing_file() {
  local path=$1
  local dir
  local base

  if [[ ! -f "$path" ]]; then
    echo "Ticket file not found: $path" >&2
    exit 2
  fi

  dir=$(dirname -- "$path")
  base=$(basename -- "$path")
  dir=$(cd -- "$dir" && pwd -P)
  printf '%s/%s\n' "$dir" "$base"
}

resolve_existing_dir() {
  local path=$1

  if [[ ! -d "$path" ]]; then
    echo "Directory not found: $path" >&2
    exit 2
  fi

  cd -- "$path" && pwd -P
}

is_git_dir() {
  local dir=$1
  git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

snapshot_git() {
  local dir=$1
  local out=$2

  {
    echo "STATUS"
    git -C "$dir" status --porcelain=v1 --untracked-files=all
    echo "DIFF"
    if git -C "$dir" rev-parse --verify HEAD >/dev/null 2>&1; then
      git -C "$dir" diff --binary --no-ext-diff HEAD -- .
    else
      git -C "$dir" diff --binary --no-ext-diff --cached -- .
    fi
    echo "UNTRACKED"
    git -C "$dir" ls-files --others --exclude-standard -z |
      while IFS= read -r -d '' path; do
        if [[ -f "$dir/$path" ]]; then
          printf '%s  %s\n' "$(git -C "$dir" hash-object --no-filters -- "$path")" "$path"
        fi
      done
  } >"$out"
}

snapshot_tree() {
  local dir=$1
  local out=$2

  (
    cd -- "$dir"
    find . -type f ! -path './.git/*' -print |
      LC_ALL=C sort |
      while IFS= read -r path; do
        shasum -a 256 "$path"
      done
  ) >"$out"
}

print_changed_files() {
  local dir=$1

  echo "FILES CHANGED:"
  if is_git_dir "$dir"; then
    {
      git -C "$dir" diff --name-only
      git -C "$dir" status --porcelain=v1 --untracked-files=all |
        awk '$1 == "??" { print substr($0, 4) }'
    } | sed '/^$/d' | LC_ALL=C sort -u
  else
    echo "(non-git directory; changed-file listing unavailable)"
  fi
}

model="gpt-5.5"
effort="xhigh"
provider="lmstudio"
workdir=$PWD
local_mode=0
effort_set=0

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

ticket_file=$(resolve_existing_file "$1")
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      require_value "$1" "${2-}"
      model=$2
      shift 2
      ;;
    --effort)
      require_value "$1" "${2-}"
      effort=$2
      effort_set=1
      shift 2
      ;;
    --cd)
      require_value "$1" "${2-}"
      workdir=$2
      shift 2
      ;;
    --local)
      local_mode=1
      shift
      ;;
    --provider)
      require_value "$1" "${2-}"
      provider=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$provider" in
  lmstudio|ollama) ;;
  *)
    echo "Unsupported provider: $provider" >&2
    usage
    exit 2
    ;;
esac

workdir=$(resolve_existing_dir "$workdir")

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not installed. Install: npm i -g @openai/codex (or brew install codex), then codex login. Requires a ChatGPT subscription." >&2
  exit 2
fi

if [[ "$local_mode" -eq 1 ]]; then
  if [[ "$effort_set" -eq 1 ]]; then
    echo "Note: --effort is ignored in --local mode." >&2
  fi

  case "$provider" in
    lmstudio)
      if ! command -v lms >/dev/null 2>&1; then
        echo "LM Studio CLI not installed. Install LM Studio and ensure lms is on PATH." >&2
        exit 2
      fi
      if ! lms server status >/dev/null 2>&1; then
        lms server start
      fi
      if ! lms ps 2>/dev/null | grep -F -- "$model" >/dev/null; then
        lms load "$model" -c 32768 -y
      fi
      ;;
    ollama)
      # codex --oss with the Ollama provider requires Ollama >= 0.13.4.
      if ! command -v ollama >/dev/null 2>&1; then
        echo "Ollama CLI not installed. Install Ollama and ensure ollama is on PATH." >&2
        exit 2
      fi
      ;;
  esac
fi

log_file=$(mktemp "${TMPDIR:-/tmp}/run-codex.XXXXXX")
before_snapshot=$(mktemp "${TMPDIR:-/tmp}/run-codex.before.XXXXXX")
after_snapshot=$(mktemp "${TMPDIR:-/tmp}/run-codex.after.XXXXXX")
trap 'rm -f "$before_snapshot" "$after_snapshot"' EXIT

if is_git_dir "$workdir"; then
  snapshot_git "$workdir" "$before_snapshot"
else
  echo "Warning: $workdir is not a git work tree; using a recursive file snapshot for dud detection." >&2
  snapshot_tree "$workdir" "$before_snapshot"
fi

set +e
if [[ "$local_mode" -eq 1 ]]; then
  (
    cd -- "$workdir" &&
      codex exec --oss --local-provider "$provider" -m "$model" --skip-git-repo-check --sandbox workspace-write "$(cat "$ticket_file")" </dev/null
  ) 2>&1 | tee "$log_file"
  codex_status=${PIPESTATUS[0]}
else
  (
    cd -- "$workdir" &&
      codex exec --skip-git-repo-check --sandbox workspace-write -m "$model" -c "model_reasoning_effort=$effort" "$(cat "$ticket_file")" </dev/null
  ) 2>&1 | tee "$log_file"
  codex_status=${PIPESTATUS[0]}
fi
set -e

if is_git_dir "$workdir"; then
  snapshot_git "$workdir" "$after_snapshot"
else
  snapshot_tree "$workdir" "$after_snapshot"
fi

tail -n 60 "$log_file"
print_changed_files "$workdir"
echo "LOG: $log_file"

if [[ "$codex_status" -ne 0 ]]; then
  exit 1
fi

if cmp -s "$before_snapshot" "$after_snapshot"; then
  exit 3
fi

exit 0
