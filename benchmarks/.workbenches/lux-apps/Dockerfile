# The environment this Workbench needs, built from the package.
# Anything a Lux developer would have on their machine belongs here, and
# nothing task-specific does. The benchmark harness never builds this: wb
# does, the same way it would for anyone who installed this Workbench.
FROM docker:29.1.3-cli AS docker-cli

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git unzip xz-utils jq ripgrep procps iproute2 \
        python3 make g++ sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# The Docker CLI, for the declared host engine binding: `lux start` runs the
# engine as a sibling container.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 && npm cache clean --force

RUN curl -fsSLO https://github.com/lux-db/lux/releases/download/cli-v0.28.0/lux-cli-linux-x86_64.tar.gz \
    && echo '461f699a4540f83ecbaa08c9f19006fbba92db20bbf091bc3863add893e6855d  lux-cli-linux-x86_64.tar.gz' | sha256sum -c - \
    && tar -xzf lux-cli-linux-x86_64.tar.gz \
    && install -m 0755 lux-cli-linux-x86_64 /usr/local/bin/lux \
    && rm lux-cli-linux-x86_64.tar.gz lux-cli-linux-x86_64 \
    && lux --version

COPY tools/lux-up /usr/local/bin/lux-up
COPY tools/lux-upgrade-check /usr/local/bin/lux-upgrade-check
COPY tools/lux-net-preflight.sh /usr/local/bin/lux-net-preflight.sh
RUN chmod +x /usr/local/bin/lux-up /usr/local/bin/lux-upgrade-check
