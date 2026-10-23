import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { client, json, startedSandbox, toolbox } from './http.js';

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
            image: 'debian:bookworm-slim',
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
        const { sandbox } = await startedSandbox();
        await expect(
            sandbox.start('true', { env: { 'A B': 'x' } })
        ).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message: 'Invalid environment variable name: A B',
        });
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
