#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Logging start of script
echo ""
echo "Starting BitwardenSync tool."

# Connect the CLI to the Bitwarden server using an environment variable
echo "Setting server configuration to $BITWARDEN_SYNC_HOST."
bw config server "$BITWARDEN_SYNC_HOST"
echo ""

# Set the client ID and client secret as environment variables
export BW_CLIENTID=$BITWARDEN_SYNC_BW_CLIENTID
export BW_CLIENTSECRET=$BITWARDEN_SYNC_BW_CLIENTSECRET

# Log in to Bitwarden using the API key, if not already logged in
if ! bw login --check; then
    echo "Logging into Bitwarden."
    bw login --apikey
else
    echo ""
    echo "Already logged into Bitwarden."
fi

# Unlock the account and store the session key in a variable
session_key=$(bw unlock --raw --passwordenv BITWARDEN_SYNC_BW_PASSWORD)
echo ""
echo "Unlocked Bitwarden vault."

# Get the value of the BITWARDEN_SYNC_IMPORT_FORMAT environment variable
import_format=$BITWARDEN_SYNC_IMPORT_FORMAT

# Get the list of supported import formats using the unlocked session
supported_formats=$(bw import --formats --session "$session_key" | tail -n +2)

# Check if the import format is supported
if ! echo "$supported_formats" | grep -q "^$import_format$"; then
    echo "Error: Unsupported import format '$import_format'."
    echo "Please provide a valid format from the following list:"
    echo "https://github.com/bitwarden/clients/blob/34a766f346d829a15e348038a12c0c1aefb17457/libs/importer/src/models/import-options.ts#L6"
    exit 1
fi

# Wait 1 second
sleep 1

echo "--------------------------------"

npx ts-node /backuponepass/vaultPurge.ts

echo "--------------------------------"

# Directory where the import files are located
import_dir="/bitwardensync/data"

# Check if the import directory exists
if [ ! -d "$import_dir" ]; then
    echo "Error: Import directory '$import_dir' does not exist."
    exit 1
fi

# Find and import files from the /bitwardensync/data directory
files=$(find "$import_dir" -type f)

if [ -n "$files" ]; then
    for file in $files; do
        echo "Importing $file as $import_format."
        bw import "$import_format" "$file" --session "$session_key"
        echo ""
        echo "Removing $file after import."
        rm -f "$file"
    done
else
    echo "No files found in '$import_dir'."
    exit 1
fi

# Wait 1 second
sleep 1

# Log out of Bitwarden
echo "Logging out of Bitwarden."
bw logout
echo ""
echo "Task completed."
