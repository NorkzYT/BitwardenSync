#!/usr/bin/env bash
#
# End-to-end test for BitwardenSync.
#
# Boots a disposable Vaultwarden container, registers a throwaway account,
# then runs the real entrypoint loop against it:
#   1. drop a CSV export        -> expect purge + import, vault holds 3 items
#   2. drop a second CSV export -> expect purge + import, vault STILL holds
#      3 items (this is the duplicate regression check)
#   3. drop a malformed file    -> expect quarantine into .failed/
#
# Requirements: docker, node 20+, the bw CLI on PATH (or set BW_CLI_DIR),
# and repo dev dependencies installed (bun install / npm install).

set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="${E2E_PORT:-18325}"
HOST="https://127.0.0.1:$PORT"
CONTAINER="bitwardensync-e2e"
IMAGE="${E2E_VAULTWARDEN_IMAGE:-vaultwarden/server:1.34.3}"
EMAIL="e2e@example.com"
PASSWORD="e2e-master-password-$RANDOM"
WORK_DIR="$(mktemp -d)"
WATCH_DIR="$WORK_DIR/data"
ENTRYPOINT_LOG="$WORK_DIR/entrypoint.log"
ENTRYPOINT_PID=""

log() { printf '[e2e] %s\n' "$*"; }
fail() {
    log "FAIL: $*"
    if [ -f "$ENTRYPOINT_LOG" ]; then
        tail -40 "$ENTRYPOINT_LOG"
    fi
    exit 1
}

cleanup() {
    if [ -n "$ENTRYPOINT_PID" ]; then kill "$ENTRYPOINT_PID" 2>/dev/null || true; fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# Optional directory holding an npm-installed bw CLI (node_modules/.bin).
if [ -n "${BW_CLI_DIR:-}" ]; then
    export PATH="$BW_CLI_DIR:$PATH"
fi
command -v bw >/dev/null || fail "bw CLI not found on PATH (set BW_CLI_DIR)."
command -v docker >/dev/null || fail "docker not found."

# --- Start Vaultwarden --------------------------------------------------------

# The bw CLI refuses plain HTTP, thus the test server needs a self-signed
# certificate, trusted by every Node process through NODE_EXTRA_CA_CERTS.
SSL_DIR="$WORK_DIR/ssl"
mkdir -p "$SSL_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout "$SSL_DIR/key.pem" -out "$SSL_DIR/cert.pem" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 644 "$SSL_DIR/key.pem" "$SSL_DIR/cert.pem"
export NODE_EXTRA_CA_CERTS="$SSL_DIR/cert.pem"

log "Starting Vaultwarden ($IMAGE) on $HOST."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:80" \
    -v "$SSL_DIR:/ssl:ro" \
    -e 'ROCKET_TLS={certs="/ssl/cert.pem",key="/ssl/key.pem"}' \
    -e SIGNUPS_ALLOWED=true \
    -e I_REALLY_WANT_VOLATILE_STORAGE=true \
    -e LOGIN_RATELIMIT_SECONDS_AVG=1 \
    -e LOGIN_RATELIMIT_MAX_BURST=100 \
    "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
    if curl -fsS --cacert "$SSL_DIR/cert.pem" "$HOST/alive" >/dev/null 2>&1; then break; fi
    sleep 1
done
curl -fsS --cacert "$SSL_DIR/cert.pem" "$HOST/alive" >/dev/null ||
    fail "Vaultwarden did not become healthy."

# --- Register a test account and build the vault tool --------------------------

log "Registering test account."
CREDS="$(npx tsx "$REPO_DIR/tests/e2e/setup.ts" "$HOST" "$EMAIL" "$PASSWORD")"
CLIENT_ID="$(printf '%s' "$CREDS" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).clientId)')"
CLIENT_SECRET="$(printf '%s' "$CREDS" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).clientSecret)')"
log "Account ready: $CLIENT_ID"

log "Building the vault tool."
(cd "$REPO_DIR" && npx tsc -p docker/tsconfig.json)

# --- Environment for the entrypoint -------------------------------------------

mkdir -p "$WATCH_DIR"
export BITWARDEN_SYNC_HOST="$HOST"
export BITWARDEN_SYNC_BW_EMAIL_ADDRESS="$EMAIL"
export BITWARDEN_SYNC_BW_PASSWORD="$PASSWORD"
export BITWARDEN_SYNC_BW_CLIENTID="$CLIENT_ID"
export BITWARDEN_SYNC_BW_CLIENTSECRET="$CLIENT_SECRET"
export BITWARDEN_SYNC_IMPORT_FORMAT="bitwardencsv"
export BITWARDEN_SYNC_WATCH_DIR="$WATCH_DIR"
export BITWARDEN_SYNC_VAULT_CLI="$REPO_DIR/docker/dist/cli.js"
export BITWARDEN_SYNC_POLL_SECONDS=1
export BITWARDEN_SYNC_STABLE_CHECK_SECONDS=1
export BITWARDEN_SYNC_STABLE_CHECKS=2
export BITWARDENCLI_APPDATA_DIR="$WORK_DIR/bw-appdata"
mkdir -p "$BITWARDENCLI_APPDATA_DIR"

write_export() {
    # Three deterministic items in bitwardencsv format.
    cat > "$1" <<'CSV'
folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp
,,login,Alpha,,,0,https://alpha.example.com,alice,pw-alpha,
,,login,Beta,,,0,https://beta.example.com,bob,pw-beta,
,,login,Gamma,,,0,https://gamma.example.com,carol,pw-gamma,
CSV
}

vault_count() { node "$BITWARDEN_SYNC_VAULT_CLI" count 2>/dev/null; }

wait_for_log() {
    local pattern="$1" needed="$2" timeout="${3:-90}" elapsed=0
    while [ "$(grep -c "$pattern" "$ENTRYPOINT_LOG" 2>/dev/null || true)" -lt "$needed" ]; do
        if ! kill -0 "$ENTRYPOINT_PID" 2>/dev/null; then
            fail "entrypoint exited early while waiting for '$pattern'."
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge "$timeout" ]; then
            fail "timed out waiting for '$pattern' ($needed)."
        fi
    done
}

# --- Run the entrypoint loop ---------------------------------------------------

log "Starting the entrypoint loop."
bash "$REPO_DIR/docker/entrypoint.sh" > "$ENTRYPOINT_LOG" 2>&1 &
ENTRYPOINT_PID=$!

log "Cycle 1: dropping the first export."
write_export "$WATCH_DIR/export-one.csv"
wait_for_log "Import finished" 1
COUNT="$(vault_count)" || COUNT="error"
[ "$COUNT" = "3" ] || fail "expected 3 items after the first import, got '$COUNT'."
log "Cycle 1 OK: vault holds 3 items."

log "Cycle 2: dropping a second export (duplicate regression check)."
write_export "$WATCH_DIR/export-two.csv"
wait_for_log "Import finished" 2
COUNT="$(vault_count)" || COUNT="error"
[ "$COUNT" = "3" ] || fail "DUPLICATES: expected 3 items after the second import, got '$COUNT'."
grep -q "Verified: the vault is empty." "$ENTRYPOINT_LOG" ||
    fail "the log never confirmed a verified purge."
log "Cycle 2 OK: still 3 items — no duplicates."

log "Cycle 3: dropping a malformed file (quarantine check)."
printf 'not,a,valid\nexport' > "$WATCH_DIR/broken.csv"
wait_for_log "Moved .*broken.csv" 1
[ -f "$WATCH_DIR/.failed/broken.csv" ] || fail "broken.csv was not quarantined."
log "Cycle 3 OK: malformed file quarantined."

kill "$ENTRYPOINT_PID" 2>/dev/null || true
ENTRYPOINT_PID=""
log "PASS: purge is verified, imports are idempotent, failures quarantine."
