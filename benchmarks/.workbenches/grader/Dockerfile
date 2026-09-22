# Generic evaluation environment, owned and built by this Workbench.
FROM docker:29.1.3-cli AS docker-cli
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git unzip xz-utils jq ripgrep procps iproute2 \
    python3 make g++ sqlite3 postgresql-client chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 playwright@1.55.1 \
    && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
