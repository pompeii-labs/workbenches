import type { RuntimeCredentialFiles } from '../../runtimes/contracts.js';
import { record, string } from './json.js';
import type { OpenCodeServer } from './server.js';

/** Bridges only Workbench-owned remote credentials, never the person's host store. */
export class OpenCodeV2Credentials {
    constructor(
        private readonly server: Pick<OpenCodeServer, 'requestJson' | 'request'>,
        private readonly files: RuntimeCredentialFiles
    ) {}

    private async portable(): Promise<Record<string, unknown>> {
        const text = await this.files.read('opencode/auth.json');
        if (!text) return {};
        const document = record(JSON.parse(text));
        if (!document) throw new Error('Invalid Workbench OpenCode credential store');
        return document;
    }

    async load(): Promise<void> {
        const document = await this.portable();
        const existing = await this.server.requestJson('/credential', {
            method: 'GET',
        });
        const entries = Array.isArray(existing) ? existing.map(record) : [];
        for (const [integrationID, raw] of Object.entries(document)) {
            const entry = record(raw);
            if (!entry) continue;
            const value =
                entry.type === 'api'
                    ? { type: 'key', key: entry.key }
                    : entry.type === 'oauth'
                      ? {
                            type: 'oauth',
                            methodID:
                                entry.methodID ??
                                (integrationID === 'openai'
                                    ? 'chatgpt-browser'
                                    : 'oauth'),
                            refresh: entry.refresh,
                            access: entry.access,
                            expires: entry.expires,
                            metadata: {
                                ...record(entry.metadata),
                                ...(entry.accountId
                                    ? { accountID: entry.accountId }
                                    : {}),
                            },
                        }
                      : undefined;
            if (!value) continue;
            const current = entries.find(
                (candidate) =>
                    candidate?.integrationID === integrationID && candidate.active
            );
            await this.server.request(
                current
                    ? `/credential/${encodeURIComponent(String(current.id))}`
                    : '/credential',
                {
                    method: current ? 'PATCH' : 'POST',
                    body: JSON.stringify(
                        current ? { value } : { integrationID, value }
                    ),
                }
            );
        }
    }

    async save(): Promise<void> {
        const document = await this.portable();
        const existing = await this.server.requestJson('/credential', {
            method: 'GET',
        });
        for (const raw of Array.isArray(existing) ? existing : []) {
            const entry = record(raw);
            const value = record(entry?.value);
            const provider = string(entry?.integrationID);
            if (!provider || !entry?.active || !value) continue;
            if (value.type === 'key')
                document[provider] = { type: 'api', key: value.key };
            else if (value.type === 'oauth') document[provider] = value;
        }
        await this.files.write(
            'opencode/auth.json',
            `${JSON.stringify(document, null, 2)}\n`
        );
    }
}
