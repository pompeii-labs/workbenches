import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StudioStateRecord } from '../database/studio/state.js';
import type { CommandResult, HostCommands } from '../processes/commands.js';

const STUDIO_CONTAINER_PORT = 3_000;
const STUDIO_LABEL = 'dev.workbenches.studio=1';
const STUDIO_NETWORK = 'workbench-studio';
/** The image label naming the Studio API contract an image implements. */
const CONTRACT_LABEL = 'dev.workbenches.studio.contract';
/** The Studio API contract this engine serves. */
export const STUDIO_CONTRACT = '1';

/** The Docker CLI operations the local Studio needs, on one host platform. */
export class StudioDocker {
    constructor(
        private readonly home: string,
        private readonly platform: NodeJS.Platform,
        private readonly commands: Pick<HostCommands, 'run' | 'runSync'>
    ) {}

    /** Refuses a stopped daemon or a daemon running Windows containers. */
    async assertReady(): Promise<void> {
        const info = await this.run([
            'docker',
            'info',
            '--format',
            '{{.OSType}}',
        ]).catch(() => undefined);
        if (info?.code !== 0)
            throw new Error(
                "Docker isn't running. Start Docker and run wb studio again."
            );
        if (info.stdout.trim() === 'windows')
            throw new Error(
                'Docker is using Windows containers. Switch Docker Desktop to Linux containers and run wb studio again.'
            );
    }

    /**
     * The immutable ID of `image`, pulled when it is not local, after checking
     * that it implements this engine's Studio contract.
     */
    async resolveImage(image: string): Promise<string> {
        let id = await this.imageId(image);
        if (!id) {
            const pulled = await this.run(['docker', 'pull', image]);
            if (pulled.code !== 0)
                throw new Error(
                    `Could not pull the Studio image ${image}. ${pulled.stderr.trim() || 'Docker pull failed.'}`
                );
            id = await this.imageId(image);
        }
        if (!id) throw new Error(`Studio image is not available: ${image}`);
        const labels = await this.run([
            'docker',
            'image',
            'inspect',
            '--format',
            `{{index .Config.Labels "${CONTRACT_LABEL}"}}`,
            id,
        ]);
        const contract = labels.code === 0 ? labels.stdout.trim() : '';
        if (contract !== STUDIO_CONTRACT)
            throw new Error(
                `Studio image ${image} implements Studio contract ${contract && contract !== '<no value>' ? contract : 'none'}, but this version of wb requires contract ${STUDIO_CONTRACT}. Use a Studio image built for contract ${STUDIO_CONTRACT}.`
            );
        return id;
    }

    async prepareNetwork(): Promise<void> {
        if (this.platform === 'linux') return;
        const existing = await this.run([
            'docker',
            'network',
            'inspect',
            '--format',
            '{{index .Labels "dev.workbenches.studio"}}',
            STUDIO_NETWORK,
        ]);
        if (existing.code === 0) {
            if (existing.stdout.trim() === '1') return;
            throw new Error(
                `Docker network ${STUDIO_NETWORK} exists without the Studio label. Remove it and start studio again.`
            );
        }
        const created = await this.run(studioNetworkCreateArguments());
        if (created.code !== 0 && !created.stderr.includes('already exists'))
            throw new Error(
                created.stderr.trim() || 'Could not create the Studio network'
            );
    }

    async removeNetwork(): Promise<void> {
        if (this.platform === 'linux') return;
        const result = await this.run(['docker', 'network', 'rm', STUDIO_NETWORK]);
        if (
            result.code !== 0 &&
            !/active endpoints|in use|no such network|not found/i.test(result.stderr)
        )
            throw new Error(
                result.stderr.trim() || 'Could not remove the Studio network'
            );
    }

    /** Starts the dashboard container and returns its ID. */
    async runContainer(record: StudioStateRecord, imageId: string): Promise<string> {
        const containerName = `workbench-studio-${randomBytes(8).toString('hex')}`;
        const environmentFile = join(
            this.home,
            `.studio-env-${process.pid}-${randomBytes(6).toString('hex')}`
        );
        try {
            await writeFile(
                environmentFile,
                studioContainerEnvironment(this.platform, record),
                { mode: 0o600, flag: 'wx' }
            );
            const result = await this.run(
                studioDockerRunArguments(
                    this.platform,
                    record,
                    imageId,
                    containerName,
                    environmentFile
                )
            );
            if (result.code !== 0) {
                await this.removeContainer(containerName).catch(() => {});
                throw new Error(
                    result.stderr.trim() || 'Could not start the Studio container'
                );
            }
            const id = result.stdout.trim();
            if (!id) throw new Error('Docker did not return the Studio container ID');
            return id;
        } finally {
            await rm(environmentFile, { force: true });
        }
    }

    async removeContainer(id: string): Promise<void> {
        const result = await this.run(['docker', 'rm', '--force', id]);
        if (result.code !== 0 && !result.stderr.includes('No such container'))
            throw new Error(
                result.stderr.trim() || 'Could not remove the Studio container'
            );
    }

    /** The image ID of a running container, or undefined when it is not running. */
    runningImage(containerId: string): string | undefined {
        const result = this.commands.runSync([
            'docker',
            'inspect',
            '--format',
            '{{.State.Running}} {{.Image}}',
            containerId,
        ]);
        if (!result) return undefined;
        const [running, imageId = ''] = result.stdout.trim().split(' ');
        return result.code === 0 && running === 'true' ? imageId : undefined;
    }

    private async imageId(image: string): Promise<string | undefined> {
        const result = await this.run([
            'docker',
            'image',
            'inspect',
            '--format',
            '{{.Id}}',
            image,
        ]);
        const id = result.stdout.trim();
        return result.code === 0 && /^sha256:[a-f0-9]{64}$/.test(id) ? id : undefined;
    }

    private run(args: string[]): Promise<CommandResult> {
        return this.commands.run(args);
    }
}

export function studioContainerEnvironment(
    platform: NodeJS.Platform,
    record: Pick<StudioStateRecord, 'api_port' | 'ui_port' | 'token'>
): string {
    // Docker Engine on Linux cannot reach a loopback-only host API through
    // host-gateway, so the container shares the host network instead.
    if (platform === 'linux')
        return `WORKBENCH_STUDIO_API=http://127.0.0.1:${record.api_port}\nWORKBENCH_STUDIO_LISTEN=127.0.0.1:${record.ui_port}\nWORKBENCH_STUDIO_TOKEN=${record.token}\n`;
    return `WORKBENCH_STUDIO_API=http://host.docker.internal:${record.api_port}\nWORKBENCH_STUDIO_TOKEN=${record.token}\n`;
}

export function studioNetworkCreateArguments(): string[] {
    return [
        'docker',
        'network',
        'create',
        '--driver',
        'bridge',
        '--label',
        STUDIO_LABEL,
        STUDIO_NETWORK,
    ];
}

export function studioDockerRunArguments(
    platform: NodeJS.Platform,
    record: Pick<StudioStateRecord, 'ui_port'>,
    imageId: string,
    containerName: string,
    environmentFile: string
): string[] {
    const network =
        platform === 'linux'
            ? ['--network', 'host']
            : [
                  '--network',
                  STUDIO_NETWORK,
                  '--publish',
                  `127.0.0.1:${record.ui_port}:${STUDIO_CONTAINER_PORT}`,
                  '--add-host',
                  'host.docker.internal:host-gateway',
              ];
    return [
        'docker',
        'run',
        '--detach',
        '--name',
        containerName,
        '--label',
        STUDIO_LABEL,
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...network,
        '--env-file',
        environmentFile,
        imageId,
    ];
}
