import type { CliPresenter } from '../commands/presenter.js';
import { SessionIdentity, type SessionLifecycle } from '../sessions/index.js';
import { WorkbenchBrand } from './brand.js';
import type { WorkbenchTheme } from './theme/index.js';

export class TuiExitHandoff {
    readonly #identity = new SessionIdentity();
    readonly #brand = new WorkbenchBrand();

    constructor(
        private readonly sessions: Pick<SessionLifecycle, 'resolve'>,
        private readonly output: Pick<
            CliPresenter,
            'detail' | 'formattedBlock' | 'message'
        >,
        private readonly theme: Pick<
            WorkbenchTheme,
            'textMuted' | 'accent' | 'background'
        >
    ) {}

    async present(id: string | undefined): Promise<void> {
        if (!id) return;
        const activity = await this.sessions.resolve(id).catch(() => undefined);
        if (!activity?.resumable || !activity.session) return;

        this.output.formattedBlock(
            this.#brand.styledLines(this.theme),
            this.#brand.lines()
        );
        this.output.message(
            `Session ${this.#identity.label(activity.session)}`,
            'info'
        );
        this.output.detail('ID', activity.id);
        this.output.detail('Resume', `wb resume ${activity.id}`);
    }
}
