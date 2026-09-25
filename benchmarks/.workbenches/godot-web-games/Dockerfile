# linux/amd64 only, by design: this pins one official Godot download (and
# its sha256) instead of branching per host architecture. Godot does also
# publish an official linux.arm64 build, used only for local calibration
# (see checks/calibrate-local.sh and the task report), never shipped here.
# Runs fine under emulation on non-amd64 hosts.
FROM --platform=linux/amd64 node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git unzip jq ripgrep procps iproute2 python3 \
        chromium fonts-liberation libfontconfig1 libx11-6 libxcursor1 libxinerama1 \
        libgl1 libxi6 libxrandr2 libasound2 libpulse0 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global bun@1.4.2 opencode-ai@1.18.26 && npm cache clean --force
RUN npm install --prefix /opt/browser --save-exact playwright@1.55.0 @playwright/mcp@0.0.81 \
    && npm cache clean --force
RUN ln -s /opt/browser/node_modules/.bin/playwright-mcp /usr/local/bin/playwright-mcp
ENV PLAYWRIGHT_MODULE_DIR=/opt/browser/node_modules
ENV NODE_PATH=/opt/browser/node_modules

# Official release asset SHA-256 digests, linux/amd64.
RUN curl -fL --retry 3 -o /tmp/godot.zip https://github.com/godotengine/godot-builds/releases/download/4.7.1-stable/Godot_v4.7.1-stable_linux.x86_64.zip \
 && echo "c7ff14fd28472c8d4f193043de30278dcf7e5241a1dcf7566b02e27addaa33ba  /tmp/godot.zip" | sha256sum -c - \
 && mkdir -p /opt/godot \
 && unzip -q /tmp/godot.zip -d /opt/godot \
 && mv /opt/godot/Godot_v4.7.1-stable_linux.x86_64 /opt/godot/godot \
 && chmod 755 /opt/godot/godot \
 && rm /tmp/godot.zip
RUN curl -fL --retry 3 -o /tmp/templates.tpz https://github.com/godotengine/godot-builds/releases/download/4.7.1-stable/Godot_v4.7.1-stable_export_templates.tpz \
 && echo "86409db6200b6f8fd3230989c2d2002851f3dd18acf11d7bdbafddf5a0dd0f72  /tmp/templates.tpz" | sha256sum -c - \
 && mkdir -p /opt/godot/templates/4.7.1.stable \
 && unzip -jqo /tmp/templates.tpz 'templates/web*.zip' -d /opt/godot/templates/4.7.1.stable \
 && rm /tmp/templates.tpz

COPY tools/godot /usr/local/bin/godot
COPY tools/game-export.mjs /usr/local/bin/game-export
COPY tools/game-playcheck.mjs /usr/local/bin/game-playcheck
RUN chmod 755 /usr/local/bin/godot /usr/local/bin/game-export /usr/local/bin/game-playcheck
