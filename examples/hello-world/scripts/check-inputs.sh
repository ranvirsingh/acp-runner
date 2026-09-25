#!/bin/sh
set -eu

fail() {
  printf 'input: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
release_file="$script_dir/../release.txt"
[ -r "$release_file" ] || fail 'release.txt is missing or unreadable'
release=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$release_file")
[ -n "$release" ] || fail 'release.txt is empty'

jq -e --arg release "$release" '
  any(.[]; .release == $release and .status == "shipped")
' "$script_dir/../tools/issues.json" >/dev/null || fail "No shipped issues for release $release"

printf 'input: release %s is ready\n' "$release"
