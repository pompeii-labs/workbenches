import { basename, dirname } from 'node:path';

/**
 * Which workspace paths never leave the host: credentials, version control
 * state, engine state, and dependency trees. Project `.npmrc` files cross only
 * when every setting in them is a known non-secret boolean.
 */
export class WorkspaceProtection {
    private readonly booleanSettings = new Set([
        'engine-strict',
        'strict-peer-dependencies',
        'auto-install-peers',
        'shamefully-hoist',
        'legacy-peer-deps',
        'ignore-scripts',
        'save-exact',
        'package-lock',
        'fund',
        'audit',
    ]);

    private readonly maximumNpmrcBytes = 64 * 1024;

    private readonly protectedSegments = new Set([
        '.git',
        '.hg',
        '.svn',
        '.ssh',
        '.aws',
        '.gnupg',
        '.workbench',
        '.workbench-state',
        'node_modules',
    ]);

    private readonly exampleEnvironmentFiles = ['.env.example', '.env.sample'];

    private readonly protectedNames = [
        '.npmrc',
        '.netrc',
        '.pypirc',
        'id_rsa',
        'id_ed25519',
        'credentials',
        'runtime.secrets.json',
    ];

    private readonly protectedExtensions = [
        '.pem',
        '.key',
        '.p12',
        '.pfx',
        '.kubeconfig',
    ];

    safeProjectNpmrc(content: Uint8Array): boolean {
        // Only known non-secret project settings may cross the workspace boundary.
        // Authentication, URLs, paths, interpolation, and unknown settings stay blocked.
        if (content.byteLength > this.maximumNpmrcBytes) return false;
        const source = new TextDecoder('utf-8', { fatal: true });
        let text: string;
        try {
            text = source.decode(content);
        } catch {
            return false;
        }
        return text.split(/\r?\n/).every((line) => {
            const setting = line.trim();
            if (!setting) return true;
            const match = /^([a-z-]+)\s*=\s*(true|false)$/.exec(setting);
            return !!match && this.booleanSettings.has(match[1] ?? '');
        });
    }

    projectNpmrcPath(path: string): boolean {
        return (
            basename(path) === '.npmrc' &&
            !this.protectedWorkspacePath(`${dirname(path)}/config`)
        );
    }

    protectedWorkspacePath(path: string): boolean {
        if (path.split('/').some((segment) => this.protectedSegments.has(segment))) {
            return true;
        }
        const name = basename(path).toLowerCase();
        if (
            name === '.env' ||
            (name.startsWith('.env.') && !this.exampleEnvironmentFiles.includes(name))
        ) {
            return true;
        }
        if (this.protectedNames.includes(name)) return true;
        return this.protectedExtensions.some((extension) => name.endsWith(extension));
    }
}
