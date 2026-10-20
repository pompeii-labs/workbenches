import { RuntimeError } from '../error.js';
import { quote } from '../staging/shell.js';
import type { DaytonaClient, DaytonaClock, DaytonaSandbox } from './contracts.js';

/** A sandbox that cannot be deleted is retried this many times, then reported. */
const maximumDeleteAttempts = 4;
const firstDeleteRetryDelayMs = 1_000;

/** A client that can stop a sandbox and set the lifetimes that keep it. */
type KeepingClient = DaytonaClient &
    Required<
        Pick<DaytonaClient, 'stopSandbox' | 'setAutoDeleteInterval' | 'setSandboxTtl'>
    >;

/**
 * Owns how a Daytona sandbox ends: deleted, kept stopped for a later run, or
 * left running for a while after its run so its previews stay reachable.
 * Every failure names the sandbox so it can be deleted by hand.
 */
export class SandboxLifetime {
    constructor(
        private readonly client: DaytonaClient,
        private readonly clock: Pick<DaytonaClock, 'sleep'>
    ) {}

    /** True when the client can stop a sandbox and change its lifetime. */
    get keeps(): boolean {
        return canKeep(this.client);
    }

    /** True when the client can set a running sandbox's deadline. */
    get lingers(): boolean {
        return Boolean(this.client.setSandboxTtl);
    }

    /**
     * Deletes sandbox `id`, waiting longer between each of a few attempts. The
     * error after the last attempt names the sandbox.
     */
    async delete(id: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.client.deleteSandbox(id);
                return;
            } catch (error) {
                if (attempt >= maximumDeleteAttempts) {
                    throw new RuntimeError(
                        'daytona',
                        'cleanup',
                        `Daytona sandbox ${id} was not deleted after ${attempt} attempts: ${message(error)}. Delete it with the Daytona dashboard or API.`,
                        { cause: error }
                    );
                }
                await this.clock.sleep(firstDeleteRetryDelayMs * 2 ** (attempt - 1));
            }
        }
    }

    /**
     * Stops sandbox `id` and lets Daytona delete it after `minutes` stopped.
     * Daytona archives a stopped sandbox after seven days by default, so the
     * archive deadline is set one minute past the delete deadline: the sandbox
     * is deleted before it can be archived.
     */
    async keep(id: string, minutes: number): Promise<void> {
        const client = this.client;
        if (!canKeep(client)) {
            throw new RuntimeError(
                'daytona',
                'cleanup',
                'This Daytona client cannot stop sandboxes or change their lifetime, so the sandbox cannot be kept'
            );
        }
        try {
            await client.stopSandbox(id);
            await client.setAutoArchiveInterval?.(id, minutes + 1);
            await client.setAutoDeleteInterval(id, minutes);
            // Daytona's TTL destroys a sandbox in any state, so it is cleared last.
            await client.setSandboxTtl(id, 0);
        } catch (error) {
            throw new RuntimeError(
                'daytona',
                'cleanup',
                `Daytona sandbox ${id} was not suspended: ${message(error)}. Call cleanup to delete it.`,
                { cause: error }
            );
        }
    }

    /**
     * Leaves `sandbox` running for `minutes` from now. The credential files
     * mounted at `credentials` are removed first, and when that fails the
     * sandbox is deleted instead, so a lingering sandbox never holds them.
     */
    async linger(
        sandbox: Pick<DaytonaSandbox, 'id' | 'run'>,
        credentials: string | undefined,
        minutes: number
    ): Promise<void> {
        if (credentials) {
            const removed = await sandbox
                .run(
                    `rm -rf -- ${quote(credentials)} && test ! -e ${quote(credentials)}`
                )
                .catch(() => undefined);
            if (removed?.code !== 0) {
                await this.delete(sandbox.id);
                throw new RuntimeError(
                    'daytona',
                    'cleanup',
                    `The credential files in Daytona sandbox ${sandbox.id} could not be removed, so the sandbox was deleted instead of kept running`
                );
            }
        }
        await this.extend(sandbox.id, minutes);
    }

    /** Sets the deadline of lingering sandbox `id` to `minutes` from now. */
    async extend(id: string, minutes: number): Promise<void> {
        try {
            await this.client.setSandboxTtl?.(id, minutes);
        } catch (error) {
            throw new RuntimeError(
                'daytona',
                'cleanup',
                `Daytona sandbox ${id} was not kept running: ${message(error)}. Call cleanup to delete it.`,
                { cause: error }
            );
        }
    }

    /**
     * Puts a sandbox a runtime started back as it was kept: stopped, with no
     * lease. The lease is cleared only once the sandbox is stopped, and when
     * either step fails the lease still bounds the sandbox.
     */
    async restore(id: string): Promise<void> {
        await this.client
            .stopSandbox?.(id)
            .then(() => this.client.setSandboxTtl?.(id, 0))
            .catch(() => {});
    }
}

function canKeep(client: DaytonaClient): client is KeepingClient {
    return Boolean(
        client.stopSandbox && client.setAutoDeleteInterval && client.setSandboxTtl
    );
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
