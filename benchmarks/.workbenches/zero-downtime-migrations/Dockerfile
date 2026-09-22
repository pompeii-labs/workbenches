# Zero-downtime-migrations Workbench: an actor package with the general
# playbook for shipping schema changes to a live Postgres database, plus two
# generic rehearsal tools. No knowledge of any specific project baked in.
FROM docker:29.1.3-cli AS docker-cli
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git gnupg procps \
    && rm -rf /var/lib/apt/lists/*

# Debian bookworm's stock postgresql-client is 15.x. The benchmark fixtures
# run postgres:16, and pg_dump refuses to dump from a newer server than
# itself. Pull postgresql-client-16 from the PGDG apt repo instead so the
# major versions match.
RUN curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 \
    && npm cache clean --force

COPY bin/migrate-rehearse /usr/local/bin/migrate-rehearse
COPY bin/pg-locks /usr/local/bin/pg-locks
RUN chmod +x /usr/local/bin/migrate-rehearse /usr/local/bin/pg-locks

ENV NODE_PATH=/usr/local/lib/node_modules
