import type { RegistryAccountStore } from '../registry/account-store.js';
import { RegistryClient } from '../registry/client.js';
import type { CloudClient } from './client.js';

export interface CloudLibraryEntry {
    id: string;
    reference: string;
    kind: 'own' | 'saved';
    available: boolean;
    reason: string | null;
    version: string | null;
    sandboxed: boolean;
}

/** The connected organization's own Workbenches and public saved references. */
export class CloudLibrary {
    constructor(
        private readonly client: Pick<CloudClient, 'request'>,
        private readonly accounts: RegistryAccountStore
    ) {}

    async list(): Promise<CloudLibraryEntry[]> {
        const account = await this.accounts.current();
        if (!account)
            throw new Error('Cloud commands require wb login for an organization');
        const value = await this.client.request('/v1/workbenches');
        if (!RegistryClient.isRecord(value) || !Array.isArray(value.workbenches))
            throw new Error('The cloud API returned a malformed Workbench list');
        const own: CloudLibraryEntry[] = [];
        for (const workbench of value.workbenches) {
            if (
                !RegistryClient.isRecord(workbench) ||
                !RegistryClient.isRecord(workbench.publisher) ||
                typeof workbench.publisher.slug !== 'string'
            )
                throw new Error('The cloud API returned a malformed Workbench');
            if (workbench.publisher.slug !== account.slug) continue;
            if (
                typeof workbench.workbench_id !== 'string' ||
                typeof workbench.slug !== 'string' ||
                !RegistryClient.isRecord(workbench.latest_version) ||
                typeof workbench.latest_version.version !== 'string' ||
                typeof workbench.sandboxed !== 'boolean'
            )
                throw new Error('The cloud API returned a malformed Workbench');
            own.push({
                id: workbench.workbench_id,
                reference: `${workbench.publisher.slug}/${workbench.slug}`,
                kind: 'own',
                available: true,
                reason: null,
                version: workbench.latest_version.version,
                sandboxed: workbench.sandboxed,
            });
        }
        return [...own, ...(await this.saves())];
    }

    async save(reference: string): Promise<CloudLibraryEntry> {
        const parsed = RegistryClient.parseReference(reference);
        if (!parsed) throw new Error('Cloud saves require a public org/name reference');
        const value = await this.client.request('/v1/resolutions', {
            method: 'POST',
            body: { publisher: parsed.publisher, workbench: parsed.workbench },
        });
        if (!RegistryClient.isRecord(value) || typeof value.workbench_id !== 'string')
            throw new Error('The cloud API returned a malformed Workbench resolution');
        return parseSave(
            await this.client.request('/v1/saves', {
                method: 'POST',
                body: { workbench_id: value.workbench_id },
            })
        );
    }

    async unsave(reference: string): Promise<void> {
        const id = RegistryClient.parseReference(reference)
            ? (await this.saves()).find((save) => save.reference === reference)?.id
            : reference;
        if (!id) throw new Error(`Workbench is not saved: ${reference}`);
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
            throw new Error('Cloud unsave requires org/name or a save ID');
        const value = await this.client.request(`/v1/saves/${id}`, {
            method: 'DELETE',
        });
        if (!RegistryClient.isRecord(value) || value.deleted !== true)
            throw new Error('The cloud API returned a malformed save deletion');
    }

    private async saves(): Promise<CloudLibraryEntry[]> {
        const value = await this.client.request('/v1/saves');
        if (!RegistryClient.isRecord(value) || !Array.isArray(value.saves))
            throw new Error('The cloud API returned a malformed save list');
        return value.saves.map(parseSave);
    }
}

function parseSave(value: unknown): CloudLibraryEntry {
    if (
        !RegistryClient.isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.reference !== 'string' ||
        typeof value.available !== 'boolean' ||
        (value.reason !== null && typeof value.reason !== 'string') ||
        (value.version !== null && typeof value.version !== 'string') ||
        typeof value.sandboxed !== 'boolean'
    )
        throw new Error('The cloud API returned a malformed save');
    return {
        id: value.id,
        reference: value.reference,
        kind: 'saved',
        available: value.available,
        reason: value.reason,
        version: value.version,
        sandboxed: value.sandboxed,
    };
}
