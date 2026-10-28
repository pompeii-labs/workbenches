import { RepositoryCredentials } from '../repositories/credentials.js';
import type { ResolvedWorkbench } from '../types.js';

/** Names the engine, the operating system, or the Docker CLI owns. */
const reservedNames = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'PWD',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SSH_AUTH_SOCK',
    'SSH_AGENT_PID',
    'GNUPGHOME',
    'NETRC',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_DB',
    'PI_CODING_AGENT_DIR',
    'CODEX_HOME',
    'npm_config_cache',
    'BUN_INSTALL_CACHE_DIR',
    'PIP_CACHE_DIR',
    'GOCACHE',
    'GOMODCACHE',
    'CARGO_HOME',
]);

const reservedPrefixes = [
    'WORKBENCH_',
    'DOCKER_',
    'BUILDKIT_',
    'BUILDX_',
    'COMPOSE_',
    'XDG_',
    'LD_',
    'DYLD_',
    'GIT_',
];

/** What the Docker CLI reads from its own environment. */
const dockerCliNames = new Set(['PATH', 'HOME', 'TMPDIR']);
const dockerCliPrefixes = ['DOCKER_', 'BUILDKIT_', 'BUILDX_', 'COMPOSE_', 'XDG_'];

/**
 * Variable names a Workbench cannot declare. A declared name pulls its value
 * from the host into the run, so declaring one of these would let a package
 * read the host's paths, sockets, sign-in stores, or repository credentials,
 * or override what the engine sets for the run itself.
 */
export const ReservedEnvironment = {
    isReserved(name: string): boolean {
        return (
            reservedNames.has(name) ||
            reservedPrefixes.some((prefix) => name.startsWith(prefix)) ||
            RepositoryCredentials.isProtected(name)
        );
    },

    /** Whether the Docker CLI itself reads `name`, so a container value must not replace its own. */
    isReadByDockerCli(name: string): boolean {
        return (
            dockerCliNames.has(name) ||
            dockerCliPrefixes.some((prefix) => name.startsWith(prefix))
        );
    },

    /** Throws when the Workbench declares a reserved name. */
    check(workbench: ResolvedWorkbench): void {
        const reserved = Object.keys(workbench.manifest.env).filter((name) =>
            ReservedEnvironment.isReserved(name)
        );
        if (reserved.length)
            throw new Error(
                `Workbench ${workbench.manifest.name} declares ${reserved.length === 1 ? 'a reserved variable' : 'reserved variables'} the engine sets itself: ${reserved.join(', ')}`
            );
    },
};
