import type { ResolvedWorkbenchReference } from '../workbench/resolver.js';
import { Workbench } from '../workbench/workbench.js';
import { SessionLifecycle } from './lifecycle.js';
import type { StoredSession } from './store.js';

export interface ResolvedSession {
    alias: string;
    session: StoredSession;
    resolved: ResolvedWorkbenchReference;
}

export class SessionResolver {
    readonly #lifecycle: SessionLifecycle;

    constructor(home: string) {
        this.#lifecycle = new SessionLifecycle(home);
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
                source: session.source_workbench_path ? 'local' : 'saved',
                ...(session.registry ? { registry: session.registry } : {}),
            },
        };
    }

    private async find(id: string): Promise<StoredSession> {
        const session = await this.#lifecycle.session(id);
        if (session) return session;
        const activity = await this.#lifecycle.resolve(id);
        throw new Error(
            `Session ${activity.id} predates resumable Workbench sessions and cannot be resumed`
        );
    }
}
