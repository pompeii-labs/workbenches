import { REDACTED, redactCredentials } from './redaction.js';
import { displayText } from './text.js';

const MAX_COMMAND_LENGTH = 500;

/**
 * A shell command an agent ran, as the portable event log may carry it: on
 * one bounded line, without the credentials it may hold. Values are removed
 * where commands usually carry them: environment assignments, secret-named
 * flags, fields, and query parameters, authorization headers, URL user
 * information, recognizable key formats, and long opaque tokens. Heredoc
 * bodies are reduced to a line count, because they hold file contents.
 */
export function scrubShellCommand(command: string): string | undefined {
    const display = displayText(scrub(heredocs(command))).trim();
    return display ? bound(display) : undefined;
}

/**
 * A shell command an agent ran, whole, with the same credentials removed as
 * `scrubShellCommand` removes. Heredoc bodies, lines, and length are kept.
 */
export function scrubShellText(command: string): string {
    return scrub(command, SCRUBS);
}

/**
 * Any text an agent's tool read or wrote, with the credentials the shell
 * scrubber recognizes removed: secret-named fields and flags, authorization
 * headers, URL user information, recognizable key formats, and long opaque
 * tokens. Plain `NAME=value` assignments are kept, because outside a command
 * line they are usually code.
 */
export function scrubSecretText(text: string): string {
    return scrub(text, SECRET_SCRUBS);
}

/** Names that mark the value after them as a secret. */
const SECRET_NAME =
    '[a-z0-9_-]*(?:token|key|secret|password|passwd|credentials?|signature)[a-z0-9_-]*';

/** Where any text carries credentials, in the order they are scrubbed. */
const SECRET_SCRUBS: readonly (readonly [RegExp, string])[] = [
    // Authorization-bearing headers, in any quoting.
    [
        /\b(authorization|proxy-authorization|cookie)\s*:\s*[^'"\n]+/giu,
        `$1: ${REDACTED}`,
    ],
    // User information in a URL, such as postgres://user:password@host.
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/giu, `$1${REDACTED}@`],
    // A secret-named field in a header, query, form body, or JSON body:
    // x-api-key: x, ?access_token=x, -d 'password=x', {"api_key":"x"}.
    [
        new RegExp(
            `((?:^|[?&\\s'"{,])"?${SECRET_NAME}"?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|[^&\\s'",;|)}#]+)`,
            'giu'
        ),
        `$1${REDACTED}`,
    ],
    // The value of a secret-named flag: --token x, --api-key=x, --password "x".
    [
        /(--?[a-z0-9-]*(?:token|password|passwd|secret|api-?key|apikey|credential|auth)[a-z0-9-]*)(=|\s+)(?!-)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s'"]+)/giu,
        `$1$2${REDACTED}`,
    ],
    // A password after a user name: curl -u user:password.
    [
        /((?:^|\s)(?:-u|--user|--proxy-user)(?:=|\s+)['"]?[^\s:'"]+):[^\s'"]+/giu,
        `$1:${REDACTED}`,
    ],
    // A short password flag where it means one: docker login -p x,
    // sshpass -p x, redis-cli -a x, mysql -px.
    [
        /(\b(?:login|sshpass)\b[^;&|\n]*?\s-p|\bredis-cli\b[^;&|\n]*?\s-a)(=|\s+)(?!-)(\S+)/gu,
        `$1$2${REDACTED}`,
    ],
    [/(\bmysql(?:dump|admin)?\b[^;&|\n]*?\s-p)(?=\S)(?!-)\S+/gu, `$1${REDACTED}`],
];

/** Where commands carry credentials, in the order they are scrubbed. */
const SCRUBS: readonly (readonly [RegExp, string])[] = [
    ...SECRET_SCRUBS,
    // The value of every environment assignment: NAME=value command.
    [
        /((?:^|[\s;&|(])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]+)/gu,
        `$1=${REDACTED}`,
    ],
];

/** A long run of key-like characters. Opaque when it mixes digits and both cases. */
const OPAQUE = /[A-Za-z0-9_+=-]{32,}/gu;

function scrub(
    command: string,
    scrubs: readonly (readonly [RegExp, string])[] = SCRUBS
): string {
    let result = command;
    for (const [pattern, replacement] of scrubs) {
        result = result.replace(pattern, replacement);
    }
    return redactCredentials(result).replace(OPAQUE, (token) =>
        /[0-9]/u.test(token) && /[a-z]/u.test(token) && /[A-Z]/u.test(token)
            ? REDACTED
            : token
    );
}

function bound(value: string): string {
    const characters = Array.from(value);
    return characters.length > MAX_COMMAND_LENGTH
        ? `${characters.slice(0, MAX_COMMAND_LENGTH - 3).join('')}...`
        : value;
}

const HEREDOC = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/gu;

/**
 * The command with each heredoc body replaced by its line count. An
 * unterminated body runs to the end.
 */
function heredocs(command: string): string {
    const lines = command.split(/\r?\n/u);
    const kept: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index++] ?? '';
        kept.push(line);
        for (const match of line.matchAll(HEREDOC)) {
            const delimiter = match[2];
            let body = 0;
            while (index < lines.length && lines[index]?.trim() !== delimiter) {
                body++;
                index++;
            }
            kept.push(`[${body} ${body === 1 ? 'line' : 'lines'}]`);
            if (index < lines.length) kept.push(lines[index++] ?? '');
        }
    }
    return kept.join('\n');
}
