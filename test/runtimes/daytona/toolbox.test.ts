import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    client,
    type Handler,
    json,
    type Recorded,
    startedSandbox,
    toolbox,
} from './http.js';

const fakeEnv = { FAKE_API_KEY: 'fake-key-value', OTHER: "it's fake" };

/**
 * Answers a background launch. The request whose path ends with `failing` is
 * refused, and `execute` answers one-shot commands.
 */
function launchHandler(
    failing?: string,
    execute: Handler = () => json({ exitCode: 0, result: '' })
): Handler {
    return (request) => {
        const path = request.url.pathname;
        if (failing && path.endsWith(failing)) {
            return new Response('launch refused', { status: 400 });
        }
        if (path.endsWith('/process/execute')) return execute(request);
        if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
        if (path.endsWith('/command/cmd-1')) return json({ id: 'cmd-1' });
        if (path.endsWith('/logs')) return json({ stdout: '', stderr: '' });
        return json({});
    };
}

function execOf(requests: Recorded[]): string {
    const exec = requests.find((request) => request.url.pathname.endsWith('/exec'));
    return JSON.parse(String(exec?.body)).command;
}

async function uploadOf(requests: Recorded[]): Promise<{ path: string; text: string }> {
    const upload = requests.filter((request) =>
        request.url.pathname.endsWith('/files/bulk-upload')
    );
    expect(upload).toHaveLength(1);
    const form = upload[0]?.body;
    if (!(form instanceof FormData)) throw new Error('The upload is not form data');
    const file = form.get('files[0].file');
    if (!(file instanceof Blob)) throw new Error('The upload has no file');
    return { path: String(form.get('files[0].path')), text: await file.text() };
}

describe('DaytonaToolbox', () => {
    test('reads the toolbox URL from its endpoint when the sandbox omits it', async () => {
        const { api, requests } = client((request) => {
            const path = request.url.pathname;
            if (request.method === 'POST' && path === '/api/sandbox') {
                return json({ id: 'sandbox-1' });
            }
            if (path === '/api/sandbox/sandbox-1') {
                return json({ id: 'sandbox-1', state: 'started' });
            }
            if (path === '/api/sandbox/sandbox-1/toolbox-proxy-url') {
                return json({ url: 'https://proxy.daytona.test/toolbox' });
            }
            if (path === '/toolbox/sandbox-1/process/execute') {
                return json({ exitCode: 0, result: 'ok' });
            }
            return json({}, 404);
        });
        const sandbox = await api.createSandbox({
            snapshot: 'wb-fixture',
            labels: {},
            leaseMinutes: 5,
        });
        await sandbox.run('true');
        expect(requests.at(-1)?.url.href).toBe(`${toolbox}/process/execute`);
    });

    test('runs a command to completion with directory and environment', async () => {
        const { sandbox, requests } = await startedSandbox(() =>
            json({ exitCode: 7, result: 'partial' })
        );
        const result = await sandbox.run('echo hi', {
            cwd: '/workspace',
            env: { A: 'b' },
        });
        expect(result).toEqual({ code: 7, stdout: 'partial', stderr: '' });
        const call = requests.at(-1);
        expect(call?.url.href).toBe(`${toolbox}/process/execute`);
        const body = JSON.parse(String(call?.body));
        expect(body.command).toContain('echo hi');
        expect(body.cwd).toBe('/workspace');
        expect(body.envs).toEqual({ A: 'b' });
        expect(body.timeout).toBeGreaterThan(0);
    });

    test('never reads a reply without an exit code as success', async () => {
        const replies: Array<() => Response> = [
            () => new Response('', { status: 200 }),
            () =>
                new Response('<html><body>Bad gateway</body></html>', {
                    status: 200,
                    headers: { 'content-type': 'text/html' },
                }),
            () => json({ result: 'ok' }),
            () => json({ exitCode: 'zero', result: 'ok' }),
        ];
        for (const reply of replies) {
            let toolboxCalls = 0;
            const { sandbox } = await startedSandbox(() => {
                toolboxCalls++;
                return reply();
            });
            await expect(sandbox.run('true')).rejects.toThrow(
                'Daytona toolbox process/execute returned an unexpected response: expected JSON with a numeric exitCode'
            );
            expect(toolboxCalls).toBe(1);
        }
    });

    test('resends a command whose reply was lost, unchanged', async () => {
        let calls = 0;
        const { sandbox, requests } = await startedSandbox(() =>
            ++calls === 1
                ? new Response('error code: 520', { status: 520 })
                : json({ exitCode: 0, result: 'done' })
        );
        await expect(sandbox.run('make build')).resolves.toEqual({
            code: 0,
            stdout: 'done',
            stderr: '',
        });
        const sent = requests
            .filter((request) => request.url.pathname.endsWith('/process/execute'))
            .map((request) => JSON.parse(String(request.body)).command);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toBe(sent[0]);
    });

    test('a resent command runs once and returns the first result', async () => {
        const { sandbox, requests } = await startedSandbox(() =>
            json({ exitCode: 0, result: '' })
        );
        await sandbox.run('echo ran >> "$COUNT"; echo out; exit 3');
        const command: string = JSON.parse(String(requests.at(-1)?.body)).command;
        const directory = await mkdtemp(join(tmpdir(), 'wb-daytona-once-'));
        try {
            const local = command.replaceAll('/tmp/.workbench-commands', directory);
            const env = { ...process.env, COUNT: join(directory, 'count') };
            const first = spawnSync('sh', ['-c', local], { env, encoding: 'utf8' });
            const second = spawnSync('sh', ['-c', local], { env, encoding: 'utf8' });
            expect([first.status, first.stdout]).toEqual([3, 'out\n']);
            expect([second.status, second.stdout]).toEqual([3, 'out\n']);
            expect(await readFile(join(directory, 'count'), 'utf8')).toBe('ran\n');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('runs as root through sudo when the sandbox user is not root', async () => {
        const { sandbox, requests } = await startedSandbox(() =>
            json({ exitCode: 0, result: '' })
        );
        await sandbox.run('mkdir -p /workspace', { user: 'root' });
        const body = JSON.parse(String(requests.at(-1)?.body));
        expect(body.command).toContain('id -u');
        expect(body.command).toContain('sudo -n');
        expect(body.command).toContain("sh -c 'mkdir -p /workspace'");
    });

    test('refuses an environment variable name that is not a shell identifier', async () => {
        const { sandbox, requests } = await startedSandbox();
        await expect(
            sandbox.start('true', { env: { 'A B': 'x' } })
        ).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message: 'Invalid environment variable name: A B',
        });
        expect(
            requests.some((request) => request.url.pathname.startsWith('/toolbox'))
        ).toBeFalse();
    });

    test('passes a background command its environment through an uploaded file, never its command line', async () => {
        const { sandbox, requests } = await startedSandbox(launchHandler());
        const started = await sandbox.start(
            'if [ -e "$ENV_FILE" ]; then echo present; else printf "%s|%s" "$FAKE_API_KEY" "$OTHER"; fi',
            { cwd: '/workspace', env: fakeEnv }
        );
        await started.kill();
        const upload = await uploadOf(requests);
        expect(upload.path).toMatch(/^\/tmp\/\.workbench-env-[0-9a-f-]{36}$/);
        expect(upload.text).toBe(
            `export FAKE_API_KEY='fake-key-value'\nexport OTHER='it'"'"'s fake'\n`
        );
        const command = execOf(requests);
        for (const value of Object.values(fakeEnv)) {
            expect(command).not.toContain(value);
        }
        expect(
            command.startsWith(
                `(. '${upload.path}' && rm -f '${upload.path}' && cd '/workspace' && `
            )
        ).toBeTrue();
        // The upload comes before the session and its command.
        const order = requests.map((request) => request.url.pathname);
        expect(
            order.findIndex((path) => path.endsWith('/files/bulk-upload'))
        ).toBeLessThan(order.findIndex((path) => path.endsWith('/process/session')));

        // Sourced by a real POSIX sh, the file is gone before the command runs.
        const directory = await mkdtemp(join(tmpdir(), 'wb-daytona-env-'));
        try {
            const file = join(directory, 'env');
            await writeFile(file, upload.text);
            const local = command
                .replaceAll(upload.path, file)
                .replace(`cd '/workspace'`, `cd '${directory}'`);
            const ran = spawnSync('sh', ['-c', local], {
                env: { PATH: process.env.PATH, ENV_FILE: file },
                encoding: 'utf8',
            });
            expect([ran.status, ran.stdout]).toEqual([0, "fake-key-value|it's fake"]);
            expect(existsSync(file)).toBeFalse();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    test('removes the environment file when the upload or launch fails', async () => {
        for (const failing of ['/files/bulk-upload', '/process/session', '/exec']) {
            const { sandbox, requests } = await startedSandbox(launchHandler(failing));
            await expect(
                sandbox.start('opencode serve', { env: fakeEnv })
            ).rejects.toThrow(`failed with 400: launch refused`);
            const upload = await uploadOf(requests);
            const removal = requests.at(-1);
            expect(removal?.url.pathname.endsWith('/process/execute')).toBeTrue();
            expect(JSON.parse(String(removal?.body)).command).toContain(
                `rm -f '${upload.path}'`
            );
        }
    });

    test('keeps the launch error when removing the environment file fails', async () => {
        const { sandbox, requests } = await startedSandbox(
            launchHandler(
                '/exec',
                () => new Response('removal refused', { status: 400 })
            )
        );
        const failure = await sandbox
            .start('opencode serve', { env: fakeEnv })
            .catch((error: unknown) => error);
        expect(String(failure)).toContain('/exec failed with 400: launch refused');
        expect(requests.at(-1)?.url.pathname.endsWith('/process/execute')).toBeTrue();
    });

    test('starts a command without environment values as before, with no upload', async () => {
        for (const env of [undefined, {}]) {
            const { sandbox, requests } = await startedSandbox(launchHandler());
            const started = await sandbox.start('opencode serve', {
                cwd: '/workspace',
                ...(env ? { env } : {}),
            });
            await started.kill();
            expect(
                requests.some((request) =>
                    request.url.pathname.endsWith('/bulk-upload')
                )
            ).toBeFalse();
            expect(execOf(requests)).toBe(`(cd '/workspace' && opencode serve)`);
        }
    });

    test('uploads a file as multipart form data', async () => {
        const { sandbox, requests } = await startedSandbox();
        await sandbox.upload('/tmp/input.tar.gz', new TextEncoder().encode('bytes'));
        const call = requests.at(-1);
        expect(call?.url.href).toBe(`${toolbox}/files/bulk-upload`);
        const form = call?.body as FormData;
        expect(form.get('files[0].path')).toBe('/tmp/input.tar.gz');
        expect(await (form.get('files[0].file') as Blob).text()).toBe('bytes');
    });

    test('downloads a file as a stream', async () => {
        const { sandbox, requests } = await startedSandbox((request) =>
            request.url.pathname.endsWith('/files/download')
                ? new Response('remote bytes')
                : json({})
        );
        const stream = await sandbox.download('/outbox/report.txt');
        expect(await new Response(stream).text()).toBe('remote bytes');
        expect(requests.at(-1)?.url.searchParams.get('path')).toBe(
            '/outbox/report.txt'
        );
    });

    test('asks for a signed preview URL for a port', async () => {
        const { sandbox, requests } = await startedSandbox((request) =>
            request.url.pathname.endsWith('/signed-preview-url')
                ? json({ url: 'https://4096-abc.proxy.daytona.test' })
                : json({})
        );
        await expect(sandbox.previewUrl(4096, 3_600)).resolves.toBe(
            'https://4096-abc.proxy.daytona.test'
        );
        const call = requests.at(-1);
        expect(call?.url.pathname).toBe(
            '/api/sandbox/sandbox-1/ports/4096/signed-preview-url'
        );
        expect(call?.url.searchParams.get('expiresInSeconds')).toBe('3600');
    });

    test('mints a signed preview URL with its token and expires it without naming the token', async () => {
        let expireStatus = 200;
        const { sandbox, requests } = await startedSandbox((request) => {
            if (request.url.pathname.endsWith('/signed-preview-url'))
                return json({
                    sandboxId: 'sandbox-1',
                    port: 5173,
                    token: 'fixture-preview-token',
                    url: 'https://5173-fixture-preview-token.proxy.daytona.test',
                });
            if (request.url.pathname.endsWith('/expire'))
                return new Response('token fixture-preview-token is unknown', {
                    status: expireStatus,
                });
            return json({});
        });
        await expect(sandbox.signedPreviewUrl?.(5173, 30)).resolves.toEqual({
            url: 'https://5173-fixture-preview-token.proxy.daytona.test',
            token: 'fixture-preview-token',
        });
        expect(requests.at(-1)?.url.searchParams.get('expiresInSeconds')).toBe('30');
        await sandbox.expireSignedPreviewUrl?.(5173, 'fixture-preview-token');
        expect(requests.at(-1)?.method).toBe('POST');
        expect(requests.at(-1)?.url.pathname).toBe(
            '/api/sandbox/sandbox-1/ports/5173/signed-preview-url/fixture-preview-token/expire'
        );
        expireStatus = 404;
        const failure = await sandbox
            .expireSignedPreviewUrl?.(5173, 'fixture-preview-token')
            .catch((error: unknown) => error);
        expect(String(failure)).toBe(
            'DaytonaApiError: Daytona did not expire the signed preview URL for port 5173 (status 404)'
        );
    });

    test('refuses a signed preview reply without a URL and token', async () => {
        const { sandbox } = await startedSandbox((request) =>
            request.url.pathname.endsWith('/signed-preview-url')
                ? json({ url: 'https://5173-x.proxy.daytona.test' })
                : json({})
        );
        await expect(sandbox.signedPreviewUrl?.(5173, 30)).rejects.toThrow(
            'Daytona returned an unexpected signed preview URL response'
        );
    });

    test('reports sandbox size from its description', async () => {
        const { sandbox } = await startedSandbox();
        expect(await sandbox.info()).toEqual({
            cpuCount: 2,
            memoryMB: 4_096,
            diskGb: 10,
            createdAt: new Date('2026-09-30T12:00:00.000Z'),
        });
    });
});
