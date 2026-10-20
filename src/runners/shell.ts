import { REDACTED, redactCredentials } from './redaction.js';
import { displayText } from './text.js';

const MAX_COMMAND_LENGTH = 500;
const MAX_PROGRAMS = 16;
const MAX_NESTING = 3;

/** A shell command as the portable event log may carry it. */
export interface ShellCommandDescription {
    /** The command on one bounded line, with credentials and heredoc bodies removed. */
    command: string;
    /** The programs it runs, in order and without their arguments. */
    programs: string[];
}

/**
 * Describes a shell command an agent ran without carrying the credentials it
 * may hold. Values are removed where commands usually carry them: environment
 * assignments, secret-named flags, authorization headers, URL user
 * information, secret-named query parameters, recognizable key formats, and
 * long opaque tokens. Heredoc bodies are reduced to a line count, because they
 * hold file contents. Program names are read from the structure of the
 * command and never include an argument.
 */
export function describeShellCommand(
    command: string
): ShellCommandDescription | undefined {
    const display = displayText(scrub(heredocs(command, 'count'))).trim();
    if (!display) return undefined;
    return {
        command: bound(display),
        programs: programs(heredocs(command, 'remove'), 0).slice(0, MAX_PROGRAMS),
    };
}

/** Where commands carry credentials, in the order they are scrubbed. */
const SCRUBS: readonly (readonly [RegExp, string])[] = [
    // Authorization-bearing headers, in any quoting.
    [
        /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie)\s*:\s*[^'"\n]+/giu,
        `$1: ${REDACTED}`,
    ],
    // User information in a URL, such as postgres://user:password@host.
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/giu, `$1${REDACTED}@`],
    // Secret-named query parameters.
    [
        /([?&][a-z0-9_-]*(?:token|key|secret|password|signature|sig)=)[^&\s'"#]+/giu,
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
    // A short password flag where it means one: docker login -p x, mysql -px.
    [/(\blogin\b[^;&|\n]*?\s-p)(=|\s+)(?!-)(\S+)/gu, `$1$2${REDACTED}`],
    [/(\bmysql(?:dump|admin)?\b[^;&|\n]*?\s-p)(?=\S)(?!-)\S+/gu, `$1${REDACTED}`],
    // The value of every environment assignment: NAME=value command.
    [
        /((?:^|[\s;&|(])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)]+)/gu,
        `$1=${REDACTED}`,
    ],
];

/** A long run of key-like characters. Opaque when it mixes digits and both cases. */
const OPAQUE = /[A-Za-z0-9_+=-]{32,}/gu;

function scrub(command: string): string {
    let result = command;
    for (const [pattern, replacement] of SCRUBS) {
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
 * The command with each heredoc body replaced by its line count, or removed
 * along with its delimiter. An unterminated body runs to the end.
 */
function heredocs(command: string, mode: 'count' | 'remove'): string {
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
            const end = index < lines.length ? lines[index++] : undefined;
            if (mode === 'remove') continue;
            kept.push(`[${body} ${body === 1 ? 'line' : 'lines'}]`);
            if (end !== undefined) kept.push(end);
        }
    }
    return kept.join('\n');
}

/** Programs that run the command after them. */
const WRAPPERS = new Set([
    'builtin',
    'command',
    'env',
    'exec',
    'nice',
    'nohup',
    'npx',
    'bunx',
    'pnpx',
    'stdbuf',
    'sudo',
    'time',
    'timeout',
    'xargs',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_EXECUTE = new Set(['exec', 'dlx', 'x']);
const PACKAGE_RUN = new Set(['run', 'run-script']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const PROGRAM = /^[A-Za-z0-9._+-]{1,64}$/u;

function programs(command: string, depth: number): string[] {
    const found: string[] = [];
    for (const segment of segments(command)) {
        for (const program of segmentPrograms(words(segment), depth)) {
            if (!found.includes(program)) found.push(program);
        }
    }
    return found;
}

function segmentPrograms(tokens: string[], depth: number): string[] {
    let index = 0;
    while (index < tokens.length && ASSIGNMENT.test(tokens[index] ?? '')) index++;
    while (index < tokens.length && WRAPPERS.has(basename(tokens[index] ?? ''))) {
        const wrapper = basename(tokens[index++] ?? '');
        index = afterOptions(tokens, index);
        if (wrapper === 'timeout' && /^\d/u.test(tokens[index] ?? '')) index++;
    }
    const token = tokens[index];
    if (token === undefined) return [];
    const name = basename(token);

    if (SHELLS.has(name)) {
        const flag = tokens.findIndex(
            (word, position) => position > index && /^-[a-z]*c[a-z]*$/u.test(word)
        );
        const script = flag < 0 ? undefined : tokens[flag + 1];
        if (script !== undefined) {
            return depth < MAX_NESTING ? programs(script, depth + 1) : [];
        }
        const file = tokens.slice(index + 1).find((word) => !word.startsWith('-'));
        return accepted(file === undefined ? name : basename(file));
    }

    if (PACKAGE_MANAGERS.has(name)) {
        const command = tokens[index + 1];
        if (command === undefined || command.startsWith('-')) return accepted(name);
        if (PACKAGE_EXECUTE.has(command)) {
            const target = tokens[afterOptions(tokens, index + 2)];
            return accepted(target === undefined ? name : basename(target));
        }
        if (PACKAGE_RUN.has(command)) {
            const script = tokens[index + 2];
            return accepted(script === undefined ? name : `${name} run ${script}`);
        }
        return accepted(`${name} ${command}`);
    }

    return accepted(name);
}

/** A program name only when every part looks like one and none is a credential. */
function accepted(program: string): string[] {
    const parts = program.split(' ');
    const safe = parts.every((part) => PROGRAM.test(part));
    return safe && redactCredentials(program) === program ? [program] : [];
}

function afterOptions(tokens: string[], start: number): number {
    let index = start;
    while (
        index < tokens.length &&
        ((tokens[index] ?? '').startsWith('-') || ASSIGNMENT.test(tokens[index] ?? ''))
    ) {
        index++;
    }
    return index;
}

function basename(token: string): string {
    return token.split('/').pop() ?? token;
}

/** Simple commands, split at unquoted operators, pipes, and substitutions. */
function segments(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    let quote: string | undefined;
    for (let index = 0; index < command.length; index++) {
        const character = command[index] ?? '';
        if (quote) {
            current += character;
            if (character === quote) quote = undefined;
            else if (character === '\\' && quote === '"')
                current += command[++index] ?? '';
            continue;
        }
        if (character === '\\') {
            current += character + (command[++index] ?? '');
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }
        const redirect =
            character === '&' &&
            (command[index - 1] === '>' || command[index + 1] === '>');
        if (!redirect && ';&|\n()`'.includes(character)) {
            parts.push(current);
            current = '';
            continue;
        }
        if (character === '$' && command[index + 1] === '(') {
            parts.push(current);
            current = '';
            index++;
            continue;
        }
        current += character;
    }
    parts.push(current);
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** Words of a simple command with quotes removed and redirections dropped. */
function words(segment: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let started = false;
    let quote: string | undefined;
    for (let index = 0; index < segment.length; index++) {
        const character = segment[index] ?? '';
        if (quote) {
            if (character === quote) quote = undefined;
            else current += character;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            started = true;
            continue;
        }
        if (/\s/u.test(character)) {
            if (started) tokens.push(current);
            current = '';
            started = false;
            continue;
        }
        current += character;
        started = true;
    }
    if (started) tokens.push(current);

    const kept: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index] ?? '';
        if (/^\d*(?:>>?|<<?|>&|&>)/u.test(token)) {
            // A bare operator takes the next word as its target.
            if (/^\d*(?:>>?|<<?|>&|&>)$/u.test(token)) index++;
            continue;
        }
        kept.push(token);
    }
    return kept;
}
