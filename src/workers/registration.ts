import type { WorkerApi } from './api.js';
import { WorkerApiError } from './api.js';
import type { WorkerHome, WorkerRegistrationRecord } from './home.js';

/**
 * Registers this machine as a worker with the CLI's own login, stores the
 * worker key, and revokes it on removal. The member who registers owns the
 * worker.
 */
export class WorkerRegistration {
    constructor(
        private readonly home: WorkerHome,
        private readonly api: WorkerApi
    ) {}

    /**
     * The machine's registration, made now with `login` when there is none.
     * A registered machine keeps its name: a different one is refused.
     */
    async ensure(
        name: string | undefined,
        login: () => Promise<{ slug: string; token: string }>
    ): Promise<WorkerRegistrationRecord> {
        const existing = await this.home.readRegistration();
        if (existing) {
            if (name !== undefined && name !== existing.name)
                throw new Error(
                    `This machine is already the worker ${existing.name}. Run wb worker remove first.`
                );
            return existing;
        }
        if (!name)
            throw new Error(
                'This machine is not registered as a worker. Name it with wb worker start --name <name>'
            );
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63)
            throw new Error(
                'Worker name must be lowercase letters, digits, and single hyphens'
            );
        const account = await login();
        const worker = await this.api.register(account.token, name);
        const record: WorkerRegistrationRecord = {
            version: 1,
            id: worker.id,
            slug: worker.slug,
            name,
            organization: account.slug,
            key: worker.key,
            api_url: this.api.apiUrl,
            registered_at: new Date().toISOString(),
        };
        await this.home.saveRegistration(record);
        return record;
    }

    /** Revokes the key with the API, then forgets it. An already revoked key is forgotten too. */
    async remove(): Promise<WorkerRegistrationRecord> {
        const registration = await this.home.requireRegistration();
        try {
            await this.api.revoke(registration.key);
        } catch (error) {
            if (
                !(error instanceof WorkerApiError) ||
                (error.status !== 401 && error.status !== 404)
            )
                throw error;
        }
        await this.home.removeRegistration();
        return registration;
    }
}
