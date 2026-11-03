import type {
    ConnectionAuthenticationMethod,
    ConnectionRuntime,
} from '../../connections/contracts.js';
import type { AuthenticatedModelRoute, ModelRoute } from '../../models/index.js';
import { withoutClaudeVariables } from '../claude-code/invocation.js';
import { claudeCodeLogin } from '../claude-code/routes.js';
import { record, string } from './json.js';
import type { OpenCodeServer } from './server.js';

/**
 * OpenCode's built-in Claude Agent provider runs Claude models through the
 * Claude Agent SDK on the person's own Claude Code login. OpenCode never sees
 * a token: Claude Code keeps its login, and Workbench only points OpenCode at
 * where Claude Code finds it. OpenCode 1 has no such provider.
 */
export const CLAUDE_AGENT_PROVIDER = 'claude-agent';
/** OpenCode's integration method, which records that the person chose Claude Code. */
const CLAUDE_AGENT_METHOD = 'claude-login';
/** The first OpenCode release with the Claude Agent provider. */
const CLAUDE_AGENT_VERSION = '2.2.3';
/** Runtimes where a run reaches a Claude Code login without copying it. */
const CLAUDE_AGENT_RUNTIMES: readonly string[] = ['local', 'docker'];

/** The Claude subscription method for Anthropic, as OpenCode offers it on `runtime`. */
export function claudeAgentMethod(
    runtime: ConnectionRuntime
): ConnectionAuthenticationMethod {
    const unavailable = claudeAgentUnavailable(runtime);
    return {
        id: 'claude-subscription',
        label: 'Claude subscription through Claude Code (OpenCode 2.2.3 or newer, experimental)',
        nativeProvider: CLAUDE_AGENT_PROVIDER,
        nativeMethod: CLAUDE_AGENT_METHOD,
        authenticationMethod: 'oauth',
        signInRunner: 'claude-code',
        ...(unavailable ? { unavailable } : {}),
    };
}

/** Why `runtime` cannot run the Claude Agent route, or undefined when it can. */
export function claudeAgentUnavailable(runtime: string): string | undefined {
    if (CLAUDE_AGENT_RUNTIMES.includes(runtime)) return undefined;
    return `A Claude subscription through OpenCode runs only on the local and docker runtimes: ${runtime} has no Claude Code login to use. Use an Anthropic API key there instead`;
}

/** The route through Claude Agent for an Anthropic model, pinned to its exact id. */
export function claudeAgentCandidate(route: ModelRoute): AuthenticatedModelRoute {
    return {
        provider: route.provider,
        nativeProvider: CLAUDE_AGENT_PROVIDER,
        nativeModel: route.model,
        authenticationMethod: 'oauth',
    };
}

/**
 * The config that pins a Claude Agent model. Claude Agent lists only the
 * models Claude Code's picker shows, the newest under floating aliases, so a
 * configured model with the exact id is what reaches the Agent SDK.
 */
export function claudeAgentProviders(
    model: string
): Record<string, unknown> | undefined {
    const prefix = `${CLAUDE_AGENT_PROVIDER}/`;
    if (!model.startsWith(prefix)) return undefined;
    return {
        [CLAUDE_AGENT_PROVIDER]: { models: { [model.slice(prefix.length)]: {} } },
    };
}

/**
 * The environment OpenCode passes to Claude Code on the Claude Agent route:
 * no inherited Claude or Anthropic variable, so neither a key nor a gateway
 * bills the run, then the login the `claude-code` runner uses in this runtime,
 * and a `CLAUDE_CODE_OAUTH_TOKEN` from the person's own environment.
 */
export function claudeAgentEnvironment(
    environment: Record<string, string | undefined>,
    runtime: { name: string; credentialRoot?: string | undefined },
    token: string | undefined
): Record<string, string | undefined> {
    const login = claudeCodeLogin(runtime.name, runtime.credentialRoot);
    const value = token?.trim();
    return {
        ...withoutClaudeVariables(environment),
        ...(login ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: login } : {}),
        ...(value ? { CLAUDE_CODE_OAUTH_TOKEN: value } : {}),
    };
}

/**
 * Readies a started server for the Claude Agent route before any prompt:
 * refuses a release without the provider, then records the person's choice
 * of Claude Code the way OpenCode's own `/connect` does, unless it already is.
 */
export class OpenCodeClaudeAgent {
    constructor(
        private readonly server: Pick<
            OpenCodeServer,
            'isV2' | 'version' | 'requestJson' | 'request'
        >
    ) {}

    async prepare(): Promise<void> {
        const version = this.server.isV2 ? this.server.version : undefined;
        if (!version || Bun.semver.order(version, CLAUDE_AGENT_VERSION) < 0) {
            throw new Error(
                `A Claude subscription through OpenCode needs OpenCode ${CLAUDE_AGENT_VERSION} or newer (npm @opencode/cli, experimental), but this runtime has OpenCode ${version ?? '1'}. Use an Anthropic API key, or install OpenCode ${CLAUDE_AGENT_VERSION} or newer`
            );
        }
        const integrations = await this.server.requestJson('/integration', {
            method: 'GET',
        });
        const integration = (Array.isArray(integrations) ? integrations : [])
            .map(record)
            .find((value) => string(value?.id) === CLAUDE_AGENT_PROVIDER);
        if (!integration) {
            throw new Error(
                `OpenCode ${version} did not expose its Claude Agent provider. It skips the provider where it cannot start a local claude process`
            );
        }
        if (Array.isArray(integration.connections) && integration.connections.length)
            return;
        await this.server.request(
            `/integration/${CLAUDE_AGENT_PROVIDER}/connect/external`,
            {
                method: 'POST',
                body: JSON.stringify({ methodID: CLAUDE_AGENT_METHOD }),
            }
        );
    }
}
