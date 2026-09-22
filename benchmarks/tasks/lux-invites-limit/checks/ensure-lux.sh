#!/usr/bin/env bash
# Makes sure `lux` is on PATH before any checks script calls it standalone.
# The harness runs `setup` (seed.sh) inside the generic agent image, which
# has no `lux`; gates run in the product image, which already has it. When
# missing, installs the exact pinned release the Workbench Dockerfile
# installs (.workbenches/lux-apps/Dockerfile), verifies its checksum, and
# puts it in a user-writable location so no root is needed. Idempotent and
# safe to source more than once. Does not touch the caller's shell options
# (some checks scripts deliberately run without `set -e`).
LUX_VERSION="cli-v0.28.0"
LUX_ASSET="lux-cli-linux-x86_64.tar.gz"
LUX_URL="https://github.com/lux-db/lux/releases/download/${LUX_VERSION}/${LUX_ASSET}"
LUX_SHA256="461f699a4540f83ecbaa08c9f19006fbba92db20bbf091bc3863add893e6855d"
LUX_INSTALL_DIR="$HOME/.local/bin"

if command -v lux >/dev/null 2>&1; then
    echo "lux: using installed $(lux --version)"
else
    mkdir -p "$LUX_INSTALL_DIR"
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/lux-install-XXXXXX")"
    if (
        cd "$tmp" \
            && curl -fsSLO "$LUX_URL" \
            && echo "${LUX_SHA256}  ${LUX_ASSET}" | sha256sum -c - \
            && tar -xzf "$LUX_ASSET" \
            && install -m 0755 lux-cli-linux-x86_64 "$LUX_INSTALL_DIR/lux"
    ); then
        rm -rf "$tmp"
        export PATH="$LUX_INSTALL_DIR:$PATH"
        echo "lux: installed $(lux --version) to $LUX_INSTALL_DIR/lux"
    else
        rm -rf "$tmp"
        echo "lux: failed to download or verify $LUX_URL" >&2
        exit 1
    fi
fi
export PATH="$LUX_INSTALL_DIR:$PATH"
