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

/**
 * How long a snapshot may take to become active. A cold pull of a large image
 * takes minutes, far longer than a sandbox from an active snapshot takes to
 * start, so this is separate from the sandbox start limit.
 */
const snapshotTimeoutMs = 30 * 60_000;
const pollIntervalMs = 3_000;
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
                (await this.client.createSnapshot({
                    name,
                    image: pinnedImage(image, digest),
                    resources,
                }));
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
                    await this.client.activateSnapshot(name);
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

    private error(message: string): RuntimeError {
        return new RuntimeError('daytona', 'prepare', message);
    }
}

function reason(snapshot: DaytonaSnapshot): string {
    return snapshot.errorReason ? `: ${snapshot.errorReason}` : '';
}
