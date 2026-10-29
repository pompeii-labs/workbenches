import { ActiveModelCatalog, ModelRouter } from '../models/index.js';
import { ToolDetails } from '../runners/details.js';
import { patchFromUnified } from '../runners/diff.js';
import { injectedSecrets } from '../runners/secrets.js';
import { RuntimeSecretStore } from '../runtimes/secrets.js';
import type { ResolvedWorkbench } from '../types.js';
import { selectedRuntime } from '../workbench/runtimes.js';
import type { WorkbenchEventDraft } from './events.js';
import type { WorkspacePatches } from './workspace-patches.js';

const DETAIL_EVENTS = new Set(['tool.started', 'tool.completed', 'file.changed']);

/**
 * The last step tool and file details take before they become events. An
 * adapter scrubs and bounds them already, but knows only the values its own
 * runner process receives, so the run redacts every value it injected once
 * more: provider keys, runtime keys, and every `--env-file` and `--env` value.
 * A file change the adapter could not describe gets its patch from the
 * workspace. Drafts leave in the order they arrived.
 */
export class RunEventDetails {
    private readonly details: ToolDetails;
    private delivery: Promise<void> = Promise.resolve();

    constructor(
        secrets: Iterable<string>,
        private readonly workspace?: WorkspacePatches
    ) {
        this.details = new ToolDetails({
            secrets,
            ...(workspace ? { workspace: workspace.workspace } : {}),
        });
    }

    /**
     * Every value the engine passes into a run of `workbench` that a report of
     * it must not contain. `nativeCredentialVariables` are the runner's own.
     */
    static secrets(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        nativeCredentialVariables: readonly string[] = []
    ): string[] {
        const catalog = ActiveModelCatalog.active();
        const runtime = selectedRuntime(workbench).name;
        const stored =
            runtime === 'e2b' || runtime === 'daytona'
                ? [safeKey(() => RuntimeSecretStore.key(runtime, environment))]
                : [];
        return [
            ...injectedSecrets(environment, [
                ...Object.keys(workbench.manifest.env),
                ...(catalog
                    ? new ModelRouter(catalog).providerEnvironmentNames(workbench)
                    : []),
                ...nativeCredentialVariables,
                ...Object.values(RuntimeSecretStore.providers).map(
                    (provider) => provider.variable
                ),
            ]),
            ...stored.filter((value): value is string => Boolean(value)),
        ];
    }

    /** Completes `draft` and passes it to `deliver` after every earlier draft. */
    emit(
        draft: WorkbenchEventDraft,
        deliver: (draft: WorkbenchEventDraft) => Promise<void>
    ): Promise<void> {
        const delivered = this.delivery.then(async () =>
            deliver(await this.complete(draft))
        );
        this.delivery = delivered.catch(() => undefined);
        return delivered;
    }

    async complete(draft: WorkbenchEventDraft): Promise<WorkbenchEventDraft> {
        if (!DETAIL_EVENTS.has(draft.type)) return draft;
        const data = this.details.refine(draft.data);
        if (draft.type === 'file.changed' && data.patch === undefined) {
            Object.assign(data, await this.patch(data.path));
        }
        return { type: draft.type, data };
    }

    private async patch(path: unknown): Promise<Record<string, unknown>> {
        if (typeof path !== 'string' || !this.workspace) return {};
        const relative = this.workspace.relative(path);
        const diff = relative ? await this.workspace.diff(path) : undefined;
        if (!relative || !diff) return {};
        return this.details.patch(patchFromUnified(relative, diff));
    }
}

function safeKey(read: () => string | undefined): string | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}
