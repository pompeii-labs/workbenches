#!/bin/sh

set -eu

repository="${WORKBENCH_REPOSITORY:-pompeii-labs/workbenches}"
version="${WORKBENCH_VERSION:-0.1.0-alpha.2}"
bin_dir="${WORKBENCH_INSTALL_DIR:-${XDG_BIN_HOME:-${HOME:-}/.local/bin}}"
download_root="${WORKBENCH_DOWNLOAD_ROOT:-}"
allow_insecure="${WORKBENCH_ALLOW_INSECURE:-0}"

usage() {
    printf '%s\n' \
        'Install the Workbench CLI from a GitHub release.' \
        '' \
        'Usage: install.sh [--version VERSION] [--bin-dir DIRECTORY]' \
        '                  [--repository OWNER/REPOSITORY]' \
        '' \
        'Environment:' \
        '  WORKBENCH_VERSION         Release version or latest (default: 0.1.0-alpha.2)' \
        '  WORKBENCH_INSTALL_DIR     Installation directory' \
        '  WORKBENCH_REPOSITORY      GitHub owner/repository' \
        '  WORKBENCH_DOWNLOAD_ROOT   HTTPS release mirror root'
}

fail() {
    printf 'workbench installer: %s\n' "$*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || fail '--version requires a value'
            version="$2"
            shift 2
            ;;
        --bin-dir)
            [ "$#" -ge 2 ] || fail '--bin-dir requires a value'
            bin_dir="$2"
            shift 2
            ;;
        --repository)
            [ "$#" -ge 2 ] || fail '--repository requires a value'
            repository="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *) fail "unknown argument: $1" ;;
    esac
done

[ -n "$bin_dir" ] || fail 'no installation directory; set HOME or --bin-dir'

for command in curl tar awk mktemp mkdir cp chmod mv uname rm ln; do
    command -v "$command" >/dev/null 2>&1 || fail "required command is unavailable: $command"
done

case "$(uname -s)" in
    Darwin) os='darwin' ;;
    Linux) os='linux' ;;
    *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
    arm64|aarch64) architecture='arm64' ;;
    x86_64|amd64) architecture='x64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
esac

target="workbench-${os}-${architecture}"
archive_name="${target}.tar.gz"

if [ -n "$download_root" ]; then
    base="${download_root%/}"
elif [ "$version" = 'latest' ]; then
    base="https://github.com/${repository}/releases/latest/download"
else
    case "$version" in
        v*) tag="$version" ;;
        *) tag="v${version}" ;;
    esac
    base="https://github.com/${repository}/releases/download/${tag}"
fi

temporary="$(mktemp -d "${TMPDIR:-/tmp}/workbench-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
archive="${temporary}/${archive_name}"
checksums="${temporary}/checksums.txt"

download() {
    url="$1"
    output="$2"
    case "$url" in
        https://*) curl -fsSL --proto '=https' --tlsv1.2 -o "$output" "$url" ;;
        *)
            [ "$allow_insecure" = '1' ] || fail "refusing non-HTTPS download: $url"
            curl -fsSL -o "$output" "$url"
            ;;
    esac
}

download "${base}/${archive_name}" "$archive"
download "${base}/checksums.txt" "$checksums"

expected="$(awk -v name="$archive_name" '$2 == name || $2 == "*" name { print $1; exit }' "$checksums")"
[ "${#expected}" -eq 64 ] || fail "checksum is missing for ${archive_name}"
case "$expected" in
    *[!0-9a-fA-F]*) fail "checksum is invalid for ${archive_name}" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
else
    fail 'sha256sum or shasum is required to verify the download'
fi

[ "$actual" = "$expected" ] || fail "checksum verification failed for ${archive_name}"

tar -xzf "$archive" -C "$temporary"
source_binary="${temporary}/${target}/workbench"
[ -f "$source_binary" ] || fail 'release archive does not contain the Workbench executable'

mkdir -p "$bin_dir"
temporary_binary="${bin_dir}/.workbench.$$"
cp "$source_binary" "$temporary_binary"
chmod 755 "$temporary_binary"
mv -f "$temporary_binary" "${bin_dir}/workbench"

if [ -e "${bin_dir}/wb" ] && [ ! -L "${bin_dir}/wb" ]; then
    printf 'workbench installer: left existing non-symlink untouched: %s\n' "${bin_dir}/wb" >&2
else
    temporary_link="${bin_dir}/.wb.$$"
    ln -s workbench "$temporary_link"
    mv -f "$temporary_link" "${bin_dir}/wb"
fi

printf 'Installed Workbench to %s\n' "${bin_dir}/workbench"
case ":${PATH:-}:" in
    *":${bin_dir}:"*) ;;
    *) printf 'Add %s to PATH to use workbench and wb.\n' "$bin_dir" ;;
esac
