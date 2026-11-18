import type { PreparedRuntime } from '../../runtimes/contracts.js';
import { quote } from '../../runtimes/staging/shell.js';

type CredentialTarget = Pick<
    PreparedRuntime,
    'name' | 'environment' | 'credentials' | 'execute' | 'workspaceDirectory'
>;

/**
 * API keys saved as an `env` object in the runner store, which Claude Code never
 * loads: the adapter reads them and passes them as provider variables, separate
 * from subscription sign-ins.
 */
export const claudeCodeCredentials = {
    file: 'claude-code/settings.json',
    apiKeyEntryType: 'api_key',
    storeFirst: false,
    providerVariables: {
        anthropic: 'ANTHROPIC_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        vercel: 'AI_GATEWAY_API_KEY',
    },
    environment: (root: string) => ({ WORKBENCH_CREDENTIALS_DIR: root }),
};

/** Keeps settings keys private to a prepared runner, with inherited variables taking precedence. */
export class ClaudeCodeCredentialSettings {
    private readonly stored = new WeakMap<object, Record<string, string>>();

    async load(runtime: CredentialTarget): Promise<Record<string, string | undefined>> {
        this.stored.set(runtime, await storedClaudeCodeEnvironment(runtime));
        return this.environment(runtime);
    }

    environment(
        target: Pick<PreparedRuntime, 'environment'>
    ): Record<string, string | undefined> {
        const environment = { ...target.environment };
        for (const [name, key] of Object.entries(this.stored.get(target) ?? {})) {
            if (!environment[name]?.trim()) environment[name] = key;
        }
        return environment;
    }
}

/** Reads only the engine-owned settings file, never Claude Code's subscription storage. */
export async function storedClaudeCodeEnvironment(
    runtime: CredentialTarget
): Promise<Record<string, string>> {
    if (runtime.name === 'local') return {};
    const root = runtime.environment.WORKBENCH_CREDENTIALS_DIR;
    if (!root) return {};
    let source: string | undefined;
    if (runtime.credentials) {
        source = await runtime.credentials.read(claudeCodeCredentials.file);
    } else {
        const path = quote(`${root}/${claudeCodeCredentials.file}`);
        const result = await runtime.execute(
            {
                command: ['/bin/sh', '-c', `if [ -f ${path} ]; then cat ${path}; fi`],
                cwd: runtime.workspaceDirectory,
                env: {},
            },
            { network: 'none', readOnly: true }
        );
        if (result.code !== 0)
            throw new Error('Claude Code settings credentials could not be read');
        source = result.stdout;
    }
    if (!source?.trim()) return {};
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new Error('Claude Code settings credentials are not valid JSON');
    }
    if (!record(value) || (value.env !== undefined && !record(value.env))) {
        throw new Error('Claude Code settings credentials must contain an env object');
    }
    const environment = record(value.env) ? value.env : {};
    return Object.fromEntries(
        Object.values(claudeCodeCredentials.providerVariables).flatMap((name) => {
            const key = environment[name];
            return typeof key === 'string' && key.trim() ? [[name, key]] : [];
        })
    );
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
