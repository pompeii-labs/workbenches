import { autocomplete, log, select } from '@clack/prompts';
import type { AuthenticatedModelRoute } from '../models/index.js';
import type { PreparedRunner } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
import { ConnectionInspector, type RunnerAuthenticationStatus } from './inspector.js';
import { ConnectionStore, type RunnerConnectionSelection } from './store.js';

export type RunnerConnectionChoice =
    | { kind: 'connection'; connection: AuthenticatedModelRoute }
    | { kind: 'connect' };

export type ChooseRunnerConnection = (options: {
    runner: string;
    model: string;
    connections: AuthenticatedModelRoute[];
    current?: RunnerConnectionSelection;
    allowConnect: boolean;
}) => Promise<RunnerConnectionChoice>;

export type ChooseRunnerProvider = (options: {
    runner: string;
    model: string;
    providers: AuthenticatedModelRoute[];
}) => Promise<AuthenticatedModelRoute>;

export interface RunnerSelectOptions {
    message: string;
    options: Array<{
        value: number;
        label: string;
        hint?: string;
    }>;
    initialValue?: number;
    maxItems?: number;
    placeholder?: string;
}

export type RunnerSelect = (options: RunnerSelectOptions) => Promise<number | symbol>;

export interface ConnectionManagerOptions {
    workbench: ResolvedWorkbench;
    runtime: PreparedRuntime;
    runner: PreparedRunner;
    reference: string;
    home: string;
    choose?: ChooseRunnerConnection;
    chooseProvider?: ChooseRunnerProvider;
    announce?: (message: string) => void;
}

export class ConnectionManager {
    readonly #options: ConnectionManagerOptions;
    readonly #store: ConnectionStore;
    readonly #inspector: ConnectionInspector;

    constructor(options: ConnectionManagerOptions) {
        this.#options = options;
        this.#store = new ConnectionStore(options.home);
        this.#inspector = new ConnectionInspector({
            workbench: options.workbench,
            runtime: options.runtime,
            runner: options.runner,
            reference: options.reference,
            store: this.#store,
        });
    }

    async configure(): Promise<RunnerAuthenticationStatus> {
        const context = ConnectionStore.context(
            this.#options.workbench,
            this.#options.reference
        );
        const preferred = await this.#store.find(context);
        const canAuthenticate = this.#inspector.supportsNativeAuthentication();
        const choose = this.#options.choose ?? ConnectionManager.promptConnection;
        const chooseProvider =
            this.#options.chooseProvider ?? ConnectionManager.promptProvider;
        const announce = this.#options.announce ?? log.info;
        let status = await this.#inspector.inspect({
            discoverConnections: true,
            ...(preferred ? { preferredConnection: preferred } : {}),
        });

        let selection: AuthenticatedModelRoute;
        if (status.connections.length > 0) {
            const choice = await choose({
                runner: this.#options.workbench.manifest.runner,
                model: status.model,
                connections: status.connections,
                ...(preferred ? { current: preferred } : {}),
                allowConnect: canAuthenticate,
            });
            if (choice.kind === 'connection') {
                selection = choice.connection;
            } else {
                const connected = await this.#connectProvider(
                    choose,
                    chooseProvider,
                    announce
                );
                status = connected.status;
                selection = connected.selection;
            }
        } else {
            if (!canAuthenticate) {
                throw this.#inspector.nativeAuthenticationError();
            }
            const connected = await this.#connectProvider(
                choose,
                chooseProvider,
                announce
            );
            status = connected.status;
            selection = connected.selection;
        }

        const saved = {
            provider: selection.provider,
            nativeProvider: selection.nativeProvider,
        };
        await this.#store.save(context, saved);
        return this.#inspector.inspect({ preferredConnection: saved });
    }

    async #connectProvider(
        choose: ChooseRunnerConnection,
        chooseProvider: ChooseRunnerProvider,
        announce: (message: string) => void
    ): Promise<{
        status: RunnerAuthenticationStatus;
        selection: AuthenticatedModelRoute;
    }> {
        const runnerName = this.#options.workbench.manifest.runner;
        const provider = await chooseProvider({
            runner: runnerName,
            model: this.#options.workbench.manifest.model.id,
            providers: this.#inspector.candidates(),
        });
        announce(authenticationMessage(runnerName, provider));
        const status = await this.#inspector.connect(provider.nativeProvider);
        const matching = status.connections.filter(
            (connection) =>
                connection.provider === provider.provider &&
                connection.nativeProvider === provider.nativeProvider
        );
        return {
            status,
            selection: await chooseConnectedRoute(
                choose,
                runnerName,
                status.model,
                matching
            ),
        };
    }

    static promptConnection(
        options: Parameters<ChooseRunnerConnection>[0],
        providedSelect?: RunnerSelect
    ): Promise<RunnerConnectionChoice> {
        return promptRunnerConnection(options, providedSelect);
    }

    static promptProvider(
        options: Parameters<ChooseRunnerProvider>[0],
        providedSelect?: RunnerSelect
    ): Promise<AuthenticatedModelRoute> {
        return promptRunnerProvider(options, providedSelect);
    }

    static connectionLabel(connection: AuthenticatedModelRoute): string {
        return connectionLabel(connection);
    }

    static runnerLabel(runner: string): string {
        return runnerLabel(runner);
    }
}

async function promptRunnerConnection(
    options: {
        runner: string;
        model: string;
        connections: AuthenticatedModelRoute[];
        current?: RunnerConnectionSelection;
        allowConnect: boolean;
    },
    providedSelect?: RunnerSelect
): Promise<RunnerConnectionChoice> {
    if (!providedSelect && (!process.stdin.isTTY || !process.stderr.isTTY)) {
        throw new Error('wb connect requires an interactive terminal');
    }
    const choices: RunnerConnectionChoice[] = [
        ...options.connections.map(
            (connection): RunnerConnectionChoice => ({
                kind: 'connection',
                connection,
            })
        ),
        ...(options.allowConnect
            ? [{ kind: 'connect' } satisfies RunnerConnectionChoice]
            : []),
    ];
    const currentIndex = choices.findIndex(
        (choice) =>
            choice.kind === 'connection' &&
            sameSelection(choice.connection, options.current)
    );
    const result = await (providedSelect ?? clackSelect)({
        message: `Choose a connection for ${options.model}`,
        options: choices.map((choice, index) => ({
            value: index,
            label:
                choice.kind === 'connect'
                    ? 'Add or update a connection'
                    : connectionLabel(choice.connection),
            hint:
                choice.kind === 'connect'
                    ? `uses ${runnerLabel(options.runner)} sign-in`
                    : sameSelection(choice.connection, options.current)
                      ? 'current'
                      : 'connected',
        })),
        initialValue: currentIndex >= 0 ? currentIndex : 0,
    });
    if (typeof result === 'symbol') {
        throw new Error('Connection selection cancelled');
    }
    const choice = choices[result];
    if (!choice) throw new Error('A connection must be selected');
    return choice;
}

async function promptRunnerProvider(
    options: {
        runner: string;
        model: string;
        providers: AuthenticatedModelRoute[];
    },
    providedSelect?: RunnerSelect
): Promise<AuthenticatedModelRoute> {
    const only = options.providers[0];
    if (options.providers.length === 1 && only) return only;
    if (!providedSelect && (!process.stdin.isTTY || !process.stderr.isTTY)) {
        throw new Error('wb connect requires an interactive terminal');
    }
    const providers = prioritizedProviders(options.model, options.providers);
    const result = await (providedSelect ?? clackAutocomplete)({
        message: `Choose a provider for ${options.model}`,
        placeholder: 'Type to search providers',
        maxItems: 7,
        options: providers.map((provider, index) => {
            const hint = authenticationHint(options.runner, provider);
            return {
                value: index,
                label: connectionLabel(provider),
                ...(hint ? { hint } : {}),
            };
        }),
        initialValue: 0,
    });
    if (typeof result === 'symbol') throw new Error('Provider selection cancelled');
    const provider = providers[result];
    if (!provider) throw new Error('A provider must be selected');
    return provider;
}

function connectionLabel(connection: AuthenticatedModelRoute): string {
    if (connection.nativeProvider === 'openai-codex') {
        return 'OpenAI Codex subscription';
    }
    if (connection.nativeProvider === connection.provider) {
        return providerLabel(connection.provider);
    }
    return `${providerLabel(connection.provider)} through ${providerLabel(connection.nativeProvider)}`;
}

async function chooseConnectedRoute(
    choose: ChooseRunnerConnection,
    runner: string,
    model: string,
    connections: AuthenticatedModelRoute[]
): Promise<AuthenticatedModelRoute> {
    const only = connections[0];
    if (connections.length === 1 && only) return only;
    const choice = await choose({
        runner,
        model,
        connections,
        allowConnect: false,
    });
    if (choice.kind === 'connection') return choice.connection;
    throw new Error('A connected provider must be selected');
}

function sameSelection(
    connection: AuthenticatedModelRoute,
    selection?: RunnerConnectionSelection
): boolean {
    return (
        connection.provider === selection?.provider &&
        connection.nativeProvider === selection.nativeProvider
    );
}

function authenticationMessage(
    runner: string,
    provider: AuthenticatedModelRoute
): string {
    const hint = authenticationHint(runner, provider);
    return `Opening ${runnerLabel(runner)} authentication for ${connectionLabel(provider)}${hint ? `. Choose a sign-in method in the next prompt: ${hint}` : ''}. Workbench does not copy or store the credential.`;
}

function authenticationHint(
    runner: string,
    provider: AuthenticatedModelRoute
): string | undefined {
    if (provider.nativeProvider === 'openai-codex') return 'ChatGPT Plus/Pro';
    if (provider.nativeProvider === 'openai') {
        return runner === 'opencode' ? 'API key or ChatGPT Plus/Pro' : 'API key';
    }
    if (provider.nativeProvider === 'openrouter') return 'API key';
    return undefined;
}

function clackSelect(options: RunnerSelectOptions): Promise<number | symbol> {
    return select<number>(options);
}

function clackAutocomplete(options: RunnerSelectOptions): Promise<number | symbol> {
    return autocomplete<number>(options);
}

function prioritizedProviders(
    model: string,
    providers: AuthenticatedModelRoute[]
): AuthenticatedModelRoute[] {
    const canonicalProvider = model.slice(0, model.indexOf('/'));
    return providers.toSorted((left, right) => {
        const leftRank = providerRank(left.provider, canonicalProvider);
        const rightRank = providerRank(right.provider, canonicalProvider);
        return leftRank - rightRank || left.provider.localeCompare(right.provider);
    });
}

function providerRank(provider: string, canonicalProvider: string): number {
    if (provider === canonicalProvider) return 0;
    if (provider === 'openrouter') return 1;
    return 2;
}

function providerLabel(provider: string): string {
    const known = {
        openai: 'OpenAI',
        openrouter: 'OpenRouter',
    }[provider];
    if (known) return known;
    return provider
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function runnerLabel(runner: string): string {
    return runner === 'opencode' ? 'OpenCode' : runner === 'pi' ? 'Pi' : runner;
}
