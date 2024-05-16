#!/bin/bash

# Logging start of script
echo "Starting Bitwarden setup and synchronization script."

# Connect the CLI to the Bitwarden server using an environment variable
echo "Setting Bitwarden server configuration to $BITWARDEN_SYNC_HOST."
bw config server "$BITWARDEN_SYNC_HOST"

# Set the client ID and client secret as environment variables
export BW_CLIENTID=$BITWARDEN_SYNC_BW_CLIENTID
export BW_CLIENTSECRET=$BITWARDEN_SYNC_BW_CLIENTSECRET

# Log in to Bitwarden using the API key
echo "Logging into Bitwarden."
bw login --apikey

# Sync Bitwarden data to CLI
echo ""
echo "Synchronizing Bitwarden data."
bw sync

# Unlock the account and store the session key in a variable
session_key=$(bw unlock --raw --passwordenv BITWARDEN_SYNC_BW_PASSWORD)
echo ""
echo "Unlocked Bitwarden vault."

# Wait 1 second
sleep 1

echo "--------------------------------"

# Function to delete items or folders sequentially
delete_object() {
    if ! bw delete "$1" "$2" --session "$session_key"; then
        echo "Failed to delete $1: $2"
    else
        echo "Deleted $1: $2"
    fi
}

# Retrieve all folder IDs to delete
folder_ids=$(bw list folders --session "$session_key" | jq -r '.[] | .id')
if [ -z "$folder_ids" ]; then
    echo "No folders found to delete."
else
    # Deleting folders sequentially
    for id in $folder_ids; do
        delete_object folder "$id"
    done
    echo "Deleted all folders from the Bitwarden vault."
fi

# Retrieve all item IDs to delete
item_ids=$(bw list items --session "$session_key" | jq -r '.[] | .id')
if [ -z "$item_ids" ]; then
    echo "No items found to delete."
else
    # Deleting items sequentially
    for id in $item_ids; do
        delete_object item "$id"
    done
    echo "Deleted all items from the Bitwarden vault."
fi

echo "--------------------------------"

# Find all .1pux files in the specified directory
pux_files=$(find /bitwardensync/data -type f -name "*.1pux" | head -n 1)

# Check if a .1pux file is found
if [ -n "$pux_files" ]; then
    # If a .1pux file is found, import it
    for file in $pux_files; do
        echo "Importing $file."
        bw import 1password1pux "$file" --session "$session_key"
        # Remove the file after import to avoid re-importing
        echo ""
        echo "Removing $file after import."
        rm -f "$file"
    done
else
    echo "No .1pux files found."
fi

# Wait 1 second
sleep 1

# Log out of Bitwarden
echo "Logging out of Bitwarden."
bw logout
echo ""
echo "Task completed."
