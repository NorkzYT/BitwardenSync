#!/bin/bash

# Default UID and GID
USER_ID=${UID:-1000}
GROUP_ID=${GID:-1000}

# Change ownership
chown -R "$USER_ID":"$GROUP_ID" /usr/local/lib/node_modules/@bitwarden/cli

# Execute the entrypoint script
exec /bitwardensync/entrypoint.sh
