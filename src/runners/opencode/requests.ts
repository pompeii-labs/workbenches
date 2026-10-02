import type {
    RunnerPermissionDecision,
    RunnerQuestionPrompt,
    RunnerSessionHost,
} from '../session.js';
import type { OpenCodeChildren } from './children.js';
import { string, stringArray } from './json.js';
import { isOutboxPermission } from './outbox.js';
import { OpenCodeQuestion } from './question.js';
import type { OpenCodeServer } from './server.js';
import type { OpenCodeSessionState } from './state.js';
import type { ActiveTurn } from './turn.js';

interface AlwaysPermission {
    sessionId: string;
    action: string;
    resources: Set<string>;
}

/**
 * Answers the permission and question requests a running turn raises. Each is
 * put to the host, and the host's answer is sent back to OpenCode. A request
 * stops waiting when the turn settles, which a closing session does too. A
 * permission the host allowed "always" is remembered for the rest of the session.
 */
export class OpenCodeInputRequests {
    private readonly always: AlwaysPermission[] = [];
    private readonly questions = new OpenCodeQuestion();

    constructor(
        private readonly server: Pick<
            OpenCodeServer,
            'replyPermission' | 'replyQuestion'
        >,
        private readonly host: Pick<
            RunnerSessionHost,
            'requestPermission' | 'requestQuestion'
        >,
        private readonly children: Pick<OpenCodeChildren, 'owns'>,
        private readonly environment: Record<string, string | undefined>,
        private readonly state: Pick<OpenCodeSessionState, 'active'>
    ) {}

    /** Whether the turn has settled or another turn has replaced it. */
    private stale(active: ActiveTurn): boolean {
        return active.settled || this.state.active !== active;
    }

    async permission(
        active: ActiveTurn,
        properties: Record<string, unknown>
    ): Promise<void> {
        const id = string(properties.id);
        const action = string(properties.permission);
        const sessionId = string(properties.sessionID);
        if (
            !id ||
            !action ||
            !sessionId ||
            !(await this.children.owns(sessionId)) ||
            this.stale(active)
        )
            return;
        const resources = stringArray(properties.patterns);
        if (
            isOutboxPermission(action, resources, this.environment.WORKBENCH_OUTPUT_DIR)
        ) {
            await this.reply(id, 'allow_once');
            return;
        }
        if (this.isAlwaysAllowed(sessionId, action, resources)) return;
        const always = stringArray(properties.always);
        const decision = await Promise.race([
            this.host.requestPermission({
                id,
                action,
                resources,
                message: permissionMessage(action, resources),
                allowAlways: always.length > 0,
            }),
            active.promise.then(
                () => undefined,
                () => undefined
            ),
        ]);
        if (!decision || this.stale(active)) return;
        const replied = await this.reply(id, decision);
        if (replied && decision === 'allow_always') {
            this.always.push({
                sessionId,
                action,
                resources: new Set(always.length > 0 ? always : resources),
            });
        }
    }

    async question(
        active: ActiveTurn,
        properties: Record<string, unknown>
    ): Promise<void> {
        const id = string(properties.id);
        const sessionId = string(properties.sessionID);
        if (
            !id ||
            !sessionId ||
            !(await this.children.owns(sessionId)) ||
            this.stale(active)
        )
            return;
        let questions: RunnerQuestionPrompt[];
        try {
            questions = this.questions.fromNative(properties.questions);
        } catch (error) {
            await this.server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        const response = await Promise.race([
            this.host.requestQuestion({ id, questions }),
            active.promise.then(
                () => undefined,
                () => undefined
            ),
        ]);
        if (!response || this.stale(active)) return;
        if (response.outcome === 'rejected') {
            await this.server.replyQuestion(
                `/question/${encodeURIComponent(id)}/reject`
            );
            return;
        }
        let answers: string[][];
        try {
            answers = this.questions.answers(questions, response);
        } catch (error) {
            await this.server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        await this.server.replyQuestion(`/question/${encodeURIComponent(id)}/reply`, {
            answers,
        });
    }

    private reply(id: string, decision: RunnerPermissionDecision): Promise<boolean> {
        return this.server.replyPermission(
            `/permission/${encodeURIComponent(id)}/reply`,
            {
                reply: permissionReply(decision),
            }
        );
    }

    private isAlwaysAllowed(
        sessionId: string,
        action: string,
        resources: string[]
    ): boolean {
        if (resources.length === 0) return false;
        return this.always.some(
            (permission) =>
                permission.sessionId === sessionId &&
                permission.action === action &&
                resources.every((resource) => permission.resources.has(resource))
        );
    }
}

function permissionReply(decision: RunnerPermissionDecision) {
    if (decision === 'allow_once') return 'once';
    if (decision === 'allow_always') return 'always';
    return 'reject';
}

function permissionMessage(action: string, resources: string[]) {
    const label = action.replaceAll('_', ' ');
    return resources.length
        ? `Allow ${label} for ${resources.join(', ')}?`
        : `Allow ${label}?`;
}
