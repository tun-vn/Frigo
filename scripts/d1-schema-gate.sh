#!/usr/bin/env bash
set -euo pipefail

scope="${1:-}"
database="${D1_DATABASE:-frigo-db}"

case "$scope" in
  local)
    scope_flag="--local"
    ;;
  remote)
    scope_flag="--remote"
    ;;
  *)
    echo "Usage: bash scripts/d1-schema-gate.sh <local|remote>"
    exit 2
    ;;
esac

query="$(sed -e '/^[[:space:]]*--/d' -e '/^[[:space:]]*$/d' scripts/d1-schema-gate.sql | tr '\n' ' ')"

echo "Checking read-only D1 schema gate: database=$database scope=$scope"

if ! result="$(pnpm wrangler d1 execute "$database" "$scope_flag" --yes --command "$query" --json)"; then
  echo "D1 schema query failed; no migration or deployment was attempted."
  exit 1
fi

if ! printf '%s' "$result" | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let statements;
  try {
    statements = JSON.parse(input);
  } catch {
    console.error("Wrangler did not return valid JSON.");
    process.exit(1);
  }

  if (!Array.isArray(statements) || statements.some((statement) => statement?.success !== true)) {
    console.error("D1 reported an unsuccessful schema query.");
    process.exit(1);
  }

  const issues = statements.flatMap((statement) =>
    Array.isArray(statement.results) ? statement.results : []
  );

  if (issues.length > 0) {
    console.error("D1 schema gate failed:");
    for (const issue of issues) {
      console.error(`- ${issue.issue}: ${issue.detail}`);
    }
    process.exit(1);
  }
'; then
  exit 1
fi

echo "D1 schema gate passed: required migrations (0001-0023, including protected 0018), security/Week schema, recipe foundation, ranking persistence, generated plans, scan replay identity, and foreign keys are valid."
