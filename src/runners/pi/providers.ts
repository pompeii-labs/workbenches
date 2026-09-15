import type { ModelCatalogHarnessProviderRoute } from '../../models/catalog.js';
import type { AuthenticatedModelRoute, ModelRoute } from '../../models/index.js';

export const PI_PACKAGE_VERSION = '0.84.3';

export const PI_PROVIDER_CAPABILITIES: Record<
    string,
    ModelCatalogHarnessProviderRoute[]
> = {
    'amazon-bedrock': [api('amazon-bedrock')],
    anthropic: [native('anthropic', ['api', 'oauth'])],
    baseten: [api('baseten')],
    cerebras: [api('cerebras')],
    'cloudflare-ai-gateway': [api('cloudflare-ai-gateway')],
    'cloudflare-workers-ai': [api('cloudflare-workers-ai')],
    deepseek: [api('deepseek')],
    'fireworks-ai': [api('fireworks')],
    'github-copilot': [native('github-copilot', ['api', 'oauth'])],
    google: [api('google')],
    'google-vertex': [api('google-vertex')],
    groq: [api('groq')],
    huggingface: [api('huggingface')],
    'kimi-for-coding': [native('kimi-coding', ['api', 'oauth'])],
    minimax: [api('minimax')],
    'minimax-cn': [api('minimax-cn')],
    mistral: [api('mistral')],
    moonshotai: [api('moonshotai')],
    'moonshotai-cn': [api('moonshotai-cn')],
    nvidia: [api('nvidia')],
    openai: [api('openai'), native('openai-codex', ['oauth'])],
    opencode: [api('opencode')],
    'opencode-go': [api('opencode-go')],
    openrouter: [native('openrouter', ['api', 'oauth'])],
    togetherai: [api('together')],
    vercel: [api('vercel-ai-gateway')],
    xai: [native('xai', ['api', 'oauth'])],
    xiaomi: [api('xiaomi')],
    'xiaomi-token-plan-ams': [api('xiaomi-token-plan-ams')],
    'xiaomi-token-plan-cn': [api('xiaomi-token-plan-cn')],
    'xiaomi-token-plan-sgp': [api('xiaomi-token-plan-sgp')],
    zai: [api('zai')],
};

export function piRouteCandidates(
    route: ModelRoute,
    capabilities: Record<string, ModelCatalogHarnessProviderRoute[]>
): AuthenticatedModelRoute[] {
    return (capabilities[route.provider] ?? []).map((capability) => ({
        provider: route.provider,
        nativeProvider: capability.native_provider,
        nativeModel: route.model,
        ...(capability.auth.length === 1 && capability.auth[0]
            ? { authenticationMethod: capability.auth[0] }
            : {}),
    }));
}

function api(nativeProvider: string): ModelCatalogHarnessProviderRoute {
    return native(nativeProvider, ['api']);
}

function native(
    nativeProvider: string,
    authentication: ModelCatalogHarnessProviderRoute['auth']
): ModelCatalogHarnessProviderRoute {
    return { native_provider: nativeProvider, auth: authentication };
}
