import { describe, expect, test } from 'bun:test';

import type {
    DaytonaSnapshot,
    DaytonaSnapshotOptions,
} from '../../../src/runtimes/daytona/contracts.js';
import {
    daytonaSnapshotName,
    SandboxSnapshot,
} from '../../../src/runtimes/daytona/snapshots.js';
import { FakeClient, FakeClock, fakeDigest } from './fixture.js';

const image = 'ghcr.io/example/workbench:1.0.0';
const requirements = { gpu: false };
const name = daytonaSnapshotName(fakeDigest, { cpu: 2, memoryGb: 4 });

/** A clock whose time moves forward by every delay it is asked to wait. */
class AdvancingClock extends FakeClock {
    override async sleep(milliseconds: number): Promise<void> {
        await super.sleep(milliseconds);
        this.time = new Date(this.time.getTime() + milliseconds);
    }
}

function prepare(client: FakeClient, clock = new AdvancingClock()) {
    return {
        clock,
        ready: new SandboxSnapshot(client, clock).ready(image, requirements),
    };
}

function existing(client: FakeClient, snapshot: Partial<DaytonaSnapshot>): void {
    client.snapshots.set(name, {
        name,
        id: 'snapshot-old',
        state: 'active',
        ...snapshot,
    });
}

describe('SandboxSnapshot', () => {
    test('uses an active snapshot without creating one', async () => {
        const client = new FakeClient();
        existing(client, { state: 'active' });
        const { clock, ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.digestRequests).toEqual([image]);
        expect(client.snapshotOptions).toEqual([]);
        expect(clock.delays).toEqual([]);
    });

    test('creates a missing snapshot from the pinned image and waits until it is active', async () => {
        const client = new FakeClient();
        client.createdSnapshotState = 'pending';
        client.snapshotProgress = [
            { state: 'pulling' },
            { state: 'building' },
            { state: 'active' },
        ];
        const { clock, ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.snapshotOptions).toEqual([
            {
                name,
                image: `ghcr.io/example/workbench@${fakeDigest}`,
                resources: { cpu: 2, memoryGb: 4 },
            },
        ]);
        expect(clock.delays).toHaveLength(3);
        expect(client.deletedSnapshots).toEqual([]);
    });

    test('waits on a snapshot in progress and never deletes it, even when the wait runs out', async () => {
        const client = new FakeClient();
        existing(client, { state: 'pulling' });
        const { clock, ready } = prepare(client);
        await expect(ready).rejects.toMatchObject({
            name: 'RuntimeError',
            runtime: 'daytona',
            message: `Daytona snapshot ${name} of image ${image} was not ready within 30 minutes (state: pulling). It is left to finish for a later run.`,
        });
        expect(clock.delays.reduce((total, delay) => total + delay, 0)).toBe(
            30 * 60_000
        );
        expect(client.deletedSnapshots).toEqual([]);
        expect(client.snapshotOptions).toEqual([]);
        expect(client.snapshots.get(name)?.state).toBe('pulling');
    });

    test('deletes a failed snapshot and makes it again once', async () => {
        const client = new FakeClient();
        existing(client, {
            state: 'build_failed',
            errorReason: 'Image processing cancelled',
        });
        client.createdSnapshotState = 'pending';
        client.snapshotProgress = [{}, { state: 'active' }];
        const { ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.deletedSnapshots).toEqual([name]);
        expect(client.snapshotOptions).toHaveLength(1);
        expect(client.snapshots.get(name)?.id).toBe('snapshot-1');
    });

    test("fails with Daytona's reason when the snapshot fails a second time", async () => {
        const client = new FakeClient();
        existing(client, { state: 'error', errorReason: 'Image processing cancelled' });
        client.createdSnapshotState = 'pending';
        client.snapshotProgress = [
            {},
            { state: 'build_failed', errorReason: 'manifest unknown' },
        ];
        const { ready } = prepare(client);
        await expect(ready).rejects.toMatchObject({
            name: 'RuntimeError',
            message: `Daytona snapshot ${name} of image ${image} failed again with state build_failed: manifest unknown`,
        });
        expect(client.deletedSnapshots).toEqual([name]);
        expect(client.snapshotOptions).toHaveLength(1);
    });

    test('waits for a deleted snapshot to be removed before making it again', async () => {
        const client = new RemovingClient();
        existing(client, { state: 'error' });
        const { clock, ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.deletedSnapshots).toEqual([name]);
        expect(client.snapshotOptions).toHaveLength(1);
        expect(clock.delays).toHaveLength(1);
    });

    test('joins the snapshot another run created first', async () => {
        const client = new RacedClient();
        client.snapshotProgress = [{ state: 'active' }];
        const { ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.snapshotOptions).toHaveLength(1);
        expect(client.snapshots.get(name)?.id).toBe('snapshot-other-run');
        expect(client.deletedSnapshots).toEqual([]);
    });

    test('fails on a state it does not know without deleting the snapshot', async () => {
        const client = new FakeClient();
        existing(client, { state: 'unknown-state' });
        await expect(prepare(client).ready).rejects.toThrow(
            `Daytona snapshot ${name} of image ${image} is unknown-state`
        );
        expect(client.deletedSnapshots).toEqual([]);
    });

    test('activates an inactive snapshot once and waits until it is active', async () => {
        const client = new FakeClient();
        existing(client, { state: 'inactive' });
        client.snapshotProgress = [
            {},
            { state: 'inactive' },
            { state: 'snapshotting' },
            { state: 'active' },
        ];
        const { ready } = prepare(client);
        expect(await ready).toBe(name);
        expect(client.activatedSnapshots).toEqual([name]);
        expect(client.deletedSnapshots).toEqual([]);
        expect(client.snapshotOptions).toEqual([]);
    });

    test('refuses a digest that is not a sha256 digest', async () => {
        const client = new FakeClient();
        await expect(
            new SandboxSnapshot(client, new AdvancingClock()).ready(
                'ghcr.io/example/workbench@md5:abc',
                requirements
            )
        ).rejects.toThrow(
            'Daytona image ghcr.io/example/workbench@md5:abc resolved to an invalid digest'
        );
        expect(client.snapshotOptions).toEqual([]);
    });
});

describe('daytonaSnapshotName', () => {
    const resources = { cpu: 2, memoryGb: 4, diskGb: 10 };

    test('is short, Daytona-safe, and the same for the same image and resources', () => {
        const value = daytonaSnapshotName(fakeDigest, resources);
        expect(value).toMatch(/^wb-[a-f0-9]{32}$/);
        expect(daytonaSnapshotName(fakeDigest, { ...resources })).toBe(value);
    });

    test('changes when the digest or any resource changes', () => {
        const names = [
            daytonaSnapshotName(fakeDigest, resources),
            daytonaSnapshotName(`sha256:${'e'.repeat(64)}`, resources),
            daytonaSnapshotName(fakeDigest, { ...resources, cpu: 4 }),
            daytonaSnapshotName(fakeDigest, { ...resources, memoryGb: 8 }),
            daytonaSnapshotName(fakeDigest, { ...resources, diskGb: 20 }),
            daytonaSnapshotName(fakeDigest, { cpu: 2, memoryGb: 4 }),
        ];
        expect(new Set(names).size).toBe(names.length);
    });
});

/** Reports a deleted snapshot as removing on the next lookup, then as gone. */
class RemovingClient extends FakeClient {
    override async deleteSnapshot(name: string): Promise<void> {
        this.deletedSnapshots.push(name);
        const snapshot = this.snapshots.get(name);
        if (snapshot) snapshot.state = 'removing';
        this.snapshotProgress = [{}];
    }

    override async getSnapshot(name: string): Promise<DaytonaSnapshot | undefined> {
        const snapshot = await super.getSnapshot(name);
        if (snapshot?.state === 'removing' && this.snapshotProgress.length === 0) {
            this.snapshots.delete(name);
        }
        return snapshot;
    }
}

/** Another run creates the snapshot between this run's lookup and its create. */
class RacedClient extends FakeClient {
    override async createSnapshot(
        options: DaytonaSnapshotOptions
    ): Promise<DaytonaSnapshot> {
        if (!this.snapshots.has(options.name)) {
            this.snapshots.set(options.name, {
                name: options.name,
                id: 'snapshot-other-run',
                state: 'pulling',
            });
        }
        return super.createSnapshot(options);
    }
}
