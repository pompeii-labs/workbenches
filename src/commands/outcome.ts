import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defineCommand } from 'citty';

import {
    OutcomeApplier,
    OutcomeExporter,
    OutcomeStore,
    type RunOutcome,
} from '../outcomes/index.js';
import { formatOutcomeBytes as formatBytes } from '../outcomes/presentation.js';
import { RepositoryWorkspace } from '../repositories/index.js';
import { RunStore, type StoredRun } from '../runs/index.js';
import { E2BOutcomeRecovery } from '../runtimes/e2b/recovery.js';
import { E2BSdkClient } from '../runtimes/e2b/sdk.js';
import { RuntimeSecretStore } from '../runtimes/secrets.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

export const outcomeCommand = defineCommand({
    meta: {
        name: 'outcome',
        description: 'Inspect, apply, or export a durable Workbench run outcome.',
    },
    args: {
        target: {
            type: 'positional',
            description: 'Workbench run ID or outcome ID',
            required: true,
        },
        apply: {
            type: 'boolean',
            description: 'Apply a pending remote changeset to its original workspace',
            default: false,
        },
        recover: {
            type: 'boolean',
            description:
                'Recover partial outcomes from their original paused E2B sandbox',
            default: false,
        },
        'discard-recovery': {
            type: 'boolean',
            description: 'Discard uncollected E2B work and release its owned sandbox',
            default: false,
        },
        export: {
            type: 'string',
            valueHint: 'directory',
            description: 'Export a self-contained review bundle',
        },
        workspace: {
            type: 'string',
            valueHint: 'directory',
            description: 'Override the primary workspace used by --apply',
        },
        json: {
            type: 'boolean',
            description: 'Emit the outcome and application receipt as JSON',
            default: false,
        },
    },
    async run({ args }) {
        if (args['discard-recovery'] && (args.apply || args.export || args.recover))
            throw new Error(
                '--discard-recovery cannot be combined with other outcome actions'
            );
        if (args.apply && args.export) {
            throw new Error('--apply and --export cannot be used together');
        }
        if (args.workspace && !args.apply) {
            throw new Error('--workspace can only be used with --apply');
        }
        if (args.recover && (args.apply || args.export))
            throw new Error('--recover must be reviewed before --apply or --export');

        const home = workbenchHome();
        if (args['discard-recovery']) {
            RunStore.validateId(args.target);
            const recovery = new E2BOutcomeRecovery(home, {
                id: args.target,
                scope: RunStore.scope(home),
            });
            if (!(await recovery.exists()))
                throw new Error('This run has no pending E2B outcome recovery');
            const discarded = await recovery.discardPending(e2bRecoveryClient());
            if (args.json)
                process.stdout.write(
                    `${JSON.stringify({ discarded_recovery: discarded })}\n`
                );
            else
                new CliPresenter().message(
                    `Discarded pending outcome recovery for ${args.target}. No host workspace files were changed.`,
                    'warning'
                );
            return;
        }
        const outcomes = new OutcomeStore(home);
        const runs = new RunStore(home);
        const resolved: { outcome: RunOutcome; run?: StoredRun } = args.recover
            ? await recoverOutcome(args.target, home)
            : await resolveOutcome(args.target, outcomes, runs);
        let action:
            | { type: 'apply'; applied: number; unchanged: number }
            | { type: 'export'; path: string }
            | undefined;

        if (args.apply) {
            const run = resolved.run ?? (await runs.read(resolved.outcome.run_id));
            const result = await new OutcomeApplier(outcomes).apply(
                resolved.outcome,
                workspaceTargets(run, args.workspace)
            );
            action = { type: 'apply', ...result };
        } else if (args.export) {
            action = {
                type: 'export',
                path: await new OutcomeExporter(outcomes).export(
                    resolved.outcome,
                    args.export
                ),
            };
        }

        const receipt = await outcomes.receipt(resolved.outcome.id);
        if (args.json) {
            process.stdout.write(
                `${JSON.stringify({ outcome: resolved.outcome, application: receipt, ...(action ? { action } : {}) })}\n`
            );
            return;
        }
        await renderOutcome(outcomes, resolved.outcome, receipt.state, action);
    },
});

async function recoverOutcome(
    target: string,
    home: string
): Promise<{ outcome: RunOutcome }> {
    RunStore.validateId(target);
    const recovery = new E2BOutcomeRecovery(home, {
        id: target,
        scope: RunStore.scope(home),
    });
    if (!(await recovery.exists()))
        throw new Error('This run has no pending E2B outcome recovery');
    return { outcome: await recovery.recover(e2bRecoveryClient()) };
}

function e2bRecoveryClient(): E2BSdkClient {
    const key = RuntimeSecretStore.e2bKey();
    if (!key)
        throw new Error(
            'E2B_API_KEY is required to manage the original outcome sandbox. Run wb connect --runtime e2b once, or set E2B_API_KEY.'
        );
    return new E2BSdkClient(key);
}

async function resolveOutcome(
    target: string,
    outcomes: OutcomeStore,
    runs: RunStore
): Promise<{ outcome: RunOutcome; run?: StoredRun }> {
    if (target.startsWith('wbo_')) return { outcome: await outcomes.read(target) };
    if (!target.startsWith('wb_')) {
        throw new Error('Outcome target must be a Workbench run ID or outcome ID');
    }
    const run = await runs.read(target);
    const outcome = run.outcome_id
        ? await outcomes.read(run.outcome_id)
        : await outcomes.findByRun(run.id);
    if (!outcome) throw new Error(`Workbench run has no outcome: ${run.id}`);
    return { outcome, run };
}

function workspaceTargets(run: StoredRun, primary?: string) {
    const named = Object.fromEntries(
        (run.workspaces ?? []).map((workspace) => [
            workspace.name,
            resolve(workspace.path),
        ])
    );
    return {
        primary: resolve(
            primary ??
                (run.repository
                    ? new RepositoryWorkspace(
                          workbenchHome(),
                          run.repository,
                          process.env
                      ).directory
                    : run.workspace)
        ),
        ...(Object.keys(named).length > 0 ? { named } : {}),
    };
}

async function renderOutcome(
    store: OutcomeStore,
    outcome: RunOutcome,
    state: 'pending' | 'present' | 'applied',
    action:
        | { type: 'apply'; applied: number; unchanged: number }
        | { type: 'export'; path: string }
        | undefined
): Promise<void> {
    const output = new CliPresenter();
    output.record({
        machine: [
            outcome.id,
            outcome.run_id,
            state,
            outcome.completeness,
            String(outcome.changesets.length),
            String(outcome.artifacts.length),
            String(outcome.links.length),
        ],
        title: outcome.summary ?? 'Workbench outcome',
        details: [
            outcome.id,
            state,
            outcome.completeness,
            plural(outcome.changesets.length, 'changeset'),
            plural(outcome.artifacts.length, 'artifact'),
            plural(outcome.links.length, 'link'),
        ],
        tone: outcome.completeness === 'complete' ? 'success' : 'warning',
    });
    output.detail('Run', outcome.run_id);
    for (const changeset of outcome.changesets) {
        const workspace =
            changeset.workspace.kind === 'primary'
                ? 'primary'
                : changeset.workspace.name;
        output.detail(
            `Changes ${workspace}`,
            [
                `${changeset.entries.length} files`,
                `+${changeset.stats.additions}`,
                `~${changeset.stats.modifications}`,
                `-${changeset.stats.deletions}`,
            ].join(' · ')
        );
    }
    const artifactPaths = await store.artifactPaths(outcome.id);
    for (const artifact of outcome.artifacts) {
        const path = artifactPaths.get(artifact.id) as string;
        output.detail(
            'Artifact',
            `${output.link(artifact.name, pathToFileURL(path).href)} · ${formatBytes(artifact.content.size_bytes)}`
        );
    }
    for (const link of outcome.links)
        output.detail('Link', output.link(link.label, link.uri));
    for (const warning of outcome.warnings) {
        output.message(`${warning.code}: ${warning.message}`, 'warning');
    }
    if (action?.type === 'apply') {
        output.message(
            `Applied ${action.applied} paths; ${action.unchanged} already matched.`,
            'success'
        );
    } else if (action?.type === 'export') {
        output.message(`Exported review bundle to ${action.path}`, 'success');
    } else if (state === 'pending' && outcome.changesets.length > 0) {
        output.message(`Apply with: wb outcome ${outcome.id} --apply`);
    }
}

function plural(count: number, singular: string): string {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
}
