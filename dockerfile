FROM vaultwarden/server:latest

LABEL maintainer="NorkzYT richard@pcscorp.dev"

# Copy entrypoint.sh file
COPY docker/entrypoint.sh /backuponepass/entrypoint.sh

# Ensure the script contains execute permissions
RUN chmod +x /backuponepass/entrypoint.sh

# Install packages and clean up cache to reduce image size
RUN apt-get update && apt-get install -y \
    libssl-dev \
    ca-certificates \
    openssl \
    wget \
    git \
    rsync \
    jq \
    nodejs \
    npm && \
    npm install -g @bitwarden/cli && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/backuponepass/entrypoint.sh"]
