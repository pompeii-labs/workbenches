import { ReservedEnvironment } from '../../workbench/reserved.js';

/**
 * How a container receives its environment from `docker run` without a file
 * on disk and without secret values in argv: each value is passed by name
 * with `--env NAME` and given to the Docker CLI process, which copies it into
 * the container. A name the CLI reads itself, such as `HOME`, keeps the CLI's
 * own value and is passed inline instead; a Workbench cannot declare those
 * names, so only engine-set paths ever appear in argv.
 */
export class DockerContainerEnvironment {
    readonly arguments: string[];
    /** The values the CLI process forwards by name. */
    readonly forward: Record<string, string>;

    constructor(environment: Record<string, string | undefined>) {
        const args: string[] = [];
        const forward: Record<string, string> = {};
        const defined = Object.entries(environment)
            .flatMap(([name, value]) => (value === undefined ? [] : [[name, value]]))
            .toSorted(([left], [right]) => (left ?? '').localeCompare(right ?? ''));
        for (const [name = '', value = ''] of defined) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
                throw new Error(
                    `Docker environment variable has an invalid name: ${name}`
                );
            if (value.includes('\0'))
                throw new Error(
                    `Docker environment variable contains a NUL character: ${name}`
                );
            if (ReservedEnvironment.isReadByDockerCli(name)) {
                args.push('--env', `${name}=${value}`);
            } else {
                args.push('--env', name);
                forward[name] = value;
            }
        }
        this.arguments = args;
        this.forward = forward;
    }
}
