import { modelLabel } from '../../models/index.js';
import { RunnerRegistry } from '../../runners/registry.js';
import { RunStore, type StoredRun } from '../../runs/index.js';
import type { ResolvedWorkbenchReference } from '../../workbench/index.js';
import type { DialogContextValue } from '../dialog/index.js';
import { InfoDialog } from '../dialog/info.js';
import { SelectDialog } from '../dialog/select.js';
import type { ThemeOption } from '../theme/index.js';
import { CommandPalette } from './palette.js';
import { type TuiCommand, TuiCommandRegistry } from './registry.js';

export interface SessionCommandActions {
    currentRunId(): string | undefined;
    clearTranscript(): void;
    cancelTurn(): void | Promise<void>;
    exit(): void | Promise<void>;
    showError(message: string): void;
}

export interface SessionThemeActions {
    selected(): string;
    options(): ThemeOption[];
    preview(name: string): void;
    select(name: string): Promise<void>;
}

export class SessionCommands {
    readonly registry: TuiCommandRegistry;
    readonly #runner = RunnerRegistry.standard();

    constructor(
        private readonly options: {
            home: string;
            alias: string;
            resolved: ResolvedWorkbenchReference;
            dialog: DialogContextValue;
            themes: SessionThemeActions;
            actions: SessionCommandActions;
        }
    ) {
        this.registry = new TuiCommandRegistry(this.#definitions());
    }

    openPalette(): void {
        this.options.dialog.open(() => (
            <CommandPalette
                commands={this.registry}
                onSelect={(command) => void this.run(command, '')}
            />
        ));
    }

    async run(command: TuiCommand, argument: string): Promise<void> {
        if (command.enabled === false) {
            this.options.actions.showError(
                command.disabledReason ?? `/${command.name} is unavailable`
            );
            return;
        }
        await command.run(argument);
    }

    #definitions(): TuiCommand[] {
        const manifest = this.options.resolved.workbench.manifest;
        const declaration = this.#runner.session(manifest.runner).declaration;
        return [
            this.#command(
                'help',
                'Command palette',
                'Browse every TUI command',
                'Display',
                () => this.openPalette()
            ),
            this.#command(
                'workbench',
                'Workbench details',
                'Inspect the active Workbench package',
                'Workbench',
                () =>
                    this.options.dialog.open(() => (
                        <InfoDialog
                            title={manifest.name}
                            description={`Running from ${this.options.alias}`}
                            sections={[
                                { label: 'Version', value: manifest.version },
                                { label: 'Runner', value: manifest.runner },
                                { label: 'Model', value: modelLabel(manifest.model) },
                                { label: 'Runtime', value: manifest.runtime },
                                {
                                    label: 'Package',
                                    value: this.options.resolved.workbench
                                        .packageDirectory,
                                },
                            ]}
                        />
                    ))
            ),
            this.#command(
                'runtime',
                'Runtime details',
                'Inspect the locked execution runtime',
                'Workbench',
                () =>
                    this.options.dialog.open(() => (
                        <InfoDialog
                            title="Runtime"
                            sections={[
                                { label: 'Type', value: manifest.runtime },
                                {
                                    label: 'Workspace',
                                    value: this.options.resolved.workspaceDirectory,
                                },
                            ]}
                        />
                    ))
            ),
            this.#command(
                'model',
                'Model details',
                'Inspect the Workbench model policy',
                'Workbench',
                () =>
                    this.options.dialog.open(() => (
                        <InfoDialog
                            title="Model"
                            description="The Workbench author locks the model. A compatible provider connection may be selected separately."
                            sections={[
                                {
                                    label: 'Canonical model',
                                    value: modelLabel(manifest.model),
                                },
                            ]}
                        />
                    ))
            ),
            this.#command(
                'permissions',
                'Runner capabilities',
                'Inspect native capabilities exposed by this runner',
                'Workbench',
                () =>
                    this.options.dialog.open(() => (
                        <InfoDialog
                            title={`${manifest.runner} capabilities`}
                            lines={Object.entries(declaration.capabilities).map(
                                ([name, support]) =>
                                    `${support.status === 'supported' ? '✓' : support.status === 'degraded' ? '△' : '○'} ${name.replaceAll('_', ' ')}${support.detail ? `: ${support.detail}` : ''}`
                            )}
                        />
                    ))
            ),
            this.#command(
                'sessions',
                'Recent sessions',
                'Inspect recent local Workbench runs',
                'Session',
                () => this.#showSessions()
            ),
            this.#command(
                'theme',
                'Choose theme',
                'Change the terminal color theme',
                'Display',
                () => this.#showThemes()
            ),
            this.#command(
                'clear',
                'Clear transcript',
                'Clear the local view without resetting runner context',
                'Display',
                () => this.options.actions.clearTranscript()
            ),
            this.#command(
                'cancel',
                'Cancel turn',
                'Cancel the active runner turn',
                'Session',
                () => this.options.actions.cancelTurn()
            ),
            this.#command(
                'quit',
                'Quit',
                'Close the session and exit',
                'Session',
                () => this.options.actions.exit(),
                ['exit']
            ),
        ];
    }

    #command(
        name: string,
        title: string,
        description: string,
        category: TuiCommand['category'],
        run: TuiCommand['run'],
        aliases?: string[]
    ): TuiCommand {
        return {
            name,
            title,
            description,
            category,
            run,
            ...(aliases ? { aliases } : {}),
        };
    }

    async #showSessions(): Promise<void> {
        const runs = (await new RunStore(this.options.home).list())
            .filter((run) => run.mode === 'interactive')
            .slice(0, 20);
        if (runs.length === 0) {
            this.options.dialog.open(() => (
                <InfoDialog
                    title="Sessions"
                    description="No interactive Workbench sessions have been run locally."
                />
            ));
            return;
        }
        const current = this.options.actions.currentRunId();
        this.options.dialog.open(() => (
            <SelectDialog
                title="Sessions"
                placeholder="Search sessions"
                options={runs.map((run) => ({
                    title: `${run.workbench}@${run.workbench_version}`,
                    description: `${this.#status(run.status)} · ${run.runner} · ${this.#time(run)}`,
                    value: run,
                    current: run.id === current,
                }))}
                onSelect={(option) => this.#showSession(option.value)}
            />
        ));
    }

    #showSession(run: StoredRun): void {
        this.options.dialog.open(() => (
            <InfoDialog
                title={run.workbench}
                description={`${this.#status(run.status)} interactive session`}
                sections={[
                    {
                        label: 'Workbench',
                        value: `${run.workbench}@${run.workbench_version}`,
                    },
                    { label: 'Runner', value: `${run.runner} · ${run.model}` },
                    { label: 'Started', value: this.#time(run) },
                    { label: 'Workspace', value: run.workspace },
                    { label: 'Run ID', value: run.id },
                ]}
            />
        ));
    }

    #status(status: StoredRun['status']): string {
        return status.charAt(0).toUpperCase() + status.slice(1);
    }

    #time(run: StoredRun): string {
        const timestamp = run.started_at ?? run.dispatched_at;
        const date = new Date(timestamp);
        if (Number.isNaN(date.valueOf())) return timestamp;
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(date);
    }

    #showThemes(): void {
        const initial = this.options.themes.selected();
        let confirmed = false;
        this.options.dialog.open(
            () => (
                <SelectDialog
                    title="Themes"
                    options={this.options.themes.options().map((theme) => ({
                        title: theme.label,
                        value: theme.name,
                        current: theme.name === initial,
                    }))}
                    onMove={(theme) => this.options.themes.preview(theme.value)}
                    onConfirm={() => {
                        confirmed = true;
                    }}
                    onSelect={(theme) => void this.options.themes.select(theme.value)}
                />
            ),
            () => {
                if (!confirmed) this.options.themes.preview(initial);
            }
        );
    }
}
