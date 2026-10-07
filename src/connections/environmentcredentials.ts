import { ActiveModelCatalog } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRuntime, RuntimeCredentialFiles } from '../runtimes/contracts.js';
import { runtimeCredentialRoot } from '../runtimes/credentialpath.js';
import { NativeCredentialFile } from './nativecredentials.js';

const savedProviders = Symbol('savedProviders');

export function hasSavedProviderCredential(
    environment: Record<string, string | undefined>,
    provider: string
): boolean {
    const value = Reflect.get(environment, savedProviders);
    return Array.isArray(value) && value.includes(provider);
}

/** Loads an engine-stored API key into a host-prepared runtime environment. */
export async function withHostRunnerCredentials(
    _home: string,
    runtime: string,
    runner: string,
    environment: Record<string, string | undefined>
): Promise<Record<string, string | undefined>> {
    const authentication = RunnerRegistry.standard().authentication(runner);
    return authentication.hostEnvironment?.(runtime, environment) ?? environment;
}

/** Loads a key from a prepared runtime store, such as a Docker volume. */
export async function applyRuntimeCredentials(
    runtime: PreparedRuntime,
    runner: string
): Promise<void> {
    const authentication = RunnerRegistry.standard().authentication(runner);
    if (authentication.credentialFormat !== 'provider' || !runtime.credentials) return;
    Object.assign(
        runtime.environment,
        await withProviderKeys(
            runtime.credentials,
            runtime.environment,
            Object.keys(
                authentication.providerCapabilities(ActiveModelCatalog.current())
            )
        ),
        authentication.credentialEnvironment?.(runtimeCredentialRoot) ?? {}
    );
}

async function withProviderKeys(
    files: RuntimeCredentialFiles,
    environment: Record<string, string | undefined>,
    providers: string[]
): Promise<Record<string, string | undefined>> {
    const next = { ...environment };
    const store = NativeCredentialFile.for('claude-code');
    for (const provider of providers) {
        const variable = ActiveModelCatalog.current().providers[provider]?.env[0];
        if (!variable || next[variable]?.trim()) continue;
        const entry = await store.find(files, provider);
        const key = entry?.value.key;
        if (typeof key === 'string' && key.trim()) {
            next[variable] = key;
            const saved = Reflect.get(next, savedProviders);
            Reflect.set(next, savedProviders, [
                ...(Array.isArray(saved) ? saved : []),
                provider,
            ]);
        }
    }
    return next;
}
