#!/usr/bin/env bash
# Run a ticket through agy with deterministic flags, stdin closed, logging, and dud detection.
# Usage: run-agy.sh <ticket-file> <output-dir> [--model M] [--cd DIR]

set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run-agy.sh <ticket-file> <output-dir> [--model M] [--cd DIR]
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

resolve_output_dir() {
  local path=$1
  local dir
  local base

  mkdir -p -- "$path"
  dir=$(dirname -- "$path")
  base=$(basename -- "$path")
  dir=$(cd -- "$dir" && pwd -P)
  printf '%s/%s\n' "$dir" "$base"
}

model="Gemini 3.1 Pro (High)"
workdir=$PWD

if [[ $# -lt 2 ]]; then
  usage
  exit 2
fi

ticket_file=$(resolve_existing_file "$1")
output_dir_arg=$2
shift 2

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      require_value "$1" "${2-}"
      model=$2
      shift 2
      ;;
    --cd)
      require_value "$1" "${2-}"
      workdir=$2
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

workdir=$(resolve_existing_dir "$workdir")
output_dir=$(resolve_output_dir "$output_dir_arg")

if ! command -v agy >/dev/null 2>&1; then
  echo 'agy CLI not installed; install it and verify `agy models` lists Gemini 3.1 Pro' >&2
  exit 2
fi

log_file=$(mktemp "${TMPDIR:-/tmp}/run-agy.XXXXXX")

set +e
(
  cd -- "$workdir" &&
    agy --model "$model" --dangerously-skip-permissions --print "$(cat "$ticket_file")" --print-timeout 9m </dev/null
) 2>&1 | tee "$log_file"
agy_status=${PIPESTATUS[0]}
set -e

shopt -s nullglob
html_files=("$output_dir"/*.html)
shopt -u nullglob

tail -n 40 "$log_file"
echo "FILES:"
if [[ ${#html_files[@]} -gt 0 ]]; then
  ls -1 "${html_files[@]}"
fi
echo "LOG: $log_file"

if [[ "$agy_status" -ne 0 ]]; then
  exit 1
fi

if [[ ${#html_files[@]} -eq 0 ]]; then
  exit 3
fi

exit 0
