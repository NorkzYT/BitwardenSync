#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Logging start of script
echo ""
echo "Starting BitwardenSync tool."

# Run vaultPurge.ts first
#npx ts-node /bitwardensync/vaultPurge.ts || { echo "Vault purge failed. Exiting."; exit 1; }
echo "Vault purge completed."

# Connect the CLI to the Bitwarden server using an environment variable
echo "Setting server configuration to $BITWARDEN_SYNC_HOST."
bw logout || true # Log out if logged in, ignore errors if not logged in
bw config server "$BITWARDEN_SYNC_HOST"
echo ""

# Set the client ID and client secret as environment variables
export BW_CLIENTID=$BITWARDEN_SYNC_BW_CLIENTID
export BW_CLIENTSECRET=$BITWARDEN_SYNC_BW_CLIENTSECRET

# Set the password secret as environment variables
export BW_PASSWORD=$BITWARDEN_SYNC_BW_PASSWORD

# Retry configuration
RETRY_LIMIT=5
RETRY_INTERVAL=10
retry_count=0

# Function to handle retries
retry_command() {
  local cmd="$1"
  local success=1
  local retry_count=0
  while [ $retry_count -lt $RETRY_LIMIT ]; do
    if eval "$cmd"; then
      success=0
      break
    else
      echo "Retrying in $RETRY_INTERVAL seconds... ($((retry_count+1))/$RETRY_LIMIT)"
      sleep $RETRY_INTERVAL
      retry_count=$((retry_count+1))
    fi
  done

  if [ $success -ne 0 ]; then
    echo "Error: Command failed after $RETRY_LIMIT attempts. Exiting."
    exit 1
  fi
}

# Log in to Bitwarden using the API key, if not already logged in
echo "Logging into Bitwarden."
BW_CLIENTID=$BW_CLIENTID BW_CLIENTSECRET=$BW_CLIENTSECRET retry_command "bw login --apikey"

# Unlock the account and store the session key in a variable
printf "\n"
echo "Unlocking Bitwarden vault."
session_key=$(BW_PASSWORD=$BW_PASSWORD bw unlock --raw --passwordenv BW_PASSWORD 2>/dev/null)
if [ -z "$session_key" ]; then
    echo "Error: Failed to unlock Bitwarden vault. Exiting."
    exit 1
fi
echo ""
echo "Unlocked Bitwarden vault."
export BW_SESSION="$session_key"

# Get the value of the BITWARDEN_SYNC_IMPORT_FORMAT environment variable
import_format=$BITWARDEN_SYNC_IMPORT_FORMAT

# Fetch the list of supported import formats from the source URL
import_options_url="https://raw.githubusercontent.com/bitwarden/clients/34a766f346d829a15e348038a12c0c1aefb17457/libs/importer/src/models/import-options.ts"
supported_formats=$(curl -s $import_options_url | grep -oP '(?<="id": ")[^"]+')

echo "Supported formats fetched from the source:"
echo "$supported_formats"
echo ""

# Check if the import format is supported
if ! echo "$supported_formats" | grep -q "^$import_format$"; then
    echo "Error: Unsupported import format '$import_format'."
    echo "Please provide a valid format from the following list:"
    echo "$import_options_url"
    exit 1
fi

# Wait 1 second
sleep 1

echo "--------------------------------"

# Directory where the import files are located
import_dir="/bitwardensync/data"

# Check if the import directory exists
if [ ! -d "$import_dir" ]; then
    echo "Error: Import directory '$import_dir' does not exist."
    exit 1
fi

# Check if only the latest file should be imported
if [ "$BITWARDEN_SYNC_IMPORT_LATEST_ONLY" = "true" ]; then
    # Find the latest file based on modification time
    file=$(find "$import_dir" -type f -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)

    if [ -n "$file" ]; then
        echo "Importing latest file: $file as $import_format."
        bw import "$import_format" "$file" --session "$BW_SESSION"
        echo ""
        echo "Removing $file after import."
        rm -f "$file"
    else
        echo "No files found in '$import_dir'."
        exit 1
    fi
else
    # Import all files if not restricted to the latest
    files=$(find "$import_dir" -type f)

    if [ -n "$files" ]; then
        for file in $files; do
            echo "Importing $file as $import_format."
            bw import "$import_format" "$file" --session "$BW_SESSION"
            echo ""
            echo "Removing $file after import."
            rm -f "$file"
        done
    else
        echo "No files found in '$import_dir'."
        exit 1
    fi
fi

# Wait 1 second
sleep 1

# Log out of Bitwarden
echo "Logging out of Bitwarden."
bw logout
echo ""
echo "Task completed."

# Prevent further looping by exiting the script
exit 0
