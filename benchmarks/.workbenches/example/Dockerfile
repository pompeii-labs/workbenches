# The environment this Workbench needs, built from the package.
# The benchmark harness never builds this: wb does, the same way it would
# for anyone who installed this Workbench.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 && npm cache clean --force
