import { describe, expect, test } from 'bun:test';

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
        expect(body.command).toBe('{\necho hi\n} 2>&1');
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
