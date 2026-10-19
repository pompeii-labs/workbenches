import type { StudioProject } from './contracts.js';

export function mergeCloudProject(
    local: StudioProject,
    cloud: Pick<
        StudioProject,
        'counts' | 'updated_at' | 'now' | 'waiting' | 'latest_done' | 'today'
    > | null
): StudioProject {
    if (!cloud) return local;
    const latestDone = [local.latest_done, cloud.latest_done]
        .filter(
            (value): value is NonNullable<StudioProject['latest_done']> =>
                value !== null
        )
        .toSorted((left, right) => right.at.localeCompare(left.at))[0];
    const costs = [local.today.cost_usd, cloud.today.cost_usd].filter(
        (value): value is number => value !== null
    );
    return {
        ...local,
        counts: {
            needs_you: local.counts.needs_you + cloud.counts.needs_you,
            running: local.counts.running + cloud.counts.running,
            done: local.counts.done + cloud.counts.done,
            failed: local.counts.failed + cloud.counts.failed,
        },
        updated_at:
            local.updated_at > cloud.updated_at ? local.updated_at : cloud.updated_at,
        now: [...local.now, ...cloud.now]
            .toSorted((left, right) => right.at.localeCompare(left.at))
            .slice(0, 3),
        waiting: [...local.waiting, ...cloud.waiting].toSorted((left, right) =>
            left.at.localeCompare(right.at)
        ),
        latest_done: latestDone ?? null,
        today: {
            runs: local.today.runs + cloud.today.runs,
            tokens: local.today.tokens + cloud.today.tokens,
            cost_usd: costs.length
                ? costs.reduce((sum, value) => sum + value, 0)
                : null,
        },
    };
}
