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
    sessionRenamed(session: StoredSession): void;
    home(): void | Promise<void>;
    browseSessions(): void | Promise<void>;
    clearTranscript(): void;
    attachments(): Array<{ name: string; path: string }>;
    clearAttachments(): void;
    improve(feedback: string): void | Promise<void>;
    showOutcome(): void | Promise<void>;
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
            authoring?: boolean;
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
                'outcome',
                'Run outcome',
                'Inspect changes, artifacts, and links from this run',
                'Workbench',
                () => this.options.actions.showOutcome()
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
            ...(this.options.authoring
                ? []
                : [
                      this.#command(
                          'home',
                          'Workbench home',
                          'Detach this terminal and return to discovery',
                          'Session',
                          () => this.options.actions.home()
                      ),
                      this.#command(
                          'resume',
                          'Resume session',
                          'Detach this terminal and browse previous sessions',
                          'Session',
                          () => this.options.actions.browseSessions(),
                          ['sessions']
                      ),
                      this.#command(
                          'rename',
                          'Rename session',
                          'Set the display name for this session',
                          'Session',
                          (argument) => this.#rename(argument),
                          undefined,
                          '<name>'
                      ),
                  ]),
            ...(this.options.authoring
                ? []
                : [
                      this.#command(
                          'improve',
                          'Improve Workbench',
                          'Open the official creator with evidence from this session',
                          'Workbench',
                          (argument) => this.options.actions.improve(argument),
                          undefined,
                          '[feedback]'
                      ),
                  ]),
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
                this.options.authoring ? 'Finish authoring' : 'Quit',
                this.options.authoring
                    ? 'Validate the candidate, close the creator, and exit'
                    : 'Detach this terminal and exit',
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

    async #rename(name: string): Promise<void> {
        const id = this.options.actions.currentSessionId();
        if (!id) {
            this.options.actions.showError('This Workbench session is not ready.');
            return;
        }
        try {
            const session = await new SessionStore(this.options.home).rename(id, name);
            this.options.actions.sessionRenamed(session);
        } catch (error) {
            this.options.actions.showError(
                error instanceof Error ? error.message : String(error)
            );
        }
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
