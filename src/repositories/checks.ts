import type { RepositoryBinding } from './contracts.js';
import type { RepositoryGitHub } from './github.js';
import type { RepositoryDeliveryStore } from './receipts.js';

interface Pull {
    number: number;
    html_url: string;
    state: string;
    merged: boolean;
    draft?: boolean;
    head: { sha: string; ref: string; repo: { full_name: string } };
    base: { ref: string; repo?: { full_name: string } };
}
interface Workflow {
    id: number;
    workflow_id: number;
    head_sha: string;
    head_branch: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    name: string;
}
interface Job {
    id: number;
    run_id: number;
    head_sha: string;
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    steps?: Array<{ name: string; status: string; conclusion: string | null }>;
}

/** Reads a confirmed PR's observed head and its current CI state. */
export class RepositoryChecks {
    constructor(
        private readonly binding: RepositoryBinding,
        private readonly receipts: RepositoryDeliveryStore,
        private readonly github: RepositoryGitHub,
        private readonly native?: { number: number; url: string }
    ) {}

    private request<T>(path: string): Promise<T> {
        return this.github.request<T>(this.binding.owner, this.binding.name, path);
    }

    async pull() {
        if (this.native) {
            const pull = await this.request<Pull>(`/pulls/${this.native.number}`);
            if (
                pull.number !== this.native.number ||
                pull.html_url !== this.native.url ||
                pull.base?.ref !== this.binding.base_branch ||
                (pull.base.repo?.full_name &&
                    pull.base.repo.full_name.toLowerCase() !==
                        `${this.binding.owner}/${this.binding.name}`.toLowerCase())
            )
                throw new Error(
                    'The recorded PR no longer matches this repository session'
                );
            return {
                number: pull.number,
                url: pull.html_url,
                head: pull.head.sha,
                branch: pull.head.ref,
                state: pull.state,
                merged: pull.merged,
                draft: pull.draft === true,
            };
        }
        const receipt = await this.receipts.readSession(this.binding.session_id);
        if (!receipt?.pull_request || receipt.state !== 'published' || !receipt.commit)
            throw new Error('This session has no confirmed published PR');
        const pull = await this.request<Pull>(`/pulls/${receipt.pull_request.number}`);
        if (
            pull.number !== receipt.pull_request.number ||
            pull.head?.ref !== receipt.branch ||
            pull.head.sha !== receipt.commit ||
            pull.base?.ref !== this.binding.base_branch ||
            pull.head.repo?.full_name.toLowerCase() !==
                `${this.binding.owner}/${this.binding.name}`.toLowerCase() ||
            pull.html_url !== receipt.pull_request.url
        )
            throw new Error(
                'The session PR changed outside this session; refusing to operate on a different branch or commit'
            );
        return {
            number: pull.number,
            url: pull.html_url,
            head: pull.head.sha,
            branch: pull.head.ref,
            state: pull.state,
            merged: pull.merged,
            draft: pull.draft === true,
        };
    }

    async read() {
        const pull = await this.pull();
        const [checks, statuses, workflows] = await Promise.all([
            this.request<{
                total_count: number;
                check_runs: Array<{
                    id: number;
                    name: string;
                    head_sha: string;
                    status: string;
                    conclusion: string | null;
                    details_url: string | null;
                    output?: { title?: string; summary?: string };
                }>;
            }>(`/commits/${pull.head}/check-runs?per_page=100`),
            this.request<{
                total_count: number;
                statuses: Array<{
                    context: string;
                    state: string;
                    description: string | null;
                    target_url: string | null;
                }>;
            }>(`/commits/${pull.head}/status?per_page=100`),
            this.request<{ total_count: number; workflow_runs: Workflow[] }>(
                `/actions/runs?head_sha=${pull.head}&per_page=100`
            ),
        ]);
        const latest = new Map<number, Workflow>();
        for (const run of workflows.workflow_runs
            .filter(
                (run) => run.head_sha === pull.head && run.head_branch === pull.branch
            )
            .toSorted((left, right) => right.id - left.id)) {
            if (!latest.has(run.workflow_id)) latest.set(run.workflow_id, run);
        }
        const runs = [...latest.values()];
        const jobs: Job[] = [];
        let truncated =
            checks.total_count > 100 ||
            statuses.total_count > 100 ||
            workflows.total_count > 100;
        for (const run of runs.slice(0, 20)) {
            const result = await this.request<{ total_count: number; jobs: Job[] }>(
                `/actions/runs/${run.id}/jobs?per_page=100`
            );
            jobs.push(
                ...result.jobs.filter(
                    (job) => job.head_sha === pull.head && job.run_id === run.id
                )
            );
            truncated ||= result.total_count > 100;
        }
        truncated ||= runs.length > 20;
        const current = checks.check_runs.filter(
            (check) => check.head_sha === pull.head
        );
        const conclusions = [
            ...current.map((check) =>
                check.status === 'completed' ? check.conclusion : 'pending'
            ),
            ...statuses.statuses.map((status) => status.state),
            ...runs.map((run) =>
                run.status === 'completed' ? run.conclusion : 'pending'
            ),
        ];
        const state = conclusions.some((value) =>
            [
                'failure',
                'error',
                'cancelled',
                'timed_out',
                'action_required',
                'startup_failure',
            ].includes(value ?? '')
        )
            ? 'failed'
            : conclusions.some(
                    (value) => !['success', 'neutral', 'skipped'].includes(value ?? '')
                )
              ? 'pending'
              : !conclusions.length
                ? 'none'
                : truncated
                  ? 'incomplete'
                  : 'passed';
        return {
            pull_request: pull,
            state,
            truncated,
            checks: current.map((check) => ({
                id: check.id,
                name: check.name,
                status: check.status,
                conclusion: check.conclusion,
                url: check.details_url,
                ...(check.output
                    ? {
                          output: {
                              title: check.output.title?.slice(0, 1000),
                              summary: check.output.summary?.slice(0, 8000),
                          },
                      }
                    : {}),
            })),
            statuses: statuses.statuses,
            workflows: runs.slice(0, 20),
            jobs: jobs.map((job) => ({
                id: job.id,
                run_id: job.run_id,
                head_sha: job.head_sha,
                name: job.name,
                status: job.status,
                conclusion: job.conclusion,
                url: job.html_url,
                ...(job.steps ? { steps: job.steps.slice(0, 100) } : {}),
            })),
            ...(truncated
                ? {
                      warning:
                          'CI results exceed the bounded read limit; this is not a complete all-checks-passed result.',
                  }
                : {}),
        };
    }

    async logs(jobId: number) {
        const pull = await this.pull();
        const job = await this.request<Job>(`/actions/jobs/${jobId}`);
        const run = await this.request<Workflow>(`/actions/runs/${job.run_id}`);
        if (
            job.id !== jobId ||
            job.head_sha !== pull.head ||
            run.head_sha !== pull.head ||
            run.head_branch !== pull.branch
        )
            throw new Error(
                'CI job does not belong to this session PR and current commit'
            );
        const logs = await this.github.jobLogs(
            this.binding.owner,
            this.binding.name,
            jobId
        );
        return { pull_request: pull, job_id: jobId, name: job.name, ...logs };
    }
}
