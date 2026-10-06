import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { CatalogRegistryReference } from '../catalog/index.js';
import { workbenchHome } from '../storage.js';
import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import { RegistryKeyring } from './keyring.js';

export type RegistryEventKind = 'save' | 'run';

export interface RegistryTelemetryOptions {
    home?: string;
    environment?: Record<string, string | undefined>;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    /** Where the one-time notice is written. Defaults to standard error. */
    notices?: { write(text: string): unknown };
}

/**
 * Reports anonymous save and run counts for registry Workbenches published
 * by organizations the user holds no login for. `report` is the only gate:
 * every save and run goes through it.
 */
export class RegistryTelemetry {
    static readonly notice =
        'Workbench reports anonymous save and run counts for registry Workbenches published by other organizations. Set DO_NOT_TRACK=1 to disable.';

    readonly home: string;
    private readonly environment: Record<string, string | undefined>;
    private readonly fetcher: NonNullable<RegistryTelemetryOptions['fetch']>;
    private readonly notices: NonNullable<RegistryTelemetryOptions['notices']>;

    constructor(options: RegistryTelemetryOptions = {}) {
        this.home = options.home ?? workbenchHome();
        this.environment = options.environment ?? process.env;
        this.fetcher = options.fetch ?? fetch;
        this.notices = options.notices ?? process.stderr;
    }

    /** Returns whether a count was accepted. Never throws. */
    async report(options: {
        registry: CatalogRegistryReference;
        kind: RegistryEventKind;
        idempotencyKey?: string;
    }): Promise<boolean> {
        try {
            if (!(await this.reportable(options.registry))) return false;
            await this.showNotice();
            return await this.send(options);
        } catch {
            return false;
        }
    }

    private async reportable(registry: CatalogRegistryReference): Promise<boolean> {
        const doNotTrack = this.environment.DO_NOT_TRACK;
        if (doNotTrack !== undefined && doNotTrack !== '' && doNotTrack !== '0') {
            return false;
        }
        if (registry.visibility === 'private') return false;
        return !(await new RegistryKeyring(this.home, registry.url).holds(
            registry.publisher
        ));
    }

    private async showNotice(): Promise<void> {
        if (await this.noticeShown()) return;
        await this.markNoticeShown();
        this.notices.write(`${RegistryTelemetry.notice}\n`);
    }

    private async send(options: {
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

    private async noticeShown(): Promise<boolean> {
        const source = await readFile(this.preferencesPath(), 'utf8').catch(() => null);
        if (!source) return false;
        try {
            const value: unknown = JSON.parse(source);
            return (
                typeof value === 'object' &&
                value !== null &&
                Reflect.get(value, 'noticeShown') === true
            );
        } catch {
            return false;
        }
    }

    private async markNoticeShown(): Promise<void> {
        await mkdir(this.home, { recursive: true, mode: 0o700 });
        const temporary = join(this.home, `preferences.${crypto.randomUUID()}.tmp`);
        await writeFile(
            temporary,
            `${JSON.stringify({ version: 1, noticeShown: true }, null, 2)}\n`,
            { mode: 0o600 }
        );
        await rename(temporary, this.preferencesPath());
    }

    private preferencesPath(): string {
        return join(this.home, 'preferences.json');
    }
}
