#!/bin/sh
set -eu

fail() {
  printf 'check: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail 'jq is required'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
release=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$script_dir/../release.txt")
expected=$(jq -cS --arg release "$release" '
  [.[] | select(.release == $release and .status == "shipped")] | sort_by(.id)
' "$script_dir/../tools/issues.json")
[ "$expected" != '[]' ] || fail "No shipped issues for release $release"

actual=$(jq -cS 'sort_by(.id)' issues.json) || fail 'issues.json must be an array of issue records'
[ "$actual" = "$expected" ] || fail 'issues.json must preserve all shipped issues and exclude other work'

notes=$(tr -d '\r' < release-notes.md)
title=$(printf '%s\n' "$notes" | sed -n '1s/[[:space:]]*$//p')
[ "$title" = "# Taskboard $release" ] || fail 'The title must match the product and release version'

headings=$(printf '%s\n' "$notes" | sed -n 's/^## //p')
[ "$headings" = 'Features
Fixes
Upgrade notes' ] || fail 'Use Features, Fixes and Upgrade notes sections in that order'

expected_ids=$(printf '%s\n' "$expected" | jq -r '.[].id' | sort)
actual_ids=$(printf '%s\n' "$notes" | grep -oE '\bTASK-[0-9]+\b' | sort -u)
[ "$actual_ids" = "$expected_ids" ] || fail 'Cite every shipped issue and no other issue IDs'

printf '%s\n' "$expected" | jq -r '.[] | [.id, .kind] | @tsv' |
while read -r issue_id kind; do
  case "$kind" in
    feature) heading=Features ;;
    fix) heading=Fixes ;;
    upgrade) heading='Upgrade notes' ;;
    *) fail "Unknown issue kind: $kind" ;;
  esac
  section=$(printf '%s\n' "$notes" | awk -v heading="$heading" '
    /^## / { inside = ($0 == "## " heading); next }
    inside { print }
  ')
  printf '%s\n' "$section" | grep -oE '\bTASK-[0-9]+\b' | grep -Fxq "$issue_id" ||
    fail "$issue_id belongs under $heading"
done

printf 'check: release %s passed\n' "$release"
