#!/bin/sh

set -eu

repository="${WORKBENCH_REPOSITORY:-pompeii-labs/workbenches}"
version="${WORKBENCH_VERSION:-latest}"
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
        '  WORKBENCH_VERSION         Release version or latest (default: latest)' \
        '  WORKBENCH_INSTALL_DIR     Installation directory' \
        '  WORKBENCH_REPOSITORY      GitHub owner/repository' \
        '  WORKBENCH_DOWNLOAD_ROOT   HTTPS release mirror root' \
        '' \
        'latest selects the most recently published release, including prereleases,' \
        'among the 100 newest GitHub release records, not the highest version.'
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

latest_tag() {
    # Do not use /releases/latest: GitHub excludes prereleases from that endpoint.
    # Fetch separately from parsing so an HTTP failure cannot be hidden by a pipe.
    metadata="$(curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 \
        --connect-timeout 10 --max-time 30 --max-filesize 8388608 \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/${repository}/releases?per_page=100")" ||
        fail 'could not discover the latest release; retry or specify --version'
    # Parse JSON rather than matching tag_name in release notes or nested objects.
    # No external JSON runtime is required. Strings remain escaped: selected tags
    # and timestamps must have GitHub canonical, unescaped values to pass validation.
    printf '%s' "$metadata" | LC_ALL=C awk '
        function bad() { invalid = 1; exit 1 }
        function space() { while (substr(json, pos, 1) ~ /^[ \t\r\n]$/) pos++ }
        function string(    start, c, escape, digits) {
            start = ++pos
            while (pos <= length(json)) {
                c = substr(json, pos++, 1)
                if (c == "\"") return substr(json, start, pos - start - 1)
                if (c ~ /[[:cntrl:]]/) bad()
                if (c == "\\") {
                    escape = substr(json, pos++, 1)
                    if (escape == "u") {
                        digits = substr(json, pos, 4)
                        if (length(digits) != 4 || digits ~ /[^0-9a-fA-F]/) bad()
                        pos += 4
                    } else if (escape !~ /^["\\\/bfnrt]$/) bad()
                }
            }
            bad()
        }
        function value(depth,    c, key, result, seen, tag, date, draft, count) {
            if (depth > 100) bad()
            space()
            c = substr(json, pos, 1)
            if (c == "\"") { result = string(); kind = "string"; return result }
            if (c == "{" || c == "[") {
                pos++; space()
                if (substr(json, pos, 1) != (c == "{" ? "}" : "]")) {
                    while (1) {
                        if (c == "{") {
                            if (substr(json, pos, 1) != "\"") bad()
                            key = string(); space()
                            if (substr(json, pos++, 1) != ":") bad()
                        }
                        result = value(depth + 1)
                        if (depth == 1 && kind != "object") bad()
                        if (depth == 2 && c == "{") {
                            if (key == "tag_name" || key == "published_at" || key == "draft") {
                                if (index(seen, "|" key "|")) bad()
                                seen = seen "|" key "|"; count++
                                if (key == "tag_name") {
                                    if (kind != "string") bad()
                                    tag = result
                                } else if (key == "draft") {
                                    if (kind != "boolean") bad()
                                    draft = result
                                } else {
                                    if (kind != "string" && kind != "null") bad()
                                    date = result
                                }
                            }
                        }
                        space()
                        if (substr(json, pos, 1) != ",") break
                        pos++; space()
                    }
                }
                if (substr(json, pos++, 1) != (c == "{" ? "}" : "]")) bad()
                if (depth == 2 && c == "{") {
                    if (count != 3) bad()
                    if (draft == "false") {
                        if (date !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z$/) bad()
                        if (date > newest) { newest = date; selected = tag }
                    }
                }
                kind = c == "{" ? "object" : "array"
                return ""
            }
            if (match(substr(json, pos), /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)/)) {
                result = substr(json, pos, RLENGTH); pos += RLENGTH
                kind = result == "null" ? "null" : result ~ /^(true|false)$/ ? "boolean" : "number"
                return result
            }
            bad()
        }
        { json = json $0 "\n" }
        END {
            if (invalid) exit 1
            pos = 1; space()
            if (substr(json, pos, 1) != "[") bad()
            value(1); space()
            if (pos <= length(json)) bad()
            if (selected !~ /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/) bad()
            print selected
        }
    ' || fail 'latest release metadata is missing or invalid; specify --version'
}

if [ -n "$download_root" ]; then
    base="${download_root%/}"
elif [ "$version" = 'latest' ]; then
    tag="$(latest_tag)" || exit 1
    base="https://github.com/${repository}/releases/download/${tag}"
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
