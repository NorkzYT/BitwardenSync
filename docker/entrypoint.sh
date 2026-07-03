#!/usr/bin/env bash
#
# BitwardenSync entrypoint.
#
# Watches a directory for password-manager export files. For each file it:
#   1. waits until the file stops growing,
#   2. logs into Bitwarden/Vaultwarden with the account API key,
#   3. purges the vault through the REST API and verifies it is empty,
#   4. imports the file with the Bitwarden CLI,
#   5. deletes the file.
#
# The import only runs after a verified purge, thus a failed purge can
# never stack new items on top of old ones and create duplicates.

set -Eeuo pipefail

# --- Configuration (override through the environment) ------------------------

WATCH_DIR="${BITWARDEN_SYNC_WATCH_DIR:-/bitwardensync/data}"
FAILED_DIR="$WATCH_DIR/.failed"
POLL_SECONDS="${BITWARDEN_SYNC_POLL_SECONDS:-5}"
STABLE_CHECK_SECONDS="${BITWARDEN_SYNC_STABLE_CHECK_SECONDS:-10}"
STABLE_CHECKS_REQUIRED="${BITWARDEN_SYNC_STABLE_CHECKS:-2}"
VAULT_CLI="${BITWARDEN_SYNC_VAULT_CLI:-/bitwardensync/dist/cli.js}"
IMPORT_OPTIONS_URL="https://raw.githubusercontent.com/bitwarden/clients/main/libs/importer/src/models/import-options.ts"
FORMAT_CACHE_FILE="${TMPDIR:-/tmp}/bitwardensync-supported-formats.txt"

# --- Helpers ------------------------------------------------------------------

log() {
    printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"
}

require_env() {
    local name missing=0
    for name in "$@"; do
        if [ -z "${!name:-}" ]; then
            log "ERROR: required environment variable $name is not set."
            missing=1
        fi
    done
    if [ "$missing" -ne 0 ]; then
        exit 1
    fi
}

bw_logout() {
    bw logout >/dev/null 2>&1 || true
    unset BW_SESSION
}

cleanup() {
    bw_logout
}
trap cleanup EXIT

# --- Import format validation ------------------------------------------------

# Refresh the cached list of formats the Bitwarden CLI can import.
# The cache lives for a day; a failed fetch keeps the previous cache.
refresh_format_cache() {
    if [ -s "$FORMAT_CACHE_FILE" ] && \
       [ -z "$(find "$FORMAT_CACHE_FILE" -mmin +1440 2>/dev/null)" ]; then
        return 0
    fi
    log "Refreshing the list of supported import formats."
    if curl -fsS --max-time 15 "$IMPORT_OPTIONS_URL" 2>/dev/null |
        grep -oP '(?<=id: ")[^"]+' | tr -d '\r' > "$FORMAT_CACHE_FILE.tmp" &&
        [ -s "$FORMAT_CACHE_FILE.tmp" ]; then
        mv "$FORMAT_CACHE_FILE.tmp" "$FORMAT_CACHE_FILE"
    else
        rm -f "$FORMAT_CACHE_FILE.tmp"
        log "WARNING: could not fetch the supported format list."
    fi
}

validate_import_format() {
    refresh_format_cache
    if [ ! -s "$FORMAT_CACHE_FILE" ]; then
        log "WARNING: no format list available. Skipping validation of '$IMPORT_FORMAT'."
        return 0
    fi
    if ! grep -qx "$IMPORT_FORMAT" "$FORMAT_CACHE_FILE"; then
        log "ERROR: unsupported import format '$IMPORT_FORMAT'. Supported formats:"
        cat "$FORMAT_CACHE_FILE"
        exit 1
    fi
    log "Import format '$IMPORT_FORMAT' is supported."
}

# --- File watching -----------------------------------------------------------

# Newest visible file in the watch directory. Skips hidden files, the
# quarantine directory, and partial uploads (.incomplete/.part/.tmp).
find_next_file() {
    find "$WATCH_DIR" -maxdepth 1 -type f \
        ! -name '.*' ! -name '*.incomplete' ! -name '*.part' ! -name '*.tmp' \
        -printf '%T@\t%p\n' 2>/dev/null | sort -rn | head -n 1 | cut -f2-
}

# Wait until the file size stays unchanged for consecutive checks.
wait_for_stable_file() {
    local file="$1"
    local prev_size=-1 curr_size=0 stable_count=0

    log "Waiting for '$file' to finish uploading."
    while [ "$stable_count" -lt "$STABLE_CHECKS_REQUIRED" ]; do
        if [ ! -e "$file" ]; then
            log "File '$file' disappeared while waiting (renamed or removed)."
            return 1
        fi
        curr_size=$(stat --format='%s' "$file" 2>/dev/null || echo -1)
        if [ "$curr_size" -ge 0 ] && [ "$curr_size" -eq "$prev_size" ]; then
            stable_count=$((stable_count + 1))
        else
            stable_count=0
            prev_size=$curr_size
        fi
        if [ "$stable_count" -lt "$STABLE_CHECKS_REQUIRED" ]; then
            sleep "$STABLE_CHECK_SECONDS"
        fi
    done
    log "File '$file' is stable at $curr_size bytes."
}

# Move a failed file aside so the watcher does not retry it forever.
quarantine_file() {
    local file="$1" dest
    mkdir -p "$FAILED_DIR"
    dest="$FAILED_DIR/$(basename "$file")"
    if mv -f "$file" "$dest"; then
        log "Moved '$file' to '$dest' for inspection."
    else
        log "ERROR: could not quarantine '$file'. Removing it to avoid a retry loop."
        rm -f "$file"
    fi
}

# --- Bitwarden session -------------------------------------------------------

# Log in with the API key, sync, and unlock. Exports BW_SESSION so the
# session key never appears on a command line.
bw_login_and_unlock() {
    log "Configuring server $BITWARDEN_SYNC_HOST."
    bw config server "$BITWARDEN_SYNC_HOST" >/dev/null

    log "Logging into Bitwarden."
    if ! BW_CLIENTID="$BITWARDEN_SYNC_BW_CLIENTID" \
         BW_CLIENTSECRET="$BITWARDEN_SYNC_BW_CLIENTSECRET" \
         bw login --apikey >/dev/null; then
        log "ERROR: Bitwarden login failed."
        return 1
    fi

    log "Synchronizing vault data."
    bw sync >/dev/null

    BW_SESSION="$(bw unlock --raw --passwordenv BITWARDEN_SYNC_BW_PASSWORD)" || BW_SESSION=""
    if [ -z "$BW_SESSION" ]; then
        log "ERROR: failed to unlock the vault."
        return 1
    fi
    export BW_SESSION
    log "Vault unlocked."
}

# --- Processing --------------------------------------------------------------

process_file() {
    local file="$1" count

    if ! wait_for_stable_file "$file"; then
        log "Skipping '$file'."
        return 0
    fi

    if ! bw_login_and_unlock; then
        bw_logout
        log "ERROR: login failed. Exiting so the container restart policy can retry."
        exit 1
    fi

    # Purge and verify. The vault tool exits non-zero unless the server
    # confirms an empty vault, which is what makes duplicates impossible.
    log "Purging the vault through the API."
    if ! node "$VAULT_CLI" purge; then
        bw_logout
        log "ERROR: vault purge failed or could not be verified. Import aborted."
        exit 1
    fi

    log "Importing '$file' as $IMPORT_FORMAT."
    if bw import "$IMPORT_FORMAT" "$file"; then
        count="$(node "$VAULT_CLI" count 2>/dev/null)" || count="unknown"
        log "Import finished. The vault now holds $count items."
        rm -f "$file"
        log "Removed '$file'."
    else
        log "ERROR: import of '$file' failed."
        quarantine_file "$file"
    fi

    bw_logout
    log "Logged out of Bitwarden."
}

# --- Main loop ---------------------------------------------------------------

main() {
    require_env \
        BITWARDEN_SYNC_HOST \
        BITWARDEN_SYNC_BW_EMAIL_ADDRESS \
        BITWARDEN_SYNC_BW_PASSWORD \
        BITWARDEN_SYNC_BW_CLIENTID \
        BITWARDEN_SYNC_BW_CLIENTSECRET \
        BITWARDEN_SYNC_IMPORT_FORMAT

    IMPORT_FORMAT="$(printf '%s' "$BITWARDEN_SYNC_IMPORT_FORMAT" | tr -d "'\"[:space:]")"

    mkdir -p "$WATCH_DIR"
    validate_import_format
    log "Watching $WATCH_DIR (poll every ${POLL_SECONDS}s)."

    local idle_logged=0 file
    while true; do
        file="$(find_next_file)" || file=""
        if [ -n "$file" ]; then
            idle_logged=0
            log "Detected file: $file"
            process_file "$file"
        elif [ "$idle_logged" -eq 0 ]; then
            # Log the idle state once instead of every poll.
            log "No files detected. Waiting for new files."
            idle_logged=1
        fi
        sleep "$POLL_SECONDS"
    done
}

main "$@"
