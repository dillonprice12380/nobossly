#!/usr/bin/env bash
# Runs the row-level-security tests for a migration against a throwaway local
# Postgres: test/db/stub.sql (just enough of the live schema), then the
# migration, then the test file. Skips cleanly where Postgres is not installed.
#
#   npm run test:db
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)
if [ -z "$BIN" ] || [ ! -x "$BIN/initdb" ]; then echo "Postgres not installed — skipping database tests."; exit 0; fi
DIR=$(mktemp -d /var/tmp/nobossly-dbtest.XXXXXX)
RUN=""; if [ "$(id -u)" = "0" ]; then chown postgres "$DIR"; RUN="su postgres -c"; fi
as() { if [ -n "$RUN" ]; then su postgres -c "$1"; else bash -c "$1"; fi; }
cp test/db/stub.sql test/db/private_cohorts.sql test/db/group_checkins.sql test/db/workspace_shares.sql test/db/marketplace.sql test/db/path_news.sql test/db/weekly_challenge.sql test/db/stripe_connection.sql test/db/dashboard_layout.sql test/db/workspace_layout.sql test/db/community.sql test/db/recurring_expenses.sql migrations/2026-11-02_private_cohorts.sql migrations/2026-11-02_group_checkins.sql migrations/2026-11-02_workspace_shares.sql migrations/2026-11-03_marketplace.sql migrations/2026-11-03_path_news.sql migrations/2026-11-08_weekly_challenge_wording.sql migrations/2026-11-08_stripe_connection.sql migrations/2026-11-08_dashboard_layout.sql migrations/2026-11-08_workspace_layout.sql migrations/2026-11-08_community.sql migrations/2026-11-08_recurring_expenses.sql "$DIR"/ && chmod 644 "$DIR"/*.sql
as "$BIN/initdb -D $DIR/data -A trust >/dev/null && $BIN/pg_ctl -D $DIR/data -o '-p 5498 -k $DIR -c listen_addresses=' -l $DIR/log start >/dev/null"
trap 'as "$BIN/pg_ctl -D $DIR/data stop -m immediate >/dev/null" || true; rm -rf "$DIR"' EXIT
P="psql -h $DIR -p 5498 -U postgres -q -t -v ON_ERROR_STOP=1"
# Migrations in order, then each test file in its own fresh database.
TOTAL_FAILED=0
for TEST in private_cohorts group_checkins workspace_shares marketplace path_news weekly_challenge stripe_connection dashboard_layout workspace_layout community recurring_expenses; do
  dropdb -h "$DIR" -p 5498 -U postgres --if-exists t; createdb -h "$DIR" -p 5498 -U postgres t
  $P -d t -f "$DIR/stub.sql" >/dev/null
  $P -d t -f "$DIR/2026-11-02_private_cohorts.sql" >/dev/null 2>&1
  $P -d t -f "$DIR/2026-11-02_group_checkins.sql" >/dev/null 2>&1
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-02_workspace_shares.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-03_marketplace.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-03_path_news.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_weekly_challenge_wording.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_stripe_connection.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_dashboard_layout.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_workspace_layout.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_community.sql" >/dev/null
  PGOPTIONS='-c client_min_messages=warning' $P -d t -f "$DIR/2026-11-08_recurring_expenses.sql" >/dev/null
  echo "$TEST:"
  OUT=$($P -d t -f "$DIR/$TEST.sql" 2>&1 | grep -E '✓|✗|\||ERROR' || true)
  echo "$OUT" | grep -E '✓|✗|ERROR'
  FAILED=$(echo "$OUT" | grep -E '^\s*[0-9]+ \|' | awk -F'|' '{gsub(/ /,"",$1); print $1}')
  TOTAL_FAILED=$((TOTAL_FAILED + ${FAILED:-1}))
done
if [ "$TOTAL_FAILED" != "0" ]; then echo; echo "$TOTAL_FAILED failed"; exit 1; fi
echo; echo "All good"
