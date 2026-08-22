import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import packageMetadata from '../package.json' with { type: 'json' };
import type { CatalogRegistryReference } from './catalog.js';

interface Preferences {
    version: 1;
    runTelemetry: boolean;
    noticeShown?: boolean;
}

export type RegistryEventKind = 'save' | 'run';

export async function reportRegistryEvent(options: {
    registry: CatalogRegistryReference;
    kind: RegistryEventKind;
    idempotencyKey?: string;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
        const response = await (options.fetch ?? fetch)(
            `${options.registry.url}/v1/events`,
            {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'pompeii-labs-workbench',
                },
                body: JSON.stringify({
                    idempotency_key: options.idempotencyKey ?? crypto.randomUUID(),
                    version_id: options.registry.version_id,
                    kind: options.kind,
                    cli_version: packageMetadata.version,
                    occurred_at: new Date().toISOString(),
                }),
                signal: controller.signal,
            }
        );
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

export async function runTelemetryEnabled(
    home: string,
    environment: Record<string, string | undefined> = process.env
): Promise<boolean> {
    if (environment.WB_TELEMETRY_DISABLED === '1' || environment.DO_NOT_TRACK === '1') {
        return false;
    }
    return (await readPreferences(home)).runTelemetry;
}

export async function setRunTelemetry(home: string, enabled: boolean): Promise<void> {
    const current = await readPreferences(home);
    await writePreferences(home, { ...current, runTelemetry: enabled });
}

export async function showTelemetryNotice(home: string): Promise<void> {
    const preferences = await readPreferences(home);
    if (preferences.noticeShown || !preferences.runTelemetry) return;
    process.stderr.write(
        'Workbench reports anonymous save and run counts. Disable run reporting with `wb telemetry off`.\n'
    );
    await writePreferences(home, { ...preferences, noticeShown: true });
}

async function readPreferences(home: string): Promise<Preferences> {
    const source = await readFile(preferencesPath(home), 'utf8').catch(() => null);
    if (!source) return { version: 1, runTelemetry: true };
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error('Invalid Workbench preferences file');
    }
    if (
        typeof value !== 'object' ||
        value === null ||
        !('version' in value) ||
        value.version !== 1 ||
        !('runTelemetry' in value) ||
        typeof value.runTelemetry !== 'boolean'
    ) {
        throw new Error('Unsupported Workbench preferences file');
    }
    return {
        version: 1,
        runTelemetry: value.runTelemetry,
        ...('noticeShown' in value && typeof value.noticeShown === 'boolean'
            ? { noticeShown: value.noticeShown }
            : {}),
    };
}

async function writePreferences(home: string, preferences: Preferences): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const destination = preferencesPath(home);
    const temporary = join(home, `preferences.${crypto.randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, destination);
}

function preferencesPath(home: string): string {
    return join(home, 'preferences.json');
}
