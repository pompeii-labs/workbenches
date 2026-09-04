import { RunStore } from '../runs/store.js';
import type { ResolvedWorkbenchReference } from '../workbench/resolver.js';
import { Workbench } from '../workbench/workbench.js';
import { SessionStore, type StoredSession } from './store.js';

export interface ResolvedSession {
    alias: string;
    session: StoredSession;
    resolved: ResolvedWorkbenchReference;
}

export class SessionResolver {
    readonly #runs: RunStore;
    readonly #sessions: SessionStore;

    constructor(home: string) {
        this.#runs = new RunStore(home);
        this.#sessions = new SessionStore(home);
    }

    async resolve(id: string): Promise<ResolvedSession> {
        const session = await this.find(id);
        if (!session.native_session_id) {
            throw new Error(
                `Session ${session.id} never reached a resumable runner state`
            );
        }
        const workbench = await Workbench.load(session.workbench_path);
        if (
            workbench.manifest.name !== session.workbench ||
            workbench.manifest.version !== session.workbench_version ||
            workbench.manifest.runner !== session.runner
        ) {
            throw new Error(
                `Session ${session.id} no longer matches its Workbench package`
            );
        }
        return {
            alias: session.reference,
            session,
            resolved: {
                workbench,
                workspaceDirectory: session.workspace,
                cleanup: async () => {},
                ...(session.registry ? { registry: session.registry } : {}),
            },
        };
    }

    private async find(id: string): Promise<StoredSession> {
        try {
            return await this.#sessions.read(id);
        } catch (error) {
            const run = await this.#runs.read(id).catch(() => undefined);
            if (!run) throw error;
            if (!run.session_id) {
                throw new Error(
                    `Run ${id} predates resumable Workbench sessions and cannot be resumed`
                );
            }
            return this.#sessions.read(run.session_id);
        }
    }
}
