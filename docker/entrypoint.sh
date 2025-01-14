#!/bin/bash

# Exit immediately on SIGINT or SIGTERM signals
trap "echo 'Logging out of Bitwarden.'; bw logout; exit 0" SIGINT SIGTERM

# Watch directory for files
WATCH_DIR="/bitwardensync/data"
echo "BitwardenSync Watching directory: $WATCH_DIR for files..."

# Function to purge the vault
purge_vault() {
    echo "Purging existing vault items."
    npx ts-node /bitwardensync/vaultPurge.ts || { echo "Vault purge failed. Exiting."; exit 1; }
    echo "Vault purge completed."
}

# Function to wait for a file to finish uploading
wait_for_file_upload() {
    local file="$1"
    local prev_size=0
    local curr_size=0
    local no_change_count=0

    echo "Waiting for file '$file' to finish uploading..."

    while true; do
        if [ ! -e "$file" ]; then
            echo "Error: File '$file' no longer exists. Exiting."
            return 1
        fi

        curr_size=$(stat --format="%s" "$file" 2>/dev/null || echo 0)

        # Log the sizes for debugging
        echo "Checking file size... Previous: $prev_size bytes, Current: $curr_size bytes"

        if [ "$curr_size" -ne "$prev_size" ]; then
            # File size changed; reset the no-change counter and wait longer
            no_change_count=0
            prev_size=$curr_size
            sleep 15  # Wait longer since the file is still growing
        else
            # File size hasn't changed
            ((no_change_count++))
            if [ "$no_change_count" -ge 2 ]; then
                # No change for two checks (15 + 15 seconds); assume file upload is complete
                echo "File '$file' has finished uploading."
                break
            fi
            sleep 5  # Wait shorter since the file seems stable
        fi
    done
}

# Import format configuration (cleaned variable)
import_format=$(echo $BITWARDEN_SYNC_IMPORT_FORMAT | tr -d "'\"[:space:]")

# Cache supported formats
CACHE_FILE="/tmp/supported-formats.txt"
import_options_url="https://raw.githubusercontent.com/bitwarden/clients/main/libs/importer/src/models/import-options.ts"

# Refresh cache if missing or older than 24 hours
if [ ! -f "$CACHE_FILE" ] || [ $(find "$CACHE_FILE" -mtime +1) ]; then
    echo "Fetching supported formats..."
    curl -s $import_options_url > /tmp/import-options.ts
    grep -oP '(?<=id: ")[^"]+' /tmp/import-options.ts | tr -d '\r' > "$CACHE_FILE"
fi

# Read cached formats
supported_formats=$(cat "$CACHE_FILE")

# Display clean supported formats
echo "Supported formats fetched from the source:"
echo "$supported_formats" | tr -d '\r'

# Validate import format
if ! echo "$supported_formats" | grep -q "^$import_format$"; then
    echo "Error: Unsupported import format '$import_format'."
    echo "Supported formats are:"
    echo "$supported_formats" | tr -d '\r'
    exit 1
fi

while true; do
    # Find the latest file in the directory (ignore incomplete/hidden files)
    file=$(find "$WATCH_DIR" -type f ! -name ".*" | head -n 1)

    if [ -n "$file" ]; then
        echo "Detected new file: $file"

        # Wait until the file size stabilizes
        if wait_for_file_upload "$file"; then
            # Perform Bitwarden login and vault preparation
            echo "Setting Bitwarden server configuration to $BITWARDEN_SYNC_HOST."
            bw config server "$BITWARDEN_SYNC_HOST"

            # Set environment variables for Bitwarden login
            export BW_CLIENTID=$BITWARDEN_SYNC_BW_CLIENTID
            export BW_CLIENTSECRET=$BITWARDEN_SYNC_BW_CLIENTSECRET

            # Log in to Bitwarden using the API key
            echo "Logging into Bitwarden."
            bw login --apikey

            # Sync Bitwarden vault
            echo "Synchronizing Bitwarden data."
            bw sync

            # Unlock vault and save session key
            session_key=$(bw unlock --raw --passwordenv BITWARDEN_SYNC_BW_PASSWORD)
            echo "Unlocked Bitwarden vault."

            # Purge vault before importing the file
            purge_vault

            # Import the detected file
            echo "Importing file: $file as $import_format."
            bw import "$import_format" "$file" --session "$session_key"

            # Remove the imported file
            echo "Removing $file after import."
            rm -f "$file"
            echo "File imported and removed successfully."

            # Log out after processing the file
            echo "Logging out of Bitwarden."
            bw logout
        else
            echo "Skipping file '$file' due to upload issues."
        fi
    else
        echo "No files detected. Waiting for new files..."
    fi

    # Wait before checking the directory again
    sleep 5
done
