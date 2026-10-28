import type { ClaudeCodeBilling } from './cost.js';

/** The variables, billing, and credential store of one selected model route. */
export interface ClaudeCodeRoute {
    /** What the route sets in the child. Every other Claude and Anthropic variable is dropped. */
    environment: Record<string, string>;
    billing: ClaudeCodeBilling;
    /** `CLAUDE_SECURESTORAGE_CONFIG_DIR`. Empty reads the person's own Claude Code login. */
    secureStorageDirectory: string;
}

/**
 * Where Claude Code keeps the person's login inside a credential root a host
 * named, as a worker does for a member's sign-in, their local runs, and their
 * docker runs alike.
 */
export function claudeCodeLoginDirectory(root: string): string {
    return `${root.replace(/\/+$/, '')}/claude`;
}

/**
 * The credential store holding the person's own login in a runtime: in the
 * sign-ins a host named there, else on the local runtime the host's default,
 * which is empty, else none.
 */
export function claudeCodeLogin(
    runtime: string,
    credentialRoot: string | undefined
): string | undefined {
    if (credentialRoot) return claudeCodeLoginDirectory(credentialRoot);
    return runtime === 'local' ? '' : undefined;
}

export interface ClaudeCodeRouteRequest {
    /** The catalog provider of the selected route. */
    provider: string;
    /** The runtime the route runs in. */
    runtime: string;
    /** Where a host named the person's sign-ins in that runtime, as a worker does for a member. */
    credentialRoot?: string | undefined;
    /** The runtime environment, filtered to the selected route. */
    environment: Record<string, string | undefined>;
    /** The variables the catalog names for the provider's key. */
    keys: string[];
    /** A `claude setup-token` subscription token from the host environment. */
    oauthToken?: string | undefined;
    /**
     * How `claude auth status` reported the login the route uses: `oauth` for a
     * subscription, `api` for a Console login billed by usage.
     */
    authenticationMethod?: string | undefined;
    /** The session's config directory, which holds no login. */
    configDirectory: string;
}

/**
 * Anthropic-compatible gateways Claude Code reaches through its base URL. The
 * provider key becomes the bearer token and `ANTHROPIC_API_KEY` stays empty,
 * because Claude Code would otherwise prefer it.
 */
const gateways: Record<string, string> = {
    // https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
    openrouter: 'https://openrouter.ai/api',
    // https://vercel.com/docs/ai-gateway/coding-agents/claude-code
    vercel: 'https://ai-gateway.vercel.sh/claude-code',
};

/**
 * The route policy. An Anthropic key is an API route. Without one, Anthropic
 * uses a `CLAUDE_CODE_OAUTH_TOKEN` from the person's own environment, a
 * subscription, on any runtime, or else the person's own login where the
 * runtime holds one: on the local runtime, or where a host named their
 * sign-ins. That login is a subscription only when `claude auth status`
 * reported `oauth`; a Console login, or one it did not report, is billed by
 * usage. A runtime without a login needs an API key or the token. Only the
 * Anthropic routes without a key read the person's login; every other route
 * points the credential store at the empty session config directory, so a
 * cached login can never reach a gateway.
 */
export function claudeCodeRoute(request: ClaudeCodeRouteRequest): ClaudeCodeRoute {
    const key = request.keys
        .map((name) => request.environment[name]?.trim())
        .find((value): value is string => Boolean(value));
    const isolated = request.configDirectory;
    const gateway = gateways[request.provider];
    if (gateway) {
        if (!key) {
            throw new Error(
                `Claude Code needs ${request.keys.join(' or ') || 'a key'} for the ${request.provider} route`
            );
        }
        return {
            environment: {
                ANTHROPIC_BASE_URL: gateway,
                ANTHROPIC_AUTH_TOKEN: key,
                ANTHROPIC_API_KEY: '',
            },
            billing: 'metered',
            secureStorageDirectory: isolated,
        };
    }
    if (request.provider !== 'anthropic') {
        throw new Error(`Claude Code cannot reach model provider ${request.provider}`);
    }
    if (key) {
        return {
            environment: { ANTHROPIC_API_KEY: key },
            billing: 'metered',
            secureStorageDirectory: isolated,
        };
    }
    const token = request.oauthToken?.trim();
    const login = claudeCodeLogin(request.runtime, request.credentialRoot);
    if (!token && login === undefined) {
        throw new Error(
            `Claude Code on the ${request.runtime} runtime needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN`
        );
    }
    return {
        environment: token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {},
        billing:
            token || request.authenticationMethod === 'oauth'
                ? 'subscription'
                : 'metered',
        secureStorageDirectory: login ?? isolated,
    };
}
