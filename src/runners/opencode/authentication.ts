import type { RunnerConnectionSelection } from '../../connections/store.js';
import type { RunnerSessionHost } from '../session.js';
import type { OpenCodeServer } from './server.js';
import { record, string } from './values.js';

/**
 * Completes a headless OAuth sign-in for the provider a run uses. It asks the
 * server which methods it offers, starts the automatic one, reports the device
 * URL to the host, and waits for the server to finish.
 */
export async function authenticateOpenCode(
    server: OpenCodeServer,
    host: RunnerSessionHost,
    authentication: RunnerConnectionSelection
): Promise<void> {
    if (authentication.authenticationMethod !== 'oauth') {
        throw new Error(
            `OpenCode ${authentication.authenticationMethod ?? 'native'} authentication cannot be completed during a Workbench run yet`
        );
    }
    const methods = record(await server.authenticationMethods());
    const available = methods?.[authentication.nativeProvider];
    if (!Array.isArray(available)) {
        throw new Error(
            `OpenCode did not expose authentication methods for ${authentication.nativeProvider}`
        );
    }
    const method = available.findIndex((value) => {
        const candidate = record(value);
        return (
            candidate?.type === 'oauth' &&
            (!authentication.nativeMethod ||
                candidate.label === authentication.nativeMethod)
        );
    });
    if (method < 0) {
        throw new Error(
            authentication.nativeMethod
                ? `OpenCode did not expose the configured authentication method: ${authentication.nativeMethod}`
                : `OpenCode did not expose a compatible OAuth method for ${authentication.nativeProvider}`
        );
    }
    const authorization = record(
        await server.authorizeProvider(authentication.nativeProvider, method)
    );
    const url = string(authorization?.url);
    const instructions = string(authorization?.instructions);
    if (!url || authorization?.method !== 'auto') {
        throw new Error(
            `OpenCode did not expose a supported headless authentication flow for ${authentication.nativeProvider}`
        );
    }
    await host.emit({
        type: 'authentication.requested',
        data: {
            provider: authentication.provider,
            native_provider: authentication.nativeProvider,
            url,
            ...(instructions ? { instructions } : {}),
        },
    });
    await server.completeProviderAuthorization(authentication.nativeProvider, method);
    await host.emit({
        type: 'authentication.completed',
        data: {
            provider: authentication.provider,
            native_provider: authentication.nativeProvider,
        },
    });
}
