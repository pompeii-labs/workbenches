import type {
    AuthoringOperation,
    AuthoringOperationResult,
} from '../authoring/index.js';
import type { RepositoryInspection } from '../repositories/index.js';
import type { RunHandle } from '../runs/index.js';
import type { StoredSession } from '../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';

export interface PreparedWorkbenchChat {
    alias: string;
    resolved: ResolvedWorkbenchReference;
    prompt?: string;
    operation?: AuthoringOperation;
    environment?: Record<string, string | undefined>;
}

export interface ChatScreenProps {
    home: string;
    alias: string;
    resolved: ResolvedWorkbenchReference;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        session?: StoredSession;
        environment?: Record<string, string | undefined>;
        authoring?: boolean;
        connection?: string;
    }) => Promise<RunHandle>;
    session?: StoredSession;
    initialPrompt?: string;
    operation?: AuthoringOperation;
    environment?: Record<string, string | undefined>;
    connection?: string;
    prepareImprovement?: (
        sessionId: string,
        feedback: string
    ) => Promise<PreparedWorkbenchChat>;
    onAuthoring?: (launch: PreparedWorkbenchChat) => void;
    onAuthoringFinished?: (result: AuthoringOperationResult) => void;
    onSessionObserved?: (id: string | undefined) => void;
    onSessionUpdated?: (session: StoredSession) => void;
    onBack: () => void;
    onBrowseSessions: () => void;
    onExit: () => void;
    homeAvailable: boolean;
    repositoryInspection?: (id: string) => RepositoryInspection;
}
