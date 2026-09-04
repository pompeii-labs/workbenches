import { modelLabel } from '../../models/index.js';
import { RunnerRegistry } from '../../runners/registry.js';
import { SessionStore, type StoredSession } from '../../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../../workbench/index.js';
import type { DialogContextValue } from '../dialog/index.js';
import { InfoDialog } from '../dialog/info.js';
import { SelectDialog } from '../dialog/select.js';
import type { ThemeOption } from '../theme/index.js';
import { CommandPalette } from './palette.js';
import { type TuiCommand, TuiCommandRegistry } from './registry.js';

export interface SessionCommandActions {
    currentSessionId(): string | undefined;
    resumeSession(session: StoredSession): void | Promise<void>;
    clearTranscript(): void;
    attachments(): Array<{ name: string; path: string }>;
    clearAttachments(): void;
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
                'attachments',
                'Prompt attachments',
                'Inspect or clear images staged for the next message',
                'Session',
                (argument) => this.#showAttachments(argument),
                undefined,
                '[clear]'
            ),
            this.#command(
                'sessions',
                'Recent sessions',
                'Resume a local Workbench session',
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
        aliases?: string[],
        usage?: string
    ): TuiCommand {
        return {
            name,
            title,
            description,
            category,
            run,
            ...(aliases ? { aliases } : {}),
            ...(usage ? { usage } : {}),
        };
    }

    #showAttachments(argument: string): void {
        const action = argument.trim().toLowerCase();
        if (action && action !== 'clear') {
            this.options.actions.showError('Usage: /attachments or /attachments clear');
            return;
        }
        if (action === 'clear') {
            this.options.actions.clearAttachments();
            return;
        }
        const attachments = this.options.actions.attachments();
        this.options.dialog.open(() => (
            <InfoDialog
                title="Attachments"
                description={
                    attachments.length === 0
                        ? 'No images are staged. Drag an image file into the composer to attach it to the next message.'
                        : `${attachments.length} image${attachments.length === 1 ? '' : 's'} staged for the next message.`
                }
                lines={attachments.map(
                    (attachment) => `${attachment.name} · ${attachment.path}`
                )}
            />
        ));
    }

    async #showSessions(): Promise<void> {
        const sessions = (
            await new SessionStore(this.options.home).list({
                resumableOnly: true,
            })
        ).slice(0, 20);
        if (sessions.length === 0) {
            this.options.dialog.open(() => (
                <InfoDialog
                    title="Sessions"
                    description="No interactive Workbench sessions have been run locally."
                />
            ));
            return;
        }
        const current = this.options.actions.currentSessionId();
        this.options.dialog.open(() => (
            <SelectDialog
                title="Sessions"
                placeholder="Search sessions"
                options={sessions.map((session) => ({
                    title: `${session.workbench}@${session.workbench_version}`,
                    description: `${session.runner} · ${this.#time(session.updated_at)} · ${session.id}`,
                    value: session,
                    current: session.id === current,
                }))}
                onSelect={(option) => {
                    if (option.value.id === current) return;
                    void this.options.actions.resumeSession(option.value);
                }}
            />
        ));
    }

    #time(timestamp: string): string {
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
