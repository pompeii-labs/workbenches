import { describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { type WorkbenchEvent, WorkbenchRun } from '../../src/runs/index.js';
import { RunStore } from '../../src/runs/store.js';
import { DockerManagedContainers } from '../../src/runtimes/docker/containers.js';
import { E2BSdkClient } from '../../src/runtimes/e2b/sdk.js';

const enabled = process.env.WORKBENCH_OUTCOME_HARNESS_E2E === '1';
const runtimes = (process.env.WORKBENCH_OUTCOME_RUNTIMES ?? 'local,docker,e2b').split(
    ','
);

describe.skipIf(!enabled)('real one-shot execution preparation', () => {
    for (const runtime of ['local', 'docker', 'e2b']) {
        for (const runner of ['opencode', 'pi']) {
            test.skipIf(!runtimes.includes(runtime))(
                `${runner} on ${runtime} returns durable results and releases its runtime`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const directory = await realpath(
                        await mkdtemp(join(tmpdir(), 'execution-'))
                    );
                    const home = join(directory, 'home');
                    const workspace = join(directory, 'project');
                    const packageDirectory = join(workspace, '.workbenches', 'probe');
                    const events: WorkbenchEvent[] = [];
                    const runId = RunStore.createId();
                    const client =
                        runtime === 'e2b'
                            ? new E2BSdkClient(process.env.E2B_API_KEY as string)
                            : undefined;
                    try {
                        await mkdir(packageDirectory, { recursive: true });
                        await writeFile(
                            join(packageDirectory, 'instructions.md'),
                            'Use existing tools to carry out the requested work.'
                        );
                        const dockerfile =
                            runner === 'opencode'
                                ? 'FROM ghcr.io/anomalyco/opencode:1.18.30\nUSER root\nRUN apk add --no-cache git tar\n'
                                : 'FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates && rm -rf /var/lib/apt/lists/*\nRUN npm install --global @earendil-works/pi-coding-agent@0.84.3\n';
                        await writeFile(
                            join(packageDirectory, 'Dockerfile.workbench'),
                            dockerfile
                        );
                        await writeFile(
                            join(packageDirectory, 'workbench.yml'),
                            Bun.YAML.stringify({
                                spec: 0,
                                version: '0.0.1-e2e',
                                name: `execution-${runner}-${runtime}`,
                                runner,
                                model: {
                                    id:
                                        process.env.WORKBENCH_OUTCOME_MODEL ??
                                        'anthropic/claude-sonnet-4-5',
                                    routes: [{ provider: 'openrouter' }],
                                },
                                instructions: './instructions.md',
                                skills: [],
                                tools: ['sh'],
                                mcps: [],
                                env: {},
                                runtime,
                                ...(runtime === 'local'
                                    ? {}
                                    : {
                                          image: {
                                              build: './Dockerfile.workbench',
                                              context: '.',
                                          },
                                      }),
                            })
                        );
                        const environment = Object.fromEntries(
                            [
                                'PATH',
                                'HOME',
                                'TMPDIR',
                                'USER',
                                'LANG',
                                'LC_ALL',
                                'TERM',
                                'DOCKER_CONFIG',
                                'OPENROUTER_API_KEY',
                                'E2B_API_KEY',
                            ].flatMap((name) =>
                                process.env[name] ? [[name, process.env[name]]] : []
                            )
                        );
                        const code = await WorkbenchRun.execute(
                            {
                                workbenchPath: packageDirectory,
                                workspaceDirectory: workspace,
                                home,
                                runId,
                                connection: 'openrouter',
                                task: 'Use your existing tools to return result.txt containing exactly durable-result followed by a newline. Do not modify project files. Finish with one short sentence.',
                                onEvent: (event) => void events.push(event),
                            },
                            { env: environment }
                        );
                        expect(
                            code,
                            JSON.stringify(
                                events.filter((event) => event.type === 'run.failed')
                            )
                        ).toBe(0);
                        expect(events[0]?.type).toBe('run.started');
                        expect(events.at(-1)?.type).toBe('run.completed');
                        const store = new OutcomeStore(home);
                        try {
                            const outcome = await store.findFinalByRun(runId);
                            const artifact = outcome?.artifacts.find(
                                (value) => value.name === 'result.txt'
                            );
                            if (!outcome || !artifact)
                                throw new Error('Missing returned artifact');
                            expect(outcome.completeness).toBe('complete');
                            expect(
                                await readFile(
                                    await store.artifactPath(outcome.id, artifact.id),
                                    'utf8'
                                )
                            ).toBe('durable-result\n');
                        } finally {
                            await store.close();
                        }
                        expect(
                            await stat(join(home, 'runs', runId, 'outbox')).catch(
                                () => undefined
                            )
                        ).toBeUndefined();
                        expect(
                            await stat(join(workspace, 'result.txt')).catch(
                                () => undefined
                            )
                        ).toBeUndefined();
                        if (client)
                            expect(
                                await client.listManaged(RunStore.scope(home))
                            ).toEqual([]);
                        if (runtime === 'docker') {
                            const containers = await DockerManagedContainers.connect(
                                RunStore.scope(home)
                            );
                            if (!containers)
                                throw new Error('Docker became unavailable');
                            expect(await containers.list()).toEqual([]);
                        }
                    } finally {
                        if (runtime === 'docker') {
                            const containers = await DockerManagedContainers.connect(
                                RunStore.scope(home)
                            );
                            for (const container of (await containers?.list()) ?? [])
                                await containers?.remove(container);
                        }
                        if (client) {
                            for (const sandbox of await client.listManaged(
                                RunStore.scope(home)
                            ))
                                await client.killSandbox(sandbox.id);
                        }
                        await rm(directory, { recursive: true, force: true });
                    }
                },
                10 * 60 * 1_000
            );
        }
    }
});
