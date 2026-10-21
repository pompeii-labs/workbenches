import { describe, expect, test } from 'bun:test';

import { scrubShellCommand } from '../../src/runners/shell.js';

const SECRET = 'MUST_NOT_RENDER_SECRET';

function command(value: string): string {
    const scrubbed = scrubShellCommand(value);
    if (!scrubbed) throw new Error('expected a command');
    return scrubbed;
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
        ['an SSH password', `sshpass -p ${SECRET} ssh host`],
        ['a Redis password', `redis-cli -a ${SECRET} ping`],
        ['a secret-named header', `curl -H "PRIVATE-TOKEN: ${SECRET}" https://x`],
        ['a form field', `curl -d 'password=${SECRET}' https://x/login`],
        ['an encoded form field', `curl --data-urlencode "token=${SECRET}" https://x`],
        ['a JSON field', `curl -d '{"api_key":"${SECRET}"}' https://x`],
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

    test('keeps the operator after a removed value', () => {
        expect(command('FOO_TOKEN=abc&&npm test')).toBe(
            'FOO_TOKEN=[REDACTED]&&npm test'
        );
        expect(command('export GH_TOKEN=x; gh pr list')).toBe(
            'export GH_TOKEN=[REDACTED]; gh pr list'
        );
    });

    test('keeps prose that names an authorization scheme', () => {
        expect(command('echo "basic setup done"')).toBe('echo "basic setup done"');
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
        expect(scrubShellCommand('  \n ')).toBeUndefined();
    });
});
