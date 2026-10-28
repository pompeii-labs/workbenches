import { password } from '@clack/prompts';

import { connectionHarnesses } from '../connections/targets.js';
import { ModelCatalog } from '../models/catalog.js';
import { RegistryAccountStore } from '../registry/account-store.js';
import { RegistryClient } from '../registry/client.js';
import { RunnerRegistry } from '../runners/registry.js';
import { workbenchHome } from '../storage.js';
import { WorkerApi } from '../workers/api.js';
import { WorkerConnect, type WorkerConnectTerminal } from '../workers/connect.js';
import { selectConnectionTarget } from './connectiontarget.js';
import type { CliPresenter } from './presenter.js';

/**
 * `wb connect --worker`: connects a runner on a worker for the person's own
 * runs there. It asks the provider and method questions `wb connect` asks for
 * this machine, and works from any machine logged in to the worker's
 * organization; the runner need not be installed here. Only the choice
 * reaches the worker, which runs the sign-in or takes the key, and keeps the
 * credential.
 */
export async function connectWorker(
    request: {
        worker: string;
        runner: string | undefined;
        provider?: string;
        method?: string;
    },
    output: CliPresenter
): Promise<void> {
    const { worker, runner } = request;
    const runners = RunnerRegistry.standard();
    const harnesses = connectionHarnesses(runners);
    if (!runner || !harnesses.includes(runner))
        throw new Error(
            `Name the runner to connect: wb connect --worker ${worker} ${harnesses.join(', ')}`
        );
    await new ModelCatalog({ home: workbenchHome() }).refresh();
    // The runner signs in on the worker's own machine, so these are the questions for `local`.
    const { provider, method } = await selectConnectionTarget(
        {
            runtime: 'local',
            harness: runner,
            ...(request.provider ? { provider: request.provider } : {}),
            ...(request.method ? { method: request.method } : {}),
        },
        true,
        runners
    );
    if (!method) throw new Error('An authentication method must be selected');
    if (!process.stdin.isTTY || !process.stderr.isTTY)
        throw new Error(
            `Run wb connect --worker ${worker} ${runner} in a terminal, to answer the worker`
        );
    const account = await new RegistryAccountStore().require();
    output.message(`Connecting ${runner} on ${worker}`, 'info');
    const result = await new WorkerConnect({
        api: new WorkerApi(RegistryClient.configuredApiUrl()),
        login: account.token,
        worker,
        runner,
        provider,
        method: method.id,
        terminal: processTerminal,
    }).run();
    output.message(result.message, 'success');
}

/**
 * Turns off what a sign-in on another machine may have left on in this
 * terminal when its last output did not arrive: bracketed paste, focus and
 * mouse reporting, and a hidden cursor. Bracketed paste left on would wrap
 * what is pasted next in markers.
 */
const TERMINAL_RESET =
    '\u001b[?2004l\u001b[?1004l\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l\u001b[?25h';

/**
 * This process's terminal for a sign-in on a worker. While attached it is in
 * raw mode, so every key, Ctrl-C included, goes to the sign-in as it would
 * if the sign-in ran here.
 */
const processTerminal: WorkerConnectTerminal = {
    size: () => ({
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
    }),
    attach(input, resized) {
        const typed = (chunk: Buffer) => input(chunk);
        process.stdin.setRawMode(true);
        process.stdin.on('data', typed);
        process.stdin.resume();
        process.stdout.on('resize', resized);
        return () => {
            process.stdout.off('resize', resized);
            process.stdin.off('data', typed);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write(TERMINAL_RESET);
        };
    },
    write: (data) => {
        process.stdout.write(data);
    },
    // A pasted key or token is a secret, so it is never echoed.
    secret: async (message) => {
        const entered = await password({
            message,
            validate: (value) =>
                value?.trim() ? undefined : 'Paste it, or press Ctrl-C to stop',
        });
        return typeof entered === 'string' ? entered.trim() : undefined;
    },
};
