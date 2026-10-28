import { open, stat } from 'node:fs/promises';

import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/account-store.js';
import {
    workerStartedLine,
    workerStatusLines,
    workerWaitingLine,
} from '../rendering/worker.js';
import { workbenchHome } from '../storage.js';
import { WorkerController } from '../workers/controller.js';
import { WorkerGit } from '../workers/git.js';
import { CliPresenter } from './presenter.js';

const startCommand = defineCommand({
    meta: {
        name: 'start',
        description:
            'Start the worker as a background service, registering this machine first.',
    },
    args: {
        name: {
            type: 'string',
            description: 'Worker name, to register this machine',
        },
        org: {
            type: 'string',
            description: 'Organization to register with (defaults to your default)',
        },
        runtimes: {
            type: 'string',
            description:
                'Offer only these runtimes: docker, local, or docker,local (default all this machine can run)',
        },
        slots: { type: 'string', description: 'Runs to take at once (default 1)' },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const controller = new WorkerController(workbenchHome());
        const registration = await controller
            .registration()
            .ensure(args.name, () => new RegistryAccountStore().require(args.org));
        const settings = await controller.settings({
            ...(args.runtimes ? { runtimes: args.runtimes } : {}),
            ...(args.slots ? { slots: args.slots } : {}),
        });
        if (!(await new WorkerGit().usable()))
            output.message(
                'git is not installed, so this worker refuses repository runs.',
                'warning',
                'stderr'
            );
        output.progress(`Starting worker ${registration.name}`);
        const started = await controller.start(settings);
        output.message(
            workerStartedLine(
                registration,
                { runtimes: started.offer.runtimes, slots: settings.slots },
                started.online
            ),
            started.online ? 'success' : 'info'
        );
    },
});

const statusCommand = defineCommand({
    meta: {
        name: 'status',
        description: 'Show whether the worker is online and what it runs.',
    },
    args: {
        json: { type: 'boolean', description: 'Print JSON', default: false },
    },
    async run({ args }) {
        const status = await new WorkerController(workbenchHome()).status();
        if (args.json) {
            process.stdout.write(`${JSON.stringify(status)}\n`);
            return;
        }
        const output = new CliPresenter();
        const [header, ...lines] = workerStatusLines(status, new Date());
        output.message(
            header ?? '',
            !status.registered ? 'muted' : status.online ? 'success' : 'warning'
        );
        for (const line of lines) output.text(line);
    },
});

const logsCommand = defineCommand({
    meta: { name: 'logs', description: 'Print the worker lifecycle log.' },
    args: {
        follow: {
            type: 'boolean',
            alias: 'f',
            description: 'Keep printing new lines',
            default: false,
        },
    },
    async run({ args }) {
        const path = new WorkerController(workbenchHome()).home.logPath;
        let offset = await print(path, 0);
        if (!args.follow) return;
        let stopped = false;
        process.once('SIGINT', () => {
            stopped = true;
        });
        while (!stopped) {
            await Bun.sleep(500);
            offset = await print(path, offset);
        }
    },
});

const stopCommand = defineCommand({
    meta: {
        name: 'stop',
        description: 'Stop the worker after its runs finish, or now.',
    },
    args: {
        now: {
            type: 'boolean',
            description: 'Cancel running runs and stop now',
            default: false,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const controller = new WorkerController(workbenchHome());
        const registration = await controller.home.requireRegistration();
        const mode = args.now ? 'now' : 'drain';
        await controller.stop(mode, (runs) =>
            output.message(
                workerWaitingLine(registration.name, runs, mode),
                'info',
                'stderr'
            )
        );
        output.message(`Worker ${registration.name} stopped.`, 'success');
    },
});

const removeCommand = defineCommand({
    meta: {
        name: 'remove',
        description: 'Stop the worker, revoke its key, and forget it on this machine.',
    },
    args: {
        now: {
            type: 'boolean',
            description: 'Cancel running runs instead of waiting',
            default: false,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const controller = new WorkerController(workbenchHome());
        const registration = await controller.home.requireRegistration();
        const mode = args.now ? 'now' : 'drain';
        const name = await controller.remove(mode, (runs) =>
            output.message(
                workerWaitingLine(registration.name, runs, mode),
                'info',
                'stderr'
            )
        );
        output.message(`Worker ${name} removed. Its key is revoked.`, 'success');
    },
});

export const workerCommand = defineCommand({
    meta: {
        name: 'worker',
        description:
            'Run your workbenches.dev runs on this machine as a self-hosted worker.',
    },
    subCommands: {
        start: startCommand,
        status: statusCommand,
        logs: logsCommand,
        stop: stopCommand,
        remove: removeCommand,
    },
});

/** Prints the log from `offset` and returns the new end. */
async function print(path: string, offset: number): Promise<number> {
    const size = await stat(path).then(
        (info) => info.size,
        () => 0
    );
    if (size <= offset) return size < offset ? 0 : offset;
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(size - offset);
        await file.read(buffer, 0, buffer.length, offset);
        process.stdout.write(buffer);
    } finally {
        await file.close();
    }
    return size;
}
