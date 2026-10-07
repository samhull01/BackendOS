#!/usr/bin/env bash
set -euo pipefail
# Disposable local database only; never targets a remote Supabase project.
name="backendos-rls-$RANDOM"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" -e POSTGRES_PASSWORD=local-test-only postgres:17 >/dev/null
for attempt in {1..30}; do if docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 < tests/auth-bootstrap.sql
docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/202610070001_foundation.sql
docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 < tests/rls.sql
