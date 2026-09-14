import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../types.js';

export interface RunnerConnectionSelection {
    provider: string;
    nativeProvider: string;
    authenticationMethod?: string;
}

export interface RunnerConnectionContext {
    runner: string;
    runtime: string;
}

export interface StoredRunnerConnection extends RunnerConnectionContext {
    provider: string;
    nativeProvider: string;
    authenticationMethod?: string;
    updatedAt: string;
}

interface StoredRunnerConnectionV1 {
    reference: string;
    runner: string;
    model: string;
    runtime: string;
    provider: string;
    native_provider: string;
    updated_at: string;
}

interface ConnectionFileV3 {
    version: 3;
    connections: Array<{
        runner: string;
        runtime: string;
        provider: string;
        native_provider: string;
        authentication_method?: string;
        updated_at: string;
    }>;
}

export class ConnectionStore {
    readonly #home: string;

    constructor(home: string) {
        this.#home = home;
    }

    static context(workbench: ResolvedWorkbench): RunnerConnectionContext {
        return {
            runner: workbench.manifest.runner,
            runtime: workbench.manifest.runtime,
        };
    }

    async list(): Promise<StoredRunnerConnection[]> {
        return readConnections(this.#home);
    }

    async find(
        context: RunnerConnectionContext
    ): Promise<RunnerConnectionSelection | undefined> {
        const connection = (await this.list()).find((candidate) =>
            sameContext(candidate, context)
        );
        return connection
            ? {
                  provider: connection.provider,
                  nativeProvider: connection.nativeProvider,
                  ...(connection.authenticationMethod
                      ? { authenticationMethod: connection.authenticationMethod }
                      : {}),
              }
            : undefined;
    }

    async save(
        context: RunnerConnectionContext,
        selection: RunnerConnectionSelection
    ): Promise<void> {
        const connections = (await this.list()).filter(
            (candidate) => !sameContext(candidate, context)
        );
        await writeConnections(this.#home, [
            ...connections,
            {
                ...context,
                provider: selection.provider,
                nativeProvider: selection.nativeProvider,
                ...(selection.authenticationMethod
                    ? { authenticationMethod: selection.authenticationMethod }
                    : {}),
                updatedAt: new Date().toISOString(),
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
    if (!isRecord(value) || !Array.isArray(value.connections)) {
        throw new Error('The Workbench connection file is invalid');
    }
    if (value.version === 3) return value.connections.map(parseConnectionV3);
    if (value.version === 2) return value.connections.map(parseConnectionV2);
    if (value.version === 1) {
        return migrateConnections(value.connections.map(parseConnectionV1));
    }
    throw new Error('The Workbench connection file is invalid');
}

async function writeConnections(
    home: string,
    connections: StoredRunnerConnection[]
): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const destination = connectionPath(home);
    const temporary = join(home, `connections.${crypto.randomUUID()}.tmp`);
    const contents: ConnectionFileV3 = {
        version: 3,
        connections: connections.map((connection) => ({
            runner: connection.runner,
            runtime: connection.runtime,
            provider: connection.provider,
            native_provider: connection.nativeProvider,
            ...(connection.authenticationMethod
                ? { authentication_method: connection.authenticationMethod }
                : {}),
            updated_at: connection.updatedAt,
        })),
    };
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
}

function parseConnectionV1(value: unknown): StoredRunnerConnectionV1 {
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

function parseConnectionV2(value: unknown): StoredRunnerConnection {
    if (
        !isRecord(value) ||
        typeof value.runner !== 'string' ||
        typeof value.runtime !== 'string' ||
        typeof value.provider !== 'string' ||
        typeof value.native_provider !== 'string' ||
        typeof value.updated_at !== 'string'
    ) {
        throw new Error('The Workbench connection file is invalid');
    }
    return {
        runner: value.runner,
        runtime: value.runtime,
        provider: value.provider,
        nativeProvider: value.native_provider,
        updatedAt: value.updated_at,
    };
}

function parseConnectionV3(value: unknown): StoredRunnerConnection {
    const parsed = parseConnectionV2(value);
    if (
        isRecord(value) &&
        value.authentication_method !== undefined &&
        typeof value.authentication_method !== 'string'
    ) {
        throw new Error('The Workbench connection file is invalid');
    }
    return {
        ...parsed,
        ...(isRecord(value) && typeof value.authentication_method === 'string'
            ? { authenticationMethod: value.authentication_method }
            : {}),
    };
}

function migrateConnections(
    connections: StoredRunnerConnectionV1[]
): StoredRunnerConnection[] {
    const latest = new Map<string, StoredRunnerConnection>();
    for (const connection of connections.toSorted((left, right) =>
        left.updated_at.localeCompare(right.updated_at)
    )) {
        latest.set(connectionKey(connection), {
            runner: connection.runner,
            runtime: connection.runtime,
            provider: connection.provider,
            nativeProvider: connection.native_provider,
            updatedAt: connection.updated_at,
        });
    }
    return [...latest.values()];
}

function sameContext(
    connection: RunnerConnectionContext,
    context: RunnerConnectionContext
): boolean {
    return (
        connection.runner === context.runner && connection.runtime === context.runtime
    );
}

function connectionKey(connection: RunnerConnectionContext): string {
    return `${connection.runner}\0${connection.runtime}`;
}

function connectionPath(home: string): string {
    return join(home, 'connections.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
