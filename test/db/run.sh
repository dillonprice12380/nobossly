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
cp test/db/stub.sql test/db/private_cohorts.sql migrations/2026-11-02_private_cohorts.sql "$DIR"/ && chmod 644 "$DIR"/*.sql
as "$BIN/initdb -D $DIR/data -A trust >/dev/null && $BIN/pg_ctl -D $DIR/data -o '-p 5498 -k $DIR -c listen_addresses=' -l $DIR/log start >/dev/null"
trap 'as "$BIN/pg_ctl -D $DIR/data stop -m immediate >/dev/null" || true; rm -rf "$DIR"' EXIT
P="psql -h $DIR -p 5498 -U postgres -q -t -v ON_ERROR_STOP=1"
createdb -h "$DIR" -p 5498 -U postgres t
$P -d t -f "$DIR/stub.sql" >/dev/null
$P -d t -f "$DIR/2026-11-02_private_cohorts.sql" >/dev/null 2>&1
OUT=$($P -d t -f "$DIR/private_cohorts.sql" 2>&1 | grep -E '✓|✗|\|' || true)
echo "$OUT" | grep -E '✓|✗'
FAILED=$(echo "$OUT" | grep -E '^\s*[0-9]+ \|' | awk -F'|' '{gsub(/ /,"",$1); print $1}')
if [ "${FAILED:-1}" != "0" ]; then echo; echo "${FAILED:-?} failed"; exit 1; fi
echo; echo "All good"
