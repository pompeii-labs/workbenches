import { defineCommand } from 'citty';

import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import {
    DEFAULT_STUDIO_API_PORT,
    DEFAULT_STUDIO_IMAGE,
    DEFAULT_STUDIO_PORT,
    type StudioLifecycle,
    type StudioStatus,
} from '../studio/index.js';
import { Services } from '../workbench/services.js';

/** Runs one Studio lifecycle operation over this home's single connection. */
async function withLifecycle<T>(
    operation: (lifecycle: StudioLifecycle) => Promise<T> | T
): Promise<T> {
    const home = workbenchHome();
    const connection = Connection.open(home);
    try {
        return await operation(new Services(home, connection).studio.lifecycle);
    } finally {
        connection.close();
    }
}

const stopCommand = defineCommand({
    meta: { name: 'stop', description: 'Stop the local Studio.' },
    args: {
        json: { type: 'boolean', description: 'Print JSON', default: false },
    },
    async run({ args }) {
        render(await withLifecycle((lifecycle) => lifecycle.stop()), args.json);
    },
});

const statusCommand = defineCommand({
    meta: { name: 'status', description: 'Show local Studio status.' },
    args: {
        json: { type: 'boolean', description: 'Print JSON', default: false },
    },
    async run({ args }) {
        render(await withLifecycle((lifecycle) => lifecycle.status()), args.json);
    },
});

export const studioCommand = defineCommand({
    meta: { name: 'studio', description: 'Start the local Workbench Studio.' },
    args: {
        image: {
            type: 'string',
            description: 'Studio image',
            default: DEFAULT_STUDIO_IMAGE,
        },
        port: {
            type: 'string',
            description: 'Loopback UI port',
            default: String(DEFAULT_STUDIO_PORT),
        },
        'api-port': {
            type: 'string',
            description: 'Loopback API port',
            default: String(DEFAULT_STUDIO_API_PORT),
        },
        open: {
            type: 'boolean',
            description: 'Open Studio in the browser',
            negativeDescription: 'Do not open Studio in the browser',
            default: true,
        },
        json: { type: 'boolean', description: 'Print JSON', default: false },
    },
    subCommands: { stop: stopCommand, status: statusCommand },
    async run({ args, rawArgs }) {
        if (rawArgs.includes('stop') || rawArgs.includes('status')) return;
        const port = Number(args.port);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
            throw new Error('--port must be an integer from 1 to 65535');
        const apiPort = Number(args['api-port']);
        if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65_535)
            throw new Error('--api-port must be an integer from 1 to 65535');
        render(
            await withLifecycle((lifecycle) =>
                lifecycle.start({
                    image: args.image,
                    uiPort: port,
                    apiPort,
                    open: args.open,
                })
            ),
            args.json
        );
    },
});

function render(result: StudioStatus, machine: boolean): void {
    if (machine) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (!result.running || !result.url) {
        process.stdout.write('Workbench Studio is stopped.\n');
        return;
    }
    process.stdout.write(`Workbench Studio: ${result.url}\n`);
    if (result.open_url)
        process.stdout.write(
            `Open link (works once, within 5 minutes): ${result.open_url}\n`
        );
}
