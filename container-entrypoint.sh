#!/usr/bin/env bash
set -Eeuo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data/pgdata}"
POSTGRES_DB="${POSTGRES_DB:-foundation}"
POSTGRES_USER="${POSTGRES_USER:-foundation}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(/usr/local/bin/node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')}"
export POSTGRES_PASSWORD

mkdir -p "$PGDATA"

fresh_database=0
if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  fresh_database=1
  # A bind-mounted data directory may not support chown (for example on
  # Apple Container). A fresh database still needs PostgreSQL ownership, but
  # an initialized directory already has the permissions it needs and must
  # not be recursively chowned on every restart.
  chown -R postgres:postgres "$PGDATA"
  su postgres -s /bin/bash -c "initdb --pgdata='$PGDATA' --auth-local=peer --auth-host=scram-sha-256"
fi

su postgres -s /bin/bash -c "pg_ctl --pgdata='$PGDATA' --options='-c listen_addresses=127.0.0.1 -c port=5432' --wait --log=/tmp/foundation-postgres.log start"

cleanup() {
  if [[ -n "${app_pid:-}" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  su postgres -s /bin/bash -c "pg_ctl --pgdata='$PGDATA' --wait stop" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

until su postgres -s /bin/bash -c "pg_isready --host=127.0.0.1 --port=5432 --dbname=postgres" >/dev/null 2>&1; do
  sleep 1
done

export FOUNDATION_APP_USER="$POSTGRES_USER"
export FOUNDATION_APP_PASSWORD="$POSTGRES_PASSWORD"
su -p postgres -s /bin/bash -c 'psql --set ON_ERROR_STOP=1 --username=postgres --dbname=postgres --set=app_user="$FOUNDATION_APP_USER" --set=app_password="$FOUNDATION_APP_PASSWORD"' <<'SQL'
SELECT format('CREATE ROLE %I WITH NOSUPERUSER LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')\gexec
SELECT format('ALTER ROLE %I WITH NOSUPERUSER LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')\gexec
SQL
su postgres -s /bin/bash -c "createdb --owner=\"$POSTGRES_USER\" \"$POSTGRES_DB\"" 2>/dev/null || true
su postgres -s /bin/bash -c "psql --set ON_ERROR_STOP=1 --username=postgres --dbname=\"$POSTGRES_DB\" -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;'"

# A Compose .env commonly still contains DATABASE_URL=...@db. In the single
# container image, transparently redirect that legacy value to local Postgres.
if [[ -z "${DATABASE_URL:-}" || "$DATABASE_URL" == *"@db:"* ]]; then
  export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
fi

echo "Foundation MCP starting with PostgreSQL in the same container"
su app -s /bin/bash -c 'exec /usr/local/bin/node /app/dist/src/index.js' &
app_pid=$!
wait "$app_pid"
