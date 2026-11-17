import { createHash } from 'node:crypto';
import type { RuntimePrepareRequest } from './contracts.js';

/**
 * The tools Workbench installs in a remote sandbox whose image lacks them.
 * Git tracks every remote workspace's changes; a repository run also needs `gh`.
 */
export class SandboxTools {
    readonly names: readonly string[];

    constructor(readonly repository: boolean) {
        this.names = repository ? ['git', 'gh'] : ['git'];
    }

    /** The tools a run of `request` needs. */
    static for(request: RuntimePrepareRequest): SandboxTools {
        return new SandboxTools(request.repository !== undefined);
    }

    /** The tools by name, for messages. */
    label(): string {
        return this.names.join(' and ');
    }

    /** Run as root: installs the tools the image lacks with its package manager. */
    installCommand(): string {
        const packages = this.names.join(' ');
        const apk = this.names
            .map((tool) => (tool === 'gh' ? 'github-cli' : tool))
            .join(' ');
        const present = this.names.map((tool) => `command -v ${tool} >/dev/null 2>&1`);
        return [
            'set -eu',
            `if ${present.join(' && ')}; then exit 0; fi`,
            'if command -v apk >/dev/null 2>&1; then',
            `  apk add --no-cache ${apk} ca-certificates`,
            'elif command -v apt-get >/dev/null 2>&1; then',
            '  apt-get update',
            `  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages} ca-certificates`,
            '  rm -rf /var/lib/apt/lists/*',
            'elif command -v dnf >/dev/null 2>&1; then',
            `  dnf install -y ${packages} ca-certificates`,
            'elif command -v microdnf >/dev/null 2>&1; then',
            `  microdnf install -y ${packages} ca-certificates`,
            'else',
            `  echo "Workbench cannot install ${this.label()} in this image: no supported package manager" >&2`,
            '  exit 1',
            'fi',
            ...present,
        ].join('\n');
    }

    /** Run as the sandbox user: prints the names of the tools it lacks. */
    probeCommand(): string {
        return [
            'missing=',
            ...this.names.map(
                (tool) =>
                    `command -v ${tool} >/dev/null 2>&1 || missing="$missing ${tool}"`
            ),
            'if [ -n "$missing" ]; then echo "$missing" | sed "s/^ //"; exit 1; fi',
        ].join('\n');
    }

    /** Changes whenever the install command does, so prepared images and templates rebuild. */
    cacheKey(): string {
        return createHash('sha256').update(this.installCommand()).digest('hex');
    }
}
