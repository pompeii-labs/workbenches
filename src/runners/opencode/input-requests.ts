import type {
    RunnerPermissionDecision,
    RunnerQuestionPrompt,
    RunnerSessionHost,
} from '../session.js';
import type { OpenCodeChildren } from './children.js';
import { isOutboxPermission } from './outbox.js';
import { OpenCodeQuestion } from './question.js';
import type { OpenCodeServer } from './server.js';
import type { ActiveTurn } from './turn.js';
import { string, stringArray } from './values.js';

interface AlwaysPermission {
    sessionId: string;
    action: string;
    resources: Set<string>;
}

export interface InputRequestContext {
    server: OpenCodeServer;
    host: RunnerSessionHost;
    children: OpenCodeChildren;
    environment: Record<string, string | undefined>;
    /** Settles when the session closes, so a pending request stops waiting. */
    closing: Promise<void>;
    active(): ActiveTurn | undefined;
    closed(): boolean;
}

/**
 * Answers the permission and question requests a running turn raises. Each is
 * put to the host, and the host's answer is sent back to OpenCode. A request
 * stops waiting when the turn settles or the session closes. A permission the
 * host allowed "always" is remembered for the rest of the session.
 */
export class OpenCodeInputRequests {
    private readonly always: AlwaysPermission[] = [];
    private readonly questions = new OpenCodeQuestion();

    constructor(private readonly context: InputRequestContext) {}

    async permission(properties: Record<string, unknown>): Promise<void> {
        const { host, closing } = this.context;
        const active = this.context.active();
        const id = string(properties.id);
        const action = string(properties.permission);
        const sessionId = string(properties.sessionID);
        if (
            !active ||
            !id ||
            !action ||
            !sessionId ||
            !(await this.context.children.owns(sessionId)) ||
            this.context.active() !== active ||
            active.settled
        )
            return;
        const resources = stringArray(properties.patterns);
        if (
            isOutboxPermission(
                action,
                resources,
                this.context.environment.WORKBENCH_OUTPUT_DIR
            )
        ) {
            await this.reply(id, 'allow_once');
            return;
        }
        if (this.isAlwaysAllowed(sessionId, action, resources)) return;
        const always = stringArray(properties.always);
        const decision = await Promise.race([
            host.requestPermission({
                id,
                action,
                resources,
                message: permissionMessage(action, resources),
                allowAlways: always.length > 0,
            }),
            closing.then(() => undefined),
            active.promise.then(
                () => undefined,
                () => undefined
            ),
        ]);
        if (!decision || this.context.closed()) return;
        const replied = await this.reply(id, decision);
        if (replied && decision === 'allow_always') {
            this.always.push({
                sessionId,
                action,
                resources: new Set(always.length > 0 ? always : resources),
            });
        }
    }

    async question(properties: Record<string, unknown>): Promise<void> {
        const { host, server, closing } = this.context;
        const active = this.context.active();
        const id = string(properties.id);
        const sessionId = string(properties.sessionID);
        if (
            !active ||
            !id ||
            !sessionId ||
            !(await this.context.children.owns(sessionId)) ||
            this.context.active() !== active ||
            active.settled
        )
            return;
        let questions: RunnerQuestionPrompt[];
        try {
            questions = this.questions.fromNative(properties.questions);
        } catch (error) {
            await server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        const response = await Promise.race([
            host.requestQuestion({ id, questions }),
            closing.then(() => undefined),
            active.promise.then(
                () => undefined,
                () => undefined
            ),
        ]);
        if (!response || this.context.closed()) return;
        if (response.outcome === 'rejected') {
            await server.replyQuestion(`/question/${encodeURIComponent(id)}/reject`);
            return;
        }
        let answers: string[][];
        try {
            answers = this.questions.answers(questions, response);
        } catch (error) {
            await server
                .replyQuestion(`/question/${encodeURIComponent(id)}/reject`)
                .catch(() => false);
            throw error;
        }
        await server.replyQuestion(`/question/${encodeURIComponent(id)}/reply`, {
            answers,
        });
    }

    private reply(id: string, decision: RunnerPermissionDecision): Promise<boolean> {
        return this.context.server.replyPermission(
            `/permission/${encodeURIComponent(id)}/reply`,
            { reply: permissionReply(decision) }
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
