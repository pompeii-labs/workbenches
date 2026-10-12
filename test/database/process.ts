/**
 * Child process used by the database tests. It runs in its own process so the
 * tests exercise real cross-process behavior: usage is
 * `bun process.ts <role> <home> [arguments]`.
 */
import { LeaseStore } from '../../src/database/leasestore.js';
import { WorkbenchDatabase } from '../../src/database/workbenchdatabase.js';
import { RunControl } from '../../src/runs/control.js';
import { RunStore } from '../../src/runs/store.js';

const [role, home, runId, extra] = process.argv.slice(2);
if (!role || !home) throw new Error('role and home are required');

if (role === 'append') {
    // Appends `count` events whose sequences do not overlap with other writers.
    const writer = Number(extra);
    const store = new RunStore(home);
    for (let index = 1; index <= 40; index += 1) {
        await store.appendEvent(runId ?? '', {
            protocol: 0,
            run_id: runId ?? '',
            sequence: writer * 1000 + index,
            timestamp: new Date().toISOString(),
            type: 'output.text',
            runner: 'opencode',
            data: { writer, index },
        });
    }
} else if (role === 'receive') {
    // Claims and resolves requests until it is killed, reporting each claim.
    const control = new RunControl(home, runId ?? '', { pollMilliseconds: 2 });
    for (;;) {
        const request = await control.receive();
        if (!request) break;
        process.stdout.write(`${request.id}\n`);
        await control.resolve(request, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
    }
} else if (role === 'hold') {
    // Takes a lease and exits without releasing it, as a crashed process would.
    const taken = new LeaseStore(WorkbenchDatabase.forHome(home)).tryAcquire(
        runId ?? 'crashed',
        'holder'
    );
    process.stdout.write(`${taken ? 'held' : 'busy'}\n`);
    process.exit(0);
} else if (role === 'open') {
    // Opens the home's database at an agreed instant so many processes contend for a new file.
    while (Date.now() < Number(extra)) {}
    WorkbenchDatabase.forHome(home);
    process.stdout.write('opened\n');
} else {
    throw new Error(`unknown role: ${role}`);
}
