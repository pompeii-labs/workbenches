import type { PreparedRuntime } from '../../runtimes/contracts.js';
import type { PreparedRunner, RunnerAuthentication } from '../runner.js';
import {
    CLAUDE_CODE_PACKAGE_VERSION,
    CLAUDE_CODE_PROVIDER_CAPABILITIES,
} from './providers.js';

export const CLAUDE_CODE_AUTHENTICATION = {
    environmentNames: [],
    providerCapabilities: (catalog) => ({
        ...CLAUDE_CODE_PROVIDER_CAPABILITIES,
        ...catalog.harnesses?.['claude-code']?.versions[CLAUDE_CODE_PACKAGE_VERSION]
            ?.providers,
    }),
    allowEnvironment: (name, _runtime) => {
        if (name === 'ANTHROPIC_API_KEY') return true;
        return !name.startsWith('CLAUDE') && !name.startsWith('ANTHROPIC_');
    },
    nativeCredentialStore: (runtime) => runtime === 'docker',
    inRunAuthentication: false,
    credentialFormat: 'provider',
    supportsNativeAuthentication: (runtime, provider, method) =>
        provider === 'anthropic' &&
        (method === 'oauth' || method === 'api') &&
        (runtime === 'local' || runtime === 'docker'),
    localAdvice: () => 'Run claude auth login',
    loginArguments: (_provider, method) => [
        'claude',
        'auth',
        'login',
        method === 'api' ? '--console' : '--claudeai',
    ],
    invocationEnvironment: (runtime, environment) => ({
        ...environment,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ...(runtime === 'local'
            ? {
                  CLAUDE_CONFIG_DIR: undefined,
                  CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
              }
            : {
                  CLAUDE_CONFIG_DIR: environment.CLAUDE_SECURESTORAGE_CONFIG_DIR,
              }),
    }),
    hostEnvironment: (runtime, environment) => ({
        ...environment,
        ...(runtime === 'local' ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } : {}),
    }),
    credentialEnvironment: (root) => ({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: `${root}/claude-auth`,
    }),
    subprocessEnvironmentScrubbing: {
        macos: true,
        linuxProbe: ['bwrap', '--ro-bind', '/', '/', 'true'],
    },
    runnerConfigShape: 'file',
} satisfies RunnerAuthentication;

export async function inspectClaudeCodeAuthentication(
    runtime: PreparedRuntime,
    runner: PreparedRunner
): Promise<{ loggedIn: boolean; authenticationMethod?: 'api' | 'oauth' }> {
    if (runtime.name !== 'local' && runtime.name !== 'docker') {
        return { loggedIn: false };
    }
    const environment = CLAUDE_CODE_AUTHENTICATION.invocationEnvironment(
        runtime.name,
        runtime.environment
    );
    const result = await runtime.execute(
        {
            ...runner.native(runtime, ['claude', 'auth', 'status', '--json']),
            env: environment,
        },
        { network: 'none', readOnly: true }
    );
    if (result.code !== 0) return { loggedIn: false };
    let value: unknown;
    try {
        value = JSON.parse(result.stdout);
    } catch {
        return { loggedIn: false };
    }
    if (!isRecord(value) || value.loggedIn !== true) return { loggedIn: false };
    const authMethod = typeof value.authMethod === 'string' ? value.authMethod : '';
    const subscriptionType =
        typeof value.subscriptionType === 'string' ? value.subscriptionType : '';
    return {
        loggedIn: true,
        authenticationMethod:
            subscriptionType || !authMethod.toLowerCase().includes('api')
                ? 'oauth'
                : 'api',
    };
}

export interface ClaudeCodeCredentials {
    apiKey?: string;
}

export function claudeCodeCredentials(
    environment: Record<string, string | undefined>
): ClaudeCodeCredentials {
    const apiKey = environment.ANTHROPIC_API_KEY;
    return {
        ...(apiKey?.trim() ? { apiKey } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
