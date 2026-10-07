import type { ModelCatalogHarnessProviderRoute } from '../../models/index.js';

export const CLAUDE_CODE_PACKAGE_VERSION = '2.1.292';

export const CLAUDE_CODE_PROVIDER_CAPABILITIES: Record<
    string,
    ModelCatalogHarnessProviderRoute[]
> = {
    // https://docs.anthropic.com/en/docs/claude-code/third-party-integrations
    anthropic: [{ native_provider: 'anthropic', auth: ['api', 'oauth'] }],
    // https://openrouter.ai/docs/guides/guides/claude-code-integration
    openrouter: [{ native_provider: 'openrouter', auth: ['api'] }],
    // https://vercel.com/docs/ai-gateway/coding-agents/claude-code
    vercel: [{ native_provider: 'vercel', auth: ['api'] }],
};

export function claudeCodeRouteEnvironment(
    provider: string,
    environment: Record<string, string | undefined>,
    providerEnvironment: Record<string, string[]>
): Record<string, string | undefined> {
    if (provider === 'anthropic') {
        return Object.fromEntries(
            Object.entries(environment).filter(
                ([name]) =>
                    name !== 'ANTHROPIC_BASE_URL' && name !== 'ANTHROPIC_AUTH_TOKEN'
            )
        );
    }
    const mapping = providerMapping(provider, providerEnvironment[provider]?.[0]);
    if (!mapping) return environment;
    const credential = environment[mapping.variable];
    return {
        ...Object.fromEntries(
            Object.entries(environment).filter(([name]) => name !== mapping.variable)
        ),
        ANTHROPIC_BASE_URL: mapping.baseUrl,
        ANTHROPIC_AUTH_TOKEN: credential,
        ANTHROPIC_API_KEY: '',
    };
}

function providerMapping(
    provider: string,
    variable: string | undefined
): { variable: string; baseUrl: string } | undefined {
    if (provider === 'openrouter' && variable) {
        // https://openrouter.ai/docs/guides/guides/claude-code-integration
        return { variable, baseUrl: 'https://openrouter.ai/api' };
    }
    if (provider === 'vercel' && variable) {
        // https://vercel.com/docs/ai-gateway/coding-agents/claude-code
        return {
            variable,
            baseUrl: 'https://ai-gateway.vercel.sh/claude-code',
        };
    }
    return undefined;
}
