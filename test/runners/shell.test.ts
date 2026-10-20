import { describe, expect, test } from 'bun:test';

import { describeShellCommand } from '../../src/runners/shell.js';

const SECRET = 'MUST_NOT_RENDER_SECRET';

function command(value: string): string {
    const described = describeShellCommand(value);
    if (!described) throw new Error('expected a description');
    return described.command;
}

function programs(value: string): string[] {
    return describeShellCommand(value)?.programs ?? [];
}

describe('shell command descriptions', () => {
    test.each([
        ['an environment assignment', `API_KEY=${SECRET} npm test`],
        ['an exported assignment', `export DATABASE_URL="${SECRET}"; npm start`],
        ['a secret-named flag', `deploy --token ${SECRET}`],
        ['a secret-named flag with equals', `deploy --api-key=${SECRET}`],
        ['a quoted flag value', `login --password "${SECRET} with spaces"`],
        [
            'an authorization header',
            `curl -H "Authorization: Bearer ${SECRET}" https://x`,
        ],
        ['an API key header', `curl -H 'x-api-key: ${SECRET}' https://x`],
        ['URL user information', `psql postgres://admin:${SECRET}@db.internal/app`],
        [
            'a secret-named query parameter',
            `curl "https://x/hook?access_token=${SECRET}&a=1"`,
        ],
        ['a user password', `curl -u admin:${SECRET} https://x`],
        ['a bearer token outside a header', `echo Bearer ${SECRET}`],
        [
            'a registry login password',
            `docker login -u ci -p ${SECRET} registry.fly.io`,
        ],
        ['an attached database password', `mysql -u root -p${SECRET} app`],
    ])('removes the value of %s', (_label, value) => {
        expect(command(value)).not.toContain(SECRET);
        expect(command(value)).toContain('[REDACTED]');
    });

    test.each([
        ['an OpenRouter key', 'sk-or-v1-0123456789abcdef0123456789abcdef'],
        ['an Anthropic key', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
        ['a GitHub token', 'ghp_0123456789abcdefABCDEF0123456789abcd'],
        ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0123456789_abcdefghij'],
        ['an AWS access key', 'AKIAIOSFODNN7EXAMPLE'],
        ['a workbenches.dev API key', `wb_${'0123456789abcdef'.repeat(4)}`],
        ['a workbenches.dev run credential', 'wbrc_Q2xhdWRlIHJ1biBjcmVkZW50aWFsIGtleQ'],
        ['a JSON Web Token', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
        ['an opaque token', 'Zx9Qr7Lm2Np4Kd8Vt6Wy3Hb5Jc1Fg0Sa'],
    ])('removes %s passed as a bare argument', (_label, key) => {
        expect(command(`tool configure ${key}`)).toBe('tool configure [REDACTED]');
    });

    test('keeps commit hashes, paths, and ordinary arguments', () => {
        const value =
            'git checkout 3f2c9a7e1b4d5c6f7a8b9c0d1e2f3a4b5c6d7e8f && npx tgcheck --json --scene src/scenes/Main.tscn';
        expect(command(value)).toBe(value);
    });

    test('reduces heredoc bodies to a line count', () => {
        const value = [
            "cat > .env <<'EOF'",
            `OPENROUTER_API_KEY=${SECRET}`,
            'MODE=production',
            'EOF',
            'npm run build',
        ].join('\n');
        expect(command(value)).toBe("cat > .env <<'EOF' [2 lines] EOF npm run build");
        expect(programs(value)).toEqual(['cat', 'npm run build']);
    });

    test('hides the rest of an unterminated heredoc', () => {
        expect(command(`cat <<EOF\n${SECRET}\nmore`)).toBe('cat <<EOF [2 lines]');
    });

    test('removes control characters and bounds the length', () => {
        const described = command(`echo \u001b[31mred\u001b[0m ${'a '.repeat(400)}`);
        expect(described).not.toContain('\u001b');
        expect(Array.from(described).length).toBe(500);
        expect(described.endsWith('...')).toBe(true);
    });

    test('describes nothing for an empty command', () => {
        expect(describeShellCommand('  \n ')).toBeUndefined();
    });
});

describe('shell command programs', () => {
    test.each([
        ['a single program', 'ls -la', ['ls']],
        [
            'a chain',
            'cd dist && npm run build || echo failed; ls',
            ['cd', 'npm run build', 'echo', 'ls'],
        ],
        ['a pipeline', 'cat log.txt | grep error | wc -l', ['cat', 'grep', 'wc']],
        [
            'assignments before the program',
            'NODE_ENV=production API_KEY=x node server.js',
            ['node'],
        ],
        ['package runners', 'npx -y tgcheck --json', ['tgcheck']],
        [
            'package manager subcommands',
            'bun test && pnpm install',
            ['bun test', 'pnpm install'],
        ],
        [
            'package executors',
            'pnpm dlx playwright test && bun x tsc',
            ['playwright', 'tsc'],
        ],
        ['wrappers', 'sudo env FOO=1 timeout 30 nohup ./scripts/gate.sh', ['gate.sh']],
        [
            'a nested shell',
            `bash -lc "npm test && npx tgcheck"`,
            ['npm test', 'tgcheck'],
        ],
        ['a shell script', 'sh scripts/playtest.sh --fast', ['playtest.sh']],
        ['command substitution', 'echo $(date) > out.txt', ['echo', 'date']],
        ['redirections', 'npm test 2>&1 > test.log', ['npm test']],
        ['background jobs', 'npx serve dist & sleep 2', ['serve', 'sleep']],
        ['repeated programs once', 'npx tgcheck; npx tgcheck --json', ['tgcheck']],
    ])('reads %s', (_label, value, expected) => {
        expect(programs(value)).toEqual(expected);
    });

    test('never names a credential or an unreadable token as a program', () => {
        expect(programs('sk-or-v1-0123456789abcdef0123456789abcdef --help')).toEqual(
            []
        );
        expect(programs('"$(cat key)" run')).toEqual([]);
        expect(programs('./bin/{a,b}.sh')).toEqual([]);
    });

    test('bounds the number of programs', () => {
        const value = Array.from({ length: 30 }, (_, index) => `step${index}`).join(
            ' && '
        );
        expect(programs(value)).toHaveLength(16);
    });
});
