import type { DockerClient } from './client.js';
import type { DockerUser } from './contracts.js';
import { dockerCredentialVolume } from './identity.js';

export class DockerCredentialVolume {
    readonly name: string;

    constructor(
        private readonly client: DockerClient,
        private readonly image: string,
        readonly runner: string,
        private readonly user: DockerUser | undefined
    ) {
        this.name = DockerCredentialVolume.nameFor(runner);
    }

    static nameFor(runner: string): string {
        return dockerCredentialVolume(runner);
    }

    async prepare(): Promise<void> {
        await this.client.require(
            [this.client.executable, 'volume', 'create', this.name],
            `Failed to prepare ${this.name}`
        );
        if (!this.user) return;
        await this.client.require(
            [
                this.client.executable,
                'run',
                '--rm',
                '--network',
                'none',
                '--read-only',
                '--tmpfs',
                '/tmp:rw,nosuid,nodev,mode=1777',
                ...this.mountArguments(),
                '--entrypoint',
                '/bin/sh',
                this.image,
                '-c',
                'chown "$1:$2" /workbench-credentials',
                'workbench-credentials',
                String(this.user.uid),
                String(this.user.gid),
            ],
            `Failed to initialize ${this.name}`
        );
    }

    mountArguments(): string[] {
        return ['--volume', `${this.name}:/workbench-credentials`];
    }

    environment(): Record<string, string | undefined> {
        if (this.runner === 'opencode') {
            return { XDG_DATA_HOME: '/workbench-credentials' };
        }
        if (this.runner === 'pi') {
            return { WORKBENCH_CREDENTIALS_DIR: '/workbench-credentials' };
        }
        return {};
    }
}
