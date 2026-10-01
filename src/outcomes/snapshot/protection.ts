import { basename } from 'node:path';

/**
 * Which workspace paths never appear in a changeset: version control state,
 * credentials, key material, and dependency trees. It is the policy a snapshot
 * applies when it records a workspace and when it compares one. It is
 * deliberately narrower than the staging policy that decides what leaves the
 * host, which also covers the engine's own state directories.
 */
export class SnapshotProtection {
    private readonly segments = new Set([
        '.git',
        '.hg',
        '.svn',
        '.ssh',
        '.aws',
        '.gnupg',
        'node_modules',
    ]);

    private readonly exampleEnvironmentFiles = ['.env.example', '.env.sample'];

    private readonly names = [
        '.npmrc',
        '.netrc',
        '.pypirc',
        'id_rsa',
        'id_ed25519',
        'credentials',
    ];

    private readonly extensions = ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'];

    isProtected(path: string): boolean {
        if (path.split('/').some((segment) => this.segments.has(segment))) return true;
        const name = basename(path).toLowerCase();
        if (
            name === '.env' ||
            (name.startsWith('.env.') && !this.exampleEnvironmentFiles.includes(name))
        ) {
            return true;
        }
        if (this.names.includes(name)) return true;
        return this.extensions.some((extension) => name.endsWith(extension));
    }
}
