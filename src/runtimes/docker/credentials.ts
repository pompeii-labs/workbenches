import type { RuntimeCredentialFiles } from '../contracts.js';
import { credentialPathSegments, runtimeCredentialRoot } from '../credentialpath.js';
import type { DockerClient } from './client.js';
import { DockerManagedContainers } from './containers.js';
import type { DockerUser } from './contracts.js';
import { dockerCredentialVolume } from './identity.js';

const credentialRoot = runtimeCredentialRoot;

/**
 * The per-runner named volume that holds native credentials for Docker runs.
 * Reads and writes go through a short-lived helper container from the
 * Workbench image with no network and a read-only root; file contents travel
 * on standard input and output, never in argv or environment.
 */
export class DockerCredentialVolume implements RuntimeCredentialFiles {
    readonly name: string;

    constructor(
        private readonly client: DockerClient,
        private readonly image: string,
        readonly runner: string,
        private readonly user: DockerUser | undefined,
        private readonly credentialEnvironment?: (
            root: string
        ) => Record<string, string | undefined>
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
                ...this.isolation(),
                // Only root with CAP_CHOWN can chown, whatever user the image runs as by default.
                '--cap-add',
                'CHOWN',
                '--user',
                '0:0',
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

    async read(path: string): Promise<string | undefined> {
        const result = await this.client.run(
            this.helper(false, 'if [ -f "$1" ]; then cat "$1"; fi', path)
        );
        if (result.code !== 0) {
            // stdout may hold credential bytes, so only stderr explains a failure.
            const detail = result.stderr.trim().split(/\r?\n/)[0];
            throw new Error(
                `Failed to read ${path} from ${this.name}${detail ? `: ${detail.slice(0, 500)}` : ''}`
            );
        }
        return result.stdout ? result.stdout : undefined;
    }

    async write(path: string, contents: string): Promise<void> {
        await this.client.require(
            this.helper(
                true,
                [
                    'set -e',
                    'umask 077',
                    // A failed write must not leave a partial copy of the secret behind.
                    `trap 'rm -f "$1.tmp"' EXIT`,
                    'mkdir -p "$(dirname "$1")"',
                    'cat > "$1.tmp"',
                    'chmod 600 "$1.tmp"',
                    'mv -f "$1.tmp" "$1"',
                ].join('\n'),
                path
            ),
            `Failed to write ${path} to ${this.name}`,
            { input: contents }
        );
    }

    mountArguments(): string[] {
        return ['--volume', `${this.name}:${credentialRoot}`];
    }

    environment(): Record<string, string | undefined> {
        if (this.credentialEnvironment)
            return this.credentialEnvironment(credentialRoot);
        if (this.runner === 'opencode') return { XDG_DATA_HOME: credentialRoot };
        if (this.runner === 'pi') return { WORKBENCH_CREDENTIALS_DIR: credentialRoot };
        return {};
    }

    private helper(input: boolean, script: string, path: string): string[] {
        const target = `${credentialRoot}/${credentialPathSegments(path).join('/')}`;
        return [
            this.client.executable,
            'run',
            ...(input ? ['--interactive'] : []),
            ...this.isolation(),
            ...(this.user ? ['--user', `${this.user.uid}:${this.user.gid}`] : []),
            ...this.mountArguments(),
            '--entrypoint',
            '/bin/sh',
            this.image,
            '-c',
            script,
            'workbench-credentials',
            target,
        ];
    }

    /**
     * Shared by every helper. `--log-driver none` matters most: helper output
     * is credential content, and any other driver would copy it into host or
     * remote logs even for a `--rm` container.
     */
    private isolation(): string[] {
        return [
            '--rm',
            ...DockerManagedContainers.helperLabels(),
            '--log-driver',
            'none',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--pull',
            'never',
            '--network',
            'none',
            '--read-only',
            '--tmpfs',
            '/tmp:rw,nosuid,nodev,mode=1777',
        ];
    }
}
