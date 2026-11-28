import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRunAdmission } from '../../src/workers/admission.js';
import { WorkerAssignments } from '../../src/workers/assignments.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerLog } from '../../src/workers/log.js';
import { parseServerMessage } from '../../src/workers/protocol.js';
import { WorkerEventStream } from '../../src/workers/stream.js';
import { WorkerRunTracker } from '../../src/workers/tracker.js';
import { FakeRunHost, runStart } from './fixture.js';

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-liveness-'));
    directories.push(directory);
    const home = new WorkerHome(directory);
    const assignments = new WorkerAssignments(home);
    const host = new FakeRunHost();
    let now = 0;
    const log = new WorkerLog(home, 'test');
    const admission = new WorkerRunAdmission({
        home,
        assignments,
        host,
        log,
        settings: { slots: 1, runtimes: ['docker', 'local'] },
        now: () => new Date(now),
        send: () => true,
        stopping: () => false,
        changed: () => {},
    });
    const tracker = new WorkerRunTracker(
        assignments,
        host,
        { uploadOutcome: async () => true },
        log,
        () => new Date(now),
        admission
    );
    const start = parseServerMessage(JSON.stringify(runStart({ max_minutes: 2 })));
    if (start?.type !== 'run.start') throw new Error('Missing start');
    return {
        assignments,
        host,
        admission,
        tracker,
        start,
        advance: (milliseconds: number) => {
            now += milliseconds;
        },
    };
}

test('a never finishing launch fails at max_minutes naming its step and cleans up', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    let process = true;
    let container = true;
    f.host.launch = async (_start, launch) => {
        launch.step('checking the docker runtime');
        launch.signal.addEventListener(
            'abort',
            () => {
                process = false;
                container = false;
            },
            { once: true }
        );
        entered.resolve();
        return new Promise(() => {});
    };
    const starting = f.admission.start(f.start);
    await entered.promise;
    f.advance(120_000);
    await f.tracker.observe();
    await starting;
    expect(f.assignments.get(f.start.run_id)).toMatchObject({
        state: 'failed',
        failure:
            'The run did not start within 2 minutes. It was checking the docker runtime.',
    });
    expect(process).toBe(false);
    expect(container).toBe(false);
    expect(f.host.released).toContain(f.start.run_id);
});

test('a started docker run whose container disappears fails after the grace, looked for every 15 seconds', async () => {
    const f = await fixture();
    await f.admission.start(f.start);
    const sent: string[] = [];
    const stream = new WorkerEventStream(f.assignments, f.host, (message) => {
        if (message.type === 'events')
            sent.push(...message.events.map((event) => event.type));
        return true;
    });
    let checks = 0;
    f.host.containerExists = async () => {
        checks++;
        return false;
    };
    await f.tracker.observe();
    await f.tracker.observe();
    expect(checks).toBe(1);
    await stream.flush();
    f.advance(59_999);
    await f.tracker.observe();
    expect(f.assignments.get(f.start.run_id)?.state).toBe('running');
    f.advance(15_000);
    await f.tracker.observe();
    expect(f.assignments.get(f.start.run_id)).toMatchObject({
        state: 'failed',
        failure: "The run's container is gone",
    });
    expect(await f.host.active('wb_run1session')).toBe(false);
    await stream.flush();
    expect(sent).toContain('run.failed');
});

test('a docker check that times out changes nothing', async () => {
    const f = await fixture();
    await f.admission.start(f.start);
    f.host.containerExists = async () => false;
    await f.tracker.observe();
    f.advance(60_000);
    f.host.containerExists = async () => {
        throw new DOMException('Timed out', 'TimeoutError');
    };
    await f.tracker.observe();
    expect(f.assignments.get(f.start.run_id)?.state).toBe('running');
    expect(await f.host.active('wb_run1session')).toBe(true);
});

test('a present container resets the grace and local runs never probe Docker', async () => {
    const f = await fixture();
    await f.admission.start({ ...f.start, max_minutes: 60 });
    f.host.containerExists = async () => false;
    await f.tracker.observe();
    f.advance(60_000);
    f.host.containerExists = async () => true;
    await f.tracker.observe();
    f.host.containerExists = async () => false;
    await f.tracker.observe();
    expect(f.assignments.get(f.start.run_id)?.state).toBe('running');
    f.advance(59_999);
    await f.tracker.observe();
    expect(f.assignments.get(f.start.run_id)?.state).toBe('running');
    const assignment = f.assignments.get(f.start.run_id);
    if (!assignment) throw new Error('Missing assignment');
    assignment.runtime = 'local';
    let probes = 0;
    f.host.containerExists = async () => {
        probes++;
        return false;
    };
    f.advance(60_000);
    await f.tracker.observe();
    expect(probes).toBe(0);
    expect(assignment.state).toBe('running');
});
