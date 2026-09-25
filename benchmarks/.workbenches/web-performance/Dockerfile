# web-performance Workbench: an actor package with a performance engineer's
# runbook, two generic measurement tools, and headless Chromium for
# mobile-throttled page audits. No knowledge of any specific project baked in.
FROM docker:29.1.3-cli AS docker-cli
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git postgresql-client procps \
    chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 \
    && npm cache clean --force

RUN mkdir -p /usr/local/lib/perf-tools
COPY lib/perf-lib.js /usr/local/lib/perf-tools/perf-lib.js
RUN cd /usr/local/lib/perf-tools \
    && npm init -y >/dev/null \
    && npm install --omit=dev pg@8.13.1 puppeteer-core@23.9.0 \
    && npm cache clean --force

COPY bin/perf-audit /usr/local/bin/perf-audit
COPY bin/perf-check /usr/local/bin/perf-check
RUN chmod +x /usr/local/bin/perf-audit /usr/local/bin/perf-check

ENV NODE_PATH=/usr/local/lib/node_modules
ENV CHROME_PATH=/usr/bin/chromium
