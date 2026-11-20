import { RegistryClient } from '../registry/client.js';
import { parseRepository } from '../repositories/index.js';

interface CloudRunArguments {
    workbench: string;
    json: boolean;
    final: boolean;
    detach: boolean;
    repo?: string | undefined;
    ref?: string | undefined;
    worker?: string | undefined;
    project?: string | undefined;
    'max-minutes'?: string | undefined;
    connection?: string | undefined;
}

export function cloudRunRequest(
    args: CloudRunArguments,
    rawArgs: string[]
): Record<string, unknown> {
    for (const name of [
        'dir',
        'workspace',
        'env',
        'env-file',
        'runtime',
        'dry-run',
        'allow-host-docker',
        'allow-unchecked-gpu',
    ]) {
        if (
            rawArgs.some(
                (value) => value === `--${name}` || value.startsWith(`--${name}=`)
            )
        )
            throw new Error(`--${name} cannot be used with --cloud`);
    }
    if (
        !RegistryClient.parseReference(args.workbench) &&
        !RegistryClient.parseVersionReference(args.workbench)
    )
        throw new Error(
            'Cloud runs require org/name[@version]; push the Workbench first'
        );
    if (args.json && args.final)
        throw new Error('--json and --final cannot be used together');
    if (args.detach && args.final)
        throw new Error('--detach cannot be combined with --final or --dry-run');
    if (args.ref && !args.repo) throw new Error('--ref requires --repo');
    const repository = args.repo ? parseRepository(args.repo) : undefined;
    const minutes =
        args['max-minutes'] === undefined ? undefined : Number(args['max-minutes']);
    if (
        minutes !== undefined &&
        (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
    )
        throw new Error('--max-minutes must be an integer from 1 to 1440');
    return {
        workbench: args.workbench,
        ...(repository
            ? {
                  workspace: {
                      repository: `${repository.owner}/${repository.name}`,
                      ...(args.ref ? { ref: args.ref } : {}),
                  },
              }
            : {}),
        ...(args.worker ? { worker: args.worker } : {}),
        ...(args.project ? { project: args.project } : {}),
        ...(minutes === undefined ? {} : { max_minutes: minutes }),
        ...(args.connection ? { connection: args.connection } : {}),
    };
}
