# Generic coding-agent environment shared by both arms.
# No product CLI, SDK, skill, or instruction is installed here.
FROM docker:29.1.3-cli AS docker-cli

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git unzip xz-utils jq ripgrep procps iproute2 \
        python3 make g++ sudo sqlite3 postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 \
    && npm cache clean --force \
    && bun --version && opencode --version

# Match the product package's default UID. The engine initializes credential
# volume ownership before launching the runner and sets its execution HOME.
WORKDIR /work
