import { OutcomeStore } from '../outcomes/index.js';
import { RunStore } from '../runs/store.js';
import { RepositoryChecks } from './checks.js';
import {
    assertRepositoryBinding,
    type RepositoryBinding,
    type RepositoryDeliveryReceipt,
} from './contracts.js';
import { RepositoryGitHub } from './github.js';
import { RepositoryDeliveryStore } from './receipts.js';
import { RepositoryWorkspace } from './workspace.js';

export type RepositoryCheckReport = Awaited<ReturnType<RepositoryChecks['read']>>;
export type RepositoryPull = Awaited<ReturnType<RepositoryChecks['pull']>>;
export type RepositoryLog = Awaited<ReturnType<RepositoryChecks['logs']>>;
export type RepositoryInspectionState = Awaited<
    ReturnType<RepositoryInspection['load']>
>;

/** Host-side inspection never launches a runner or grants new repository authority. */
export class RepositoryInspection {
    constructor(
        private readonly home: string,
        readonly runId: string,
        private readonly environment: Record<string, string | undefined>,
        private readonly github?: RepositoryGitHub
    ) {}

    async load() {
        const run = await new RunStore(this.home).read(this.runId);
        const binding = run.repository;
        if (!binding)
            throw new Error('This session is not running on a GitHub repository');
        assertRepositoryBinding(binding);
        const native = await this.nativePull(run, binding);
        const receipt =
            native?.receipt ??
            (await new RepositoryDeliveryStore(this.home).readSession(
                binding.session_id
            ));
        if (
            receipt &&
            (receipt.repository.toLowerCase() !==
                `${binding.owner}/${binding.name}`.toLowerCase() ||
                receipt.revision !== binding.revision ||
                receipt.base_branch !== binding.base_branch)
        )
            throw new Error('GitHub receipt has different repository provenance');
        const checkout = new RepositoryWorkspace(this.home, binding, this.environment)
            .directory;
        return {
            run,
            binding,
            receipt,
            ...(native ? { native_pull: native.pull } : {}),
            checkout,
            workspace:
                run.runtime === 'docker' || run.runtime === 'e2b'
                    ? '/workspace'
                    : checkout,
        };
    }

    async checks(): Promise<RepositoryCheckReport> {
        return (await this.reader()).read();
    }

    async logs(jobId: number): Promise<RepositoryLog> {
        return (await this.reader()).logs(jobId);
    }

    private async reader() {
        const { binding, native_pull } = await this.load();
        const github =
            this.github ??
            (await RepositoryGitHub.forEnvironment(this.environment, true));
        return new RepositoryChecks(
            binding,
            new RepositoryDeliveryStore(this.home),
            github,
            native_pull
        );
    }

    private async nativePull(
        current: Awaited<ReturnType<RunStore['read']>>,
        binding: RepositoryBinding
    ): Promise<
        | {
              pull: { number: number; url: string };
              receipt: RepositoryDeliveryReceipt;
          }
        | undefined
    > {
        const runs = new RunStore(this.home);
        const outcomes = new OutcomeStore(this.home);
        const seen = new Set<string>();
        let run: typeof current | undefined = current;
        try {
            while (run && !seen.has(run.id)) {
                seen.add(run.id);
                if (run.outcome_id) {
                    const outcome = await outcomes.read(run.outcome_id);
                    for (const link of outcome.links.toReversed()) {
                        if (link.kind !== 'pull_request') continue;
                        const pull = parsePullLink(link.uri, binding);
                        if (!pull) continue;
                        const github =
                            this.github ??
                            (await RepositoryGitHub.forEnvironment(this.environment));
                        const details = await github.request<{
                            number: number;
                            html_url: string;
                            head: { sha: string; ref: string };
                            base: { ref: string };
                        }>(binding.owner, binding.name, `/pulls/${pull.number}`);
                        if (
                            details.number !== pull.number ||
                            details.html_url !== pull.url ||
                            details.base.ref !== binding.base_branch
                        )
                            throw new Error(
                                'The recorded PR does not match this repository session'
                            );
                        return {
                            pull,
                            receipt: {
                                version: 1,
                                run_id: run.id,
                                session_id: binding.session_id,
                                outcome_id: outcome.id,
                                repository: `${binding.owner}/${binding.name}`,
                                revision: binding.revision,
                                branch: details.head.ref,
                                base_branch: details.base.ref,
                                created_at: outcome.created_at,
                                state: 'published',
                                commit: details.head.sha,
                                pull_request: pull,
                            },
                        };
                    }
                }
                run = run.resumed_from ? await runs.read(run.resumed_from) : undefined;
            }
            return undefined;
        } finally {
            await outcomes.close();
        }
    }
}

function parsePullLink(
    value: string,
    binding: RepositoryBinding
): { number: number; url: string } | undefined {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    if (
        url.protocol !== 'https:' ||
        url.hostname !== 'github.com' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (
        parts.length !== 4 ||
        parts[0]?.toLowerCase() !== binding.owner.toLowerCase() ||
        parts[1]?.toLowerCase() !== binding.name.toLowerCase() ||
        parts[2] !== 'pull' ||
        !/^[1-9][0-9]*$/.test(parts[3] ?? '')
    )
        return undefined;
    const number = Number(parts[3]);
    return Number.isSafeInteger(number) ? { number, url: value } : undefined;
}
