FROM vaultwarden/server:1.35.2

LABEL maintainer="NorkzYT richard@pcscorp.dev"

# Install required packages including build-essential and Chromium
RUN apt-get update && \
    apt-get install -y \
    libssl-dev \
    ca-certificates \
    openssl \
    wget \
    git \
    rsync \
    jq \
    nodejs \
    npm \
    build-essential \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-freefont-ttf \
    libxss1 \
    # X11 virtual framebuffer (needed for Puppeteer headless:false)
    xvfb \
    x11-xserver-utils \
    xauth \
    --no-install-recommends && \
    npm install -g @bitwarden/cli@2025.12.0 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer and X11
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD true
ENV PUPPETEER_EXECUTABLE_PATH /usr/bin/chromium
ENV DISPLAY :99

# Copy necessary files
COPY docker/entrypoint.sh /bitwardensync/entrypoint.sh
COPY docker/vaultPurge.ts /bitwardensync/vaultPurge.ts
COPY package.json /bitwardensync/package.json
COPY tsconfig.json /bitwardensync/tsconfig.json

# Ensure the script contains execute permissions
RUN chmod +x /bitwardensync/entrypoint.sh

# Set working directory
WORKDIR /bitwardensync

# Install npm packages
RUN npm install

ENTRYPOINT ["/bitwardensync/entrypoint.sh"]
