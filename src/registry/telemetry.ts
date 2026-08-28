import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { CatalogRegistryReference } from '../catalog/index.js';
import { workbenchHome } from '../storage.js';
import { WORKBENCH_USER_AGENT } from '../user-agent.js';

interface TelemetryPreferences {
    version: 1;
    runTelemetry: boolean;
    noticeShown?: boolean;
}

export type RegistryEventKind = 'save' | 'run';

export interface RegistryTelemetryOptions {
    home?: string;
    environment?: Record<string, string | undefined>;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class RegistryTelemetry {
    readonly home: string;
    private readonly environment: Record<string, string | undefined>;
    private readonly fetcher: NonNullable<RegistryTelemetryOptions['fetch']>;

    constructor(options: RegistryTelemetryOptions = {}) {
        this.home = options.home ?? workbenchHome();
        this.environment = options.environment ?? process.env;
        this.fetcher = options.fetch ?? fetch;
    }

    async enabled(): Promise<boolean> {
        if (
            this.environment.WB_TELEMETRY_DISABLED === '1' ||
            this.environment.DO_NOT_TRACK === '1'
        ) {
            return false;
        }
        return (await this.readPreferences()).runTelemetry;
    }

    async setEnabled(enabled: boolean): Promise<void> {
        const current = await this.readPreferences();
        await this.writePreferences({ ...current, runTelemetry: enabled });
    }

    async showNotice(): Promise<void> {
        const preferences = await this.readPreferences();
        if (preferences.noticeShown || !preferences.runTelemetry) return;
        process.stderr.write(
            'Workbench reports anonymous save and run counts. Disable run reporting with `wb telemetry off`.\n'
        );
        await this.writePreferences({ ...preferences, noticeShown: true });
    }

    async report(options: {
        registry: CatalogRegistryReference;
        kind: RegistryEventKind;
        idempotencyKey?: string;
    }): Promise<boolean> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2_000);
        try {
            const response = await this.fetcher(`${options.registry.url}/v1/events`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': WORKBENCH_USER_AGENT,
                },
                body: JSON.stringify({
                    idempotency_key: options.idempotencyKey ?? crypto.randomUUID(),
                    version_id: options.registry.version_id,
                    kind: options.kind,
                    cli_version: packageMetadata.version,
                    occurred_at: new Date().toISOString(),
                }),
                signal: controller.signal,
            });
            return response.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    private async readPreferences(): Promise<TelemetryPreferences> {
        const source = await readFile(this.preferencesPath(), 'utf8').catch(() => null);
        if (!source) return { version: 1, runTelemetry: true };
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            throw new Error('Invalid Workbench preferences file');
        }
        if (
            !RegistryTelemetry.isRecord(value) ||
            value.version !== 1 ||
            typeof value.runTelemetry !== 'boolean'
        ) {
            throw new Error('Unsupported Workbench preferences file');
        }
        return {
            version: 1,
            runTelemetry: value.runTelemetry,
            ...(typeof value.noticeShown === 'boolean'
                ? { noticeShown: value.noticeShown }
                : {}),
        };
    }

    private async writePreferences(preferences: TelemetryPreferences): Promise<void> {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        const destination = this.preferencesPath();
        const temporary = join(this.home, `preferences.${crypto.randomUUID()}.tmp`);
        await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, destination);
    }

    private preferencesPath(): string {
        return join(this.home, 'preferences.json');
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
