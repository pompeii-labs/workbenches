import { createSignal } from 'solid-js';
import type {
    RepositoryBinding,
    RepositoryCheckReport,
    RepositoryInspection,
    RepositoryInspectionState,
    RepositoryLog,
    RepositoryRequest,
} from '../../repositories/index.js';
import type { WorkbenchEvent } from '../../runs/index.js';

export interface RepositoryViewState {
    status?: RepositoryInspectionState | undefined;
    checks?: RepositoryCheckReport | undefined;
    checkedAt?: string | undefined;
    error?: string | undefined;
    busy: boolean;
    watching: boolean;
}

/** Owns the terminal's observed GitHub state, not credentials or publication policy. */
export class RepositoryController {
    readonly state;
    private readonly update;
    private inspection?: RepositoryInspection;
    private timer: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private refreshPending: Promise<void> | undefined;
    private loadSequence = 0;

    constructor(
        readonly request: RepositoryRequest | undefined,
        readonly binding: RepositoryBinding | undefined,
        private readonly factory: (id: string) => RepositoryInspection,
        private readonly opener: (url: string) => Promise<void> = openRepositoryUrl
    ) {
        [this.state, this.update] = createSignal<RepositoryViewState>({
            busy: false,
            watching: false,
        });
    }

    get available() {
        return Boolean(this.request || this.binding);
    }
    get target() {
        const binding = this.state().status?.binding ?? this.binding;
        return binding ? `${binding.owner}/${binding.name}` : this.request?.repository;
    }

    async attach(id: string) {
        if (!this.available) return;
        this.inspection = this.factory(id);
        await this.load();
    }

    async load() {
        if (!this.inspection || this.disposed) return;
        const sequence = ++this.loadSequence;
        try {
            const status = await this.inspection.load();
            if (this.disposed || sequence !== this.loadSequence) return;
            this.update((current) => ({
                ...current,
                status,
                error: undefined,
                ...(current.checks?.pull_request.head !== status.receipt?.commit ||
                status.receipt?.state !== 'published'
                    ? { checks: undefined, checkedAt: undefined }
                    : {}),
            }));
        } catch (error) {
            if (sequence === this.loadSequence) this.fail(error);
        }
    }

    observe(event: WorkbenchEvent) {
        if (
            [
                'repository.ready',
                'delivery.completed',
                'delivery.failed',
                'outcome.available',
            ].includes(event.type)
        )
            void this.load();
    }

    refresh(): Promise<void> {
        if (!this.refreshPending && this.state().busy) return Promise.resolve();
        this.refreshPending ??= this.refreshOnce().finally(() => {
            this.refreshPending = undefined;
        });
        return this.refreshPending;
    }

    private async refreshOnce() {
        if (!this.inspection || this.disposed) return;
        this.update((current) => ({ ...current, busy: true, error: undefined }));
        try {
            await this.load();
            if (this.state().status?.receipt?.state !== 'published') return;
            const checks = await this.inspection.checks();
            await this.load();
            if (
                !this.disposed &&
                this.state().status?.receipt?.state === 'published' &&
                this.state().status?.receipt?.commit === checks.pull_request.head
            )
                this.update((current) => ({
                    ...current,
                    checks,
                    checkedAt: new Date().toISOString(),
                    error: undefined,
                }));
        } catch (error) {
            this.fail(error);
        } finally {
            if (!this.disposed) this.update((current) => ({ ...current, busy: false }));
        }
    }

    async logs(id: number): Promise<RepositoryLog> {
        if (!this.inspection) throw new Error('This session is still starting');
        return this.inspection.logs(id);
    }

    async open(url = this.state().status?.receipt?.pull_request?.url) {
        if (!url) return;
        try {
            await this.opener(url);
        } catch (error) {
            this.fail(error);
        }
    }

    watch(enabled: boolean) {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        if (this.disposed) return;
        this.update((current) => ({ ...current, watching: enabled }));
        if (enabled) {
            void this.refresh();
            this.timer = setInterval(() => void this.refresh(), 30_000);
        }
    }

    dispose() {
        this.watch(false);
        this.disposed = true;
    }
    private fail(error: unknown) {
        if (!this.disposed)
            this.update((current) => ({
                ...current,
                error:
                    error instanceof Error ? error.message : 'GitHub operation failed',
            }));
    }
}

async function openRepositoryUrl(url: string) {
    const parsed = new URL(url);
    if (
        parsed.protocol !== 'https:' ||
        parsed.hostname !== 'github.com' ||
        parsed.username ||
        parsed.password ||
        parsed.port
    )
        throw new Error('Only GitHub result links can be opened');
    const command =
        process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
              ? [
                    'powershell.exe',
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    'Start-Process -FilePath $env:WORKBENCH_OPEN_URL',
                ]
              : ['xdg-open', url];
    const child = Bun.spawn(command, {
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            ...(process.platform === 'win32'
                ? { WORKBENCH_OPEN_URL: parsed.href }
                : {}),
            DISPLAY: process.env.DISPLAY,
            WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
            XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
    });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
        if ((await child.exited) !== 0)
            throw new Error('Could not open GitHub. Command-click the link instead.');
    } finally {
        clearTimeout(timeout);
    }
}
