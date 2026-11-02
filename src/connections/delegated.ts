import type { AuthenticatedModelRoute, ModelRouter } from '../models/index.js';
import type { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner, Runner, RunnerConnection } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import {
    type ConnectionAuthenticationMethod,
    connectionRuntimes,
} from './contracts.js';
import { AuthenticationRequiredError } from './error.js';
import { diagnostic, stripTerminalControl } from './listing.js';
import type { RunnerConnectionSelection } from './store.js';

/**
 * The method of a provider's `nativeProvider` connection when another
 * runner's own login serves it, such as OpenCode's Claude Agent on Claude
 * Code's login, as the runner lists it for `runtime`.
 */
export function delegatedMethod(
    connection: RunnerConnection,
    runtime: string,
    provider: string,
    nativeProvider: string,
    router: ModelRouter
): ConnectionAuthenticationMethod | undefined {
    const name = connectionRuntimes.find((candidate) => candidate === runtime);
    if (!name) return undefined;
    return connection
        .methods(name, provider, router.catalog)
        ?.find(
            (method) =>
                method.signInRunner !== undefined &&
                method.nativeProvider.toLowerCase() === nativeProvider.toLowerCase()
        );
}

/**
 * The routes another runner's own login serves, checked only for the
 * connection the caller wants. That runner's probe runs in the same runtime,
 * and a login that is unavailable, missing, or not a subscription fails with
 * what to do rather than falling back to another route.
 */
export async function inspectDelegated(
    options: { runtime: PreparedRuntime; runner: PreparedRunner },
    harness: Runner,
    runners: Pick<RunnerRegistry, 'resolve'>,
    candidates: AuthenticatedModelRoute[],
    router: ModelRouter,
    wanted: Pick<RunnerConnectionSelection, 'provider' | 'nativeProvider'> | undefined
): Promise<AuthenticatedModelRoute[]> {
    if (!wanted) return [];
    const runtime = options.runtime.name;
    const delegated = candidates.flatMap((candidate) => {
        if (
            candidate.nativeProvider.toLowerCase() !==
                wanted.nativeProvider.trim().toLowerCase() ||
            (wanted.provider && wanted.provider !== candidate.provider)
        )
            return [];
        const method = delegatedMethod(
            harness.connection,
            runtime,
            candidate.provider,
            candidate.nativeProvider,
            router
        );
        return method?.signInRunner
            ? [{ candidate, method, owner: method.signInRunner }]
            : [];
    });
    const [first] = delegated;
    if (!first) return [];
    if (first.method.unavailable)
        throw new AuthenticationRequiredError(`${first.method.unavailable}.`);
    const owner = runners.resolve(first.owner);
    const variables = owner.nativeCredentialVariables.join(' or ');
    const signIn =
        runtime === 'local'
            ? (owner.connection.manualSignIn ?? `Sign in to ${owner.displayName}`)
            : `${variables ? `Set ${variables} where wb runs, or sign` : 'Sign'} in to ${owner.displayName} on a worker with wb connect --worker <worker> ${owner.name}`;
    const result = await options.runtime
        .execute(
            options.runner.native(options.runtime, owner.connection.probe.command),
            {
                network: 'none',
                readOnly: true,
            }
        )
        .catch((error: unknown) => ({
            code: 1,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
        }));
    if (result.code !== 0) {
        throw new AuthenticationRequiredError(
            `${diagnostic(result, `${owner.displayName} could not report its login in the ${runtime} runtime`)}. ${first.method.label} needs ${owner.displayName} installed there${runtime === 'docker' ? ', pinned in the image,' : ''} and signed in. ${signIn}.`
        );
    }
    const listing = stripTerminalControl(`${result.stdout}\n${result.stderr}`);
    const ready = delegated.flatMap(({ candidate }) =>
        owner.connection.probe
            .authenticated(
                listing,
                owner.connection.candidates(
                    {
                        provider: candidate.provider,
                        model: candidate.nativeModel,
                        value: `${candidate.provider}/${candidate.nativeModel}`,
                    },
                    router.catalog
                )
            )
            .some(
                (route) => route.authenticationMethod === candidate.authenticationMethod
            )
            ? [candidate]
            : []
    );
    if (ready.length === 0) {
        throw new AuthenticationRequiredError(
            `${owner.displayName} in the ${runtime} runtime has no subscription login for ${first.method.label}. ${signIn}.`
        );
    }
    return ready;
}
