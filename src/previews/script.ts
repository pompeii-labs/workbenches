import { PreviewPolicy } from './policy.js';

/**
 * The text of `wbx`, the helper a runner's shell calls to talk to the engine
 * during a run. It is a POSIX sh script with the control file path baked in,
 * so it needs no environment variable and never reaches the network or an
 * API. `wbx preview` checks its arguments and the loopback port, then appends
 * one JSON line to the control file in a single write, which an O_APPEND file
 * keeps whole even when several announcements race. It touches no file system
 * itself, so a runtime that stages files into a sandbox can use it too.
 */
export class PreviewScript {
    static readonly command = 'wbx';

    constructor(private readonly controlFile: string) {}

    text(): string {
        const host = PreviewPolicy.loopbackHost;
        const { minimumPort, maximumPort } = PreviewPolicy;
        return `#!/bin/sh
# Workbench execution helper for one run. The engine writes and removes it.
set -u
control=${shellQuote(this.controlFile)}

usage() {
    cat <<'USAGE'
Usage: wbx <command> [arguments]

Commands:
  preview <port> --name <name>  Show the user a server listening on 127.0.0.1:<port>
USAGE
}

preview_usage() {
    cat <<'USAGE'
Usage: wbx preview <port> --name <name>

Shows the user a server this run started. The server must already listen on
127.0.0.1:<port>. <port> is ${minimumPort} to ${maximumPort}. <name> is 1 to 40 lowercase
letters, digits, or hyphens and starts with a letter or digit.
USAGE
}

fail() {
    printf 'wbx preview: %s\\n' "$1" >&2
    exit "\${2:-2}"
}

listening() {
    if command -v bash >/dev/null 2>&1; then
        bash -c "(exec 3<>/dev/tcp/${host}/$1) 2>/dev/null"
    elif command -v curl >/dev/null 2>&1; then
        curl -s -o /dev/null --max-time 2 "http://${host}:$1/"; code=$?
        [ "$code" != 7 ] && [ "$code" != 28 ] && [ "$code" != 6 ]
    else
        return 1
    fi
}

preview() {
    port=''
    name=''
    while [ $# -gt 0 ]; do
        case $1 in
            -h|--help) preview_usage; exit 0 ;;
            --name)
                [ $# -ge 2 ] || fail '--name requires a value'
                name=$2
                shift 2
                ;;
            --name=*) name=\${1#--name=}; shift ;;
            -*) fail "unknown option: $1" ;;
            *)
                [ -z "$port" ] || fail "unexpected argument: $1"
                port=$1
                shift
                ;;
        esac
    done
    [ -n "$port" ] || { preview_usage >&2; fail 'a port is required'; }
    [ -n "$name" ] || { preview_usage >&2; fail '--name is required'; }
    case $port in
        *[!0-9]*|0*) fail 'the port must be an integer from ${minimumPort} to ${maximumPort}' ;;
    esac
    if [ \${#port} -gt 5 ] || [ "$port" -lt ${minimumPort} ] || [ "$port" -gt ${maximumPort} ]; then
        fail 'the port must be an integer from ${minimumPort} to ${maximumPort}'
    fi
    case $name in
        [abcdefghijklmnopqrstuvwxyz0123456789]*) ;;
        *) fail 'the name must start with a lowercase letter or digit' ;;
    esac
    case $name in
        *[!abcdefghijklmnopqrstuvwxyz0123456789-]*) fail 'the name may contain only lowercase letters, digits, and hyphens' ;;
    esac
    [ \${#name} -le 40 ] || fail 'the name must be at most 40 characters'
    listening "$port" || fail "nothing is listening on ${host}:$port; start the server first" 1
    line=$(printf '{"name":"%s","port":%s}' "$name" "$port")
    printf '%s\\n' "$line" >>"$control" || fail 'could not record the preview' 1
    printf 'wbx: announced preview %s on port %s\\n' "$name" "$port"
}

case \${1-} in
    preview) shift; preview "$@" ;;
    -h|--help|help) usage ;;
    '') usage >&2; exit 2 ;;
    *) printf 'wbx: unknown command: %s\\n' "$1" >&2; usage >&2; exit 2 ;;
esac
`;
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
