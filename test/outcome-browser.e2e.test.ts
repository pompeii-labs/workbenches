import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { OutcomeExporter, OutcomeOutput, OutcomeStore } from '../src/outcomes/index.js';
import { RunStore } from '../src/runs/store.js';

test.skipIf(process.env.WORKBENCH_OUTCOME_BROWSER_E2E !== '1')(
    'a real headless browser loads sibling SVG and CSS from original, revised, and exported artifact links',
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'workbench-outcome-browser-'));
        const binary =
            process.env.WORKBENCH_OUTCOME_BROWSER_BINARY ??
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        const child = Bun.spawn(
            [
                binary,
                '--headless=new',
                '--disable-gpu',
                '--disable-background-networking',
                '--disable-sync',
                '--no-first-run',
                '--no-default-browser-check',
                '--remote-debugging-port=0',
                `--user-data-dir=${join(root, 'browser-profile')}`,
                'about:blank',
            ],
            {
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'pipe',
                env: Object.fromEntries(
                    ['PATH', 'HOME', 'TMPDIR'].flatMap((name) =>
                        process.env[name] ? [[name, process.env[name] as string]] : []
                    )
                ),
            }
        );
        let client: DevTools | undefined;
        try {
            const endpoint = await Promise.race([
                debuggerEndpoint(child.stderr),
                Bun.sleep(10_000).then(() => {
                    throw new Error('Headless browser did not start');
                }),
            ]);
            client = await DevTools.connect(endpoint);
            const target = await client.call('Target.createTarget', {
                url: 'about:blank',
            });
            const attached = await client.call('Target.attachToTarget', {
                targetId: target.targetId,
                flatten: true,
            });
            const sessionId = attached.sessionId as string;
            const store = new OutcomeStore(root);
            const files: string[] = [];
            for (const heading of ['VERSION ONE', 'VERSION TWO']) {
                const output = await OutcomeOutput.create(root, RunStore.createId());
                try {
                    for (const [path, bytes] of Object.entries({
                        'reports/report.html': `<!doctype html><html><head><link rel="stylesheet" href="../assets/report.css"></head><body><h1>${heading}</h1><img src="../assets/logo.svg"></body></html>`,
                        'assets/logo.svg':
                            '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="purple"/></svg>',
                        'assets/report.css': 'body { color: purple; }',
                    })) {
                        await mkdir(dirname(join(output.directory, path)), {
                            recursive: true,
                        });
                        await writeFile(join(output.directory, path), bytes);
                    }
                    const outcome = await store.commit(
                        {
                            version: 1,
                            id: OutcomeStore.createId(),
                            run_id: RunStore.createId(),
                            created_at: new Date().toISOString(),
                            completeness: 'complete',
                            changesets: [],
                            warnings: [],
                            ...(await output.collect(store)),
                        },
                        'present'
                    );
                    const report = outcome.artifacts.find(
                        (file) => file.path === 'reports/report.html'
                    );
                    if (!report) throw new Error('Report fixture missing');
                    files.push(await store.artifactPath(outcome.id, report.id));
                    if (heading === 'VERSION TWO') {
                        await new OutcomeExporter(store).export(
                            outcome,
                            join(root, 'export')
                        );
                        files.push(
                            join(root, 'export', 'artifacts', 'reports', 'report.html')
                        );
                    }
                } finally {
                    await output.cleanup();
                }
            }
            for (const [index, path] of files.entries()) {
                const url = pathToFileURL(path).href;
                await client.call('Page.navigate', { url }, sessionId);
                let rendered: Record<string, unknown> | undefined;
                for (let attempt = 0; attempt < 100; attempt++) {
                    const response = await client.call(
                        'Runtime.evaluate',
                        {
                            expression:
                                'document.readyState === "complete" && document.querySelector("img") ? ({ heading: document.querySelector("h1").textContent, width: document.querySelector("img").naturalWidth, color: getComputedStyle(document.body).color }) : null',
                            returnByValue: true,
                        },
                        sessionId
                    );
                    rendered = (response.result as { value?: Record<string, unknown> })
                        .value;
                    const location = await client.call(
                        'Runtime.evaluate',
                        {
                            expression: 'location.href',
                            returnByValue: true,
                        },
                        sessionId
                    );
                    if (
                        (location.result as { value?: string }).value === url &&
                        rendered?.width === 36 &&
                        rendered.heading ===
                            (index === 0 ? 'VERSION ONE' : 'VERSION TWO')
                    )
                        break;
                    await Bun.sleep(20);
                }
                expect(rendered, path).toEqual({
                    heading: index === 0 ? 'VERSION ONE' : 'VERSION TWO',
                    width: 36,
                    color: 'rgb(128, 0, 128)',
                });
            }
            await store.close();
        } finally {
            client?.close();
            child.kill('SIGTERM');
            await child.exited;
            await rm(root, { recursive: true, force: true });
        }
    },
    60_000
);

async function debuggerEndpoint(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let output = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error(`Headless browser exited: ${output}`);
            output += new TextDecoder().decode(chunk.value);
            const endpoint = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
            if (endpoint) return endpoint;
        }
    } finally {
        reader.releaseLock();
    }
}

class DevTools {
    private nextId = 0;
    private readonly pending = new Map<
        number,
        {
            resolve: (value: Record<string, unknown>) => void;
            reject: (cause: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private constructor(private readonly socket: WebSocket) {
        socket.addEventListener('message', (event) => {
            const packet = JSON.parse(String(event.data));
            const pending = this.pending.get(packet.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(packet.id);
            if (packet.error) pending.reject(new Error(packet.error.message));
            else pending.resolve(packet.result ?? {});
        });
    }
    static async connect(endpoint: string) {
        const socket = new WebSocket(endpoint);
        await new Promise<void>((resolve, reject) => {
            socket.addEventListener('open', () => resolve(), { once: true });
            socket.addEventListener(
                'error',
                () => reject(new Error('Browser debugging connection failed')),
                { once: true }
            );
        });
        return new DevTools(socket);
    }
    call(
        method: string,
        params: Record<string, unknown>,
        sessionId?: string
    ): Promise<Record<string, unknown>> {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Browser request timed out: ${method}`));
            }, 5_000);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(
                JSON.stringify({
                    id,
                    method,
                    params,
                    ...(sessionId ? { sessionId } : {}),
                })
            );
        });
    }
    close() {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Browser debugging connection closed'));
        }
        this.pending.clear();
        this.socket.close();
    }
}
