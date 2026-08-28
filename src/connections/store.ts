import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../types.js';

export interface RunnerConnectionSelection {
    provider: string;
    nativeProvider: string;
}

export interface RunnerConnectionContext {
    reference: string;
    runner: string;
    model: string;
    runtime: string;
}

interface StoredRunnerConnection extends RunnerConnectionContext {
    provider: string;
    native_provider: string;
    updated_at: string;
}

interface ConnectionFile {
    version: 1;
    connections: StoredRunnerConnection[];
}

export class ConnectionStore {
    readonly #home: string;

    constructor(home: string) {
        this.#home = home;
    }

    static context(
        workbench: ResolvedWorkbench,
        reference: string
    ): RunnerConnectionContext {
        return {
            reference,
            runner: workbench.manifest.runner,
            model: workbench.manifest.model.id,
            runtime: workbench.manifest.runtime,
        };
    }

    async find(
        context: RunnerConnectionContext
    ): Promise<RunnerConnectionSelection | undefined> {
        const connection = (await readConnections(this.#home)).find((candidate) =>
            sameContext(candidate, context)
        );
        return connection
            ? {
                  provider: connection.provider,
                  nativeProvider: connection.native_provider,
              }
            : undefined;
    }

    async save(
        context: RunnerConnectionContext,
        selection: RunnerConnectionSelection
    ): Promise<void> {
        const connections = (await readConnections(this.#home)).filter(
            (candidate) => !sameContext(candidate, context)
        );
        await writeConnections(this.#home, [
            ...connections,
            {
                ...context,
                provider: selection.provider,
                native_provider: selection.nativeProvider,
                updated_at: new Date().toISOString(),
            },
        ]);
    }
}

async function readConnections(home: string): Promise<StoredRunnerConnection[]> {
    const source = await readFile(connectionPath(home), 'utf8').catch(() => null);
    if (!source) return [];
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error('The Workbench connection file is invalid');
    }
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.connections)) {
        throw new Error('The Workbench connection file is invalid');
    }
    return value.connections.map(parseConnection);
}

async function writeConnections(
    home: string,
    connections: StoredRunnerConnection[]
): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const destination = connectionPath(home);
    const temporary = join(home, `connections.${crypto.randomUUID()}.tmp`);
    const contents: ConnectionFile = { version: 1, connections };
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
}

function parseConnection(value: unknown): StoredRunnerConnection {
    if (
        !isRecord(value) ||
        typeof value.reference !== 'string' ||
        typeof value.runner !== 'string' ||
        typeof value.model !== 'string' ||
        typeof value.runtime !== 'string' ||
        typeof value.provider !== 'string' ||
        typeof value.native_provider !== 'string' ||
        typeof value.updated_at !== 'string'
    ) {
        throw new Error('The Workbench connection file is invalid');
    }
    return {
        reference: value.reference,
        runner: value.runner,
        model: value.model,
        runtime: value.runtime,
        provider: value.provider,
        native_provider: value.native_provider,
        updated_at: value.updated_at,
    };
}

function sameContext(
    connection: RunnerConnectionContext,
    context: RunnerConnectionContext
): boolean {
    return (
        connection.reference === context.reference &&
        connection.runner === context.runner &&
        connection.model === context.model &&
        connection.runtime === context.runtime
    );
}

function connectionPath(home: string): string {
    return join(home, 'connections.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
