#!/usr/bin/env bash
# Decides which heavy CI parts run, from commit message tags and pull request labels.
# Prints key=value lines for $GITHUB_OUTPUT: desktop, mobile, docker, e2e (true = run).
#
# Env: EVENT (github.event_name), REF (github.ref), MESSAGE (head commit message),
# LABELS (comma separated label names), CHANGED (files changed by a push, one per line; unset
# when unknown). Tags and labels are ignored for version tags, the schedule and manual runs.
# A push that changes nothing the mobile apps are built from skips the mobile builds.
set -euo pipefail

desktop=true
mobile=true
docker=true
e2e=true

honored=true
case "${EVENT:-}" in schedule | workflow_dispatch) honored=false ;; esac
case "${REF:-}" in refs/tags/*) honored=false ;; esac

has() {
  local word=$1
  grep -qiF -- "[$word]" <<<"${MESSAGE:-}" && return 0
  tr ',' '\n' <<<"${LABELS:-}" | sed 's/^ *//; s/ *$//' | grep -qixF -- "$word"
}

if [ "$honored" = true ]; then
  if has 'ci light'; then desktop=false mobile=false docker=false e2e=false; fi
  if has 'skip native'; then desktop=false mobile=false; fi
  if has 'skip desktop'; then desktop=false; fi
  if has 'skip mobile'; then mobile=false; fi
  if has 'skip docker'; then docker=false; fi
  if has 'skip e2e'; then e2e=false; fi
fi

mobile_paths='^(apps/desktop/|apps/web/|assets/|Cargo\.toml$|Cargo\.lock$|package\.json$|bun\.lock$|\.github/workflows/mobile\.yml$|scripts/release\.ts$)'
if [ "$honored" = true ] && [ "${EVENT:-}" = push ] && [ -n "${CHANGED+set}" ] && ! grep -qE -- "$mobile_paths" <<<"$CHANGED"; then
  mobile=false
fi

# The desktop smoke run (the e2e test) is a desktop job too.
if [ "$desktop" = false ]; then e2e=false; fi

printf 'desktop=%s\nmobile=%s\ndocker=%s\ne2e=%s\n' "$desktop" "$mobile" "$docker" "$e2e"
