#!/usr/bin/env bash
# Runs the web unit tests (apps/web) with the test files, and the tests in each file, in a random
# order, so a test that needs what another one left behind fails here and not later in CI.
# When they fail it prints the seed. SEED=<number> runs that order again. Arguments go to
# `bun test`.
set -euo pipefail

cd "$(dirname "$0")/../apps/web"
seed=${SEED:-$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')}
if ! bun test app --randomize --seed="$seed" "$@"; then
  again="SEED=$seed bun run test:ui"
  echo "Web tests failed in the order of seed $seed. Run the same order again: $again" >&2
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error title=Web tests failed (seed $seed)::Run the same order again: $again"
  fi
  exit 1
fi
