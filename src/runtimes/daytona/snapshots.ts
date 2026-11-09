import { createHash } from 'node:crypto';
import type { requirementsOf } from '../../workbench/runtimes.js';
import { RuntimeError } from '../error.js';
import type {
    DaytonaClient,
    DaytonaClock,
    DaytonaResources,
    DaytonaSnapshot,
} from './contracts.js';
import { pinnedImage } from './digests.js';
import { daytonaResources } from './resources.js';
import {
    DaytonaSnapshotCooldownError,
    DaytonaSnapshotLimitError,
} from './transport.js';

/**
 * How long a snapshot may take to become active. A cold pull of a large image
 * takes minutes, far longer than a sandbox from an active snapshot takes to
 * start, so this is separate from the sandbox start limit.
 */
const snapshotTimeoutMs = 30 * 60_000;
const pollIntervalMs = 3_000;
/**
 * How long a snapshot must go unused before it may be deactivated to make
 * room. Daytona refuses to activate a snapshot for a while after it is
 * deactivated, so one in recent use is never chosen.
 */
const idleBeforeDeactivationMs = 24 * 60 * 60_000;
/** The names `daytonaSnapshotName` gives, so only the engine's snapshots are deactivated. */
const engineSnapshot = /^wb-[a-f0-9]{32}$/;
const pending = new Set(['pending', 'pulling', 'building', 'snapshotting', 'removing']);
const failed = new Set(['error', 'build_failed']);

/**
 * The Daytona snapshot name for an image digest and sandbox resources. The
 * same image and resources give the same name in every run and every
 * Workbench, so they share one snapshot.
 */
export function daytonaSnapshotName(
    digestReference: string,
    resources: DaytonaResources
): string {
    const identity = JSON.stringify([
        digestReference,
        resources.cpu ?? null,
        resources.memoryGb ?? null,
        resources.diskGb ?? null,
    ]);
    return `wb-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

/**
 * Gets the shared snapshot a sandbox starts from ready: used when active,
 * created when missing, and waited on while Daytona makes it. A failed
 * snapshot is deleted and made again once. A snapshot in progress is never
 * deleted, even when the wait runs out, because finishing it serves the next
 * run; a run that finds another run's snapshot in progress waits on it.
 *
 * Daytona caps how many usable snapshots an organization holds. At the cap,
 * the engine's least recently used snapshot that has gone a day unused is
 * deactivated to make room, and is activated again by the next run that
 * needs it. Snapshots are never deleted to make room. A run that needs a
 * snapshot Daytona deactivated minutes ago fails at once, because Daytona
 * will not activate it again yet.
 */
export class SandboxSnapshot {
    constructor(
        private readonly client: DaytonaClient,
        private readonly clock: DaytonaClock
    ) {}

    /** The name of an active snapshot of `image` with the resources `requirements` ask for. */
    async ready(
        image: string,
        requirements: ReturnType<typeof requirementsOf>
    ): Promise<string> {
        const resources = daytonaResources(requirements);
        const digest = await this.client.imageDigest(image);
        if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
            throw this.error(`Daytona image ${image} resolved to an invalid digest`);
        }
        const name = daytonaSnapshotName(digest, resources);
        const deadline = this.clock.now().getTime() + snapshotTimeoutMs;
        // The failed snapshot this run deleted, which may still be reported while it is removed.
        let retired: string | undefined;
        let activated = false;
        for (;;) {
            const snapshot: DaytonaSnapshot =
                (await this.client.getSnapshot(name)) ??
                (await this.withRoom(name, () =>
                    this.client.createSnapshot({
                        name,
                        image: pinnedImage(image, digest),
                        resources,
                    })
                ));
            const removing = snapshot.id === retired;
            if (snapshot.state === 'active' && !removing) return name;
            if (failed.has(snapshot.state) && !removing) {
                if (retired) {
                    throw this.error(
                        `Daytona snapshot ${name} of image ${image} failed again with state ${snapshot.state}${reason(snapshot)}`
                    );
                }
                retired = snapshot.id;
                await this.client.deleteSnapshot(name);
                continue;
            }
            // Daytona sets an unused snapshot inactive. Activating it again is
            // asked once; until it is active it is waited on like one in progress.
            if (snapshot.state === 'inactive' && !removing) {
                if (!activated) {
                    activated = true;
                    await this.activate(name, image);
                    continue;
                }
            } else if (!removing && !pending.has(snapshot.state)) {
                throw this.error(
                    `Daytona snapshot ${name} of image ${image} is ${snapshot.state}${reason(snapshot)}`
                );
            }
            if (this.clock.now().getTime() >= deadline) {
                throw this.error(
                    `Daytona snapshot ${name} of image ${image} was not ready within ${snapshotTimeoutMs / 60_000} minutes (state: ${snapshot.state}). It is left to finish for a later run.`
                );
            }
            await this.clock.sleep(pollIntervalMs);
        }
    }

    /**
     * Asks Daytona to activate `name`. Daytona refuses for a few minutes after
     * a snapshot is deactivated, and the run fails at once rather than waiting
     * that out.
     */
    private async activate(name: string, image: string): Promise<void> {
        try {
            await this.withRoom(name, () => this.client.activateSnapshot(name));
        } catch (error) {
            if (!(error instanceof DaytonaSnapshotCooldownError)) throw error;
            throw this.error(
                `Daytona snapshot ${name} of image ${image} was deactivated a few minutes ago, and Daytona will not activate it again yet. Run again in a few minutes: ${error.message}`
            );
        }
    }

    /**
     * Runs `attempt`, and when Daytona refuses it for the snapshot limit,
     * deactivates one idle engine snapshot other than `name` and runs it once more.
     */
    private async withRoom<T>(name: string, attempt: () => Promise<T>): Promise<T> {
        try {
            return await attempt();
        } catch (error) {
            if (!(error instanceof DaytonaSnapshotLimitError)) throw error;
            const cutoff = this.clock.now().getTime() - idleBeforeDeactivationMs;
            const idle = (await this.client.listSnapshots()).find(
                (snapshot) =>
                    snapshot.name !== name &&
                    engineSnapshot.test(snapshot.name) &&
                    snapshot.state === 'active' &&
                    snapshot.lastUsedAt !== undefined &&
                    snapshot.lastUsedAt.getTime() < cutoff
            );
            if (!idle) {
                throw this.error(
                    `Daytona's snapshot limit is reached and every Workbench snapshot was used in the last day, so none was deactivated to make room for ${name}: ${error.message}`
                );
            }
            await this.client.deactivateSnapshot(idle.name);
            try {
                return await attempt();
            } catch (retry) {
                if (!(retry instanceof DaytonaSnapshotLimitError)) throw retry;
                throw this.error(
                    `Daytona's snapshot limit is still reached after deactivating ${idle.name} to make room for ${name}: ${retry.message}`
                );
            }
        }
    }

    private error(message: string): RuntimeError {
        return new RuntimeError('daytona', 'prepare', message);
    }
}

function reason(snapshot: DaytonaSnapshot): string {
    return snapshot.errorReason ? `: ${snapshot.errorReason}` : '';
}
