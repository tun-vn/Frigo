#!/usr/bin/env bash
set -e

echo "=== Frigo Pre-Deployment Verification ==="
echo "1. Checking TypeScript Types..."
pnpm typecheck

echo "2. Running ESLint..."
pnpm lint

echo "3. Running Vitest Suite..."
# Node 22's optional experimental Web Storage global can shadow jsdom's
# implementation in shell runners. Disable it for deterministic browser tests.
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage" pnpm test

echo "4. Replaying Database Migrations..."
pnpm check:migrations

if [[ "${CHECK_REMOTE_SCHEMA:-0}" == "1" ]]; then
  echo "5. Checking Remote D1 Schema..."
  pnpm schema:check:remote
else
  echo "5. Skipping Remote D1 Schema (set CHECK_REMOTE_SCHEMA=1 for release validation)."
fi

if [[ "${CHECK_WEEK_PARITY_REMOTE:-0}" == "1" ]]; then
  echo "6. Checking Remote Week v1/v2 Parity..."
  pnpm week:reconcile:remote -- --strict
else
  echo "6. Skipping Remote Week Parity (set CHECK_WEEK_PARITY_REMOTE=1 before enabling dual-write)."
fi

echo "7. Building Production Assets..."
pnpm build

echo "=== ALL CHECKS PASSED SUCCESSFULLY! ==="
echo "Local gates are green. Production rollout still requires schema preflight, backup/export, and explicit deploy approval."
