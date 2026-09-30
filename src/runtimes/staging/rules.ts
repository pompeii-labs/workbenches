import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Rules shared by every provider that copies host files into a sandbox: which
 * workspace paths never leave the host, which paths are safe inside an archive,
 * and how transfer sizes are reported. They are pure string checks.
 */

export function normalizeArchivePath(path: string): string {
    return path.split(sep).join('/').replace(/^\.\//, '');
}

export function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

export function excludedByNestedAsset(path: string, roots: string[]): boolean {
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export function validateRelativePath(path: string, label = 'E2B'): void {
    if (
        !path ||
        path === '.' ||
        isAbsolute(path) ||
        path.split('/').some((segment) => segment === '..' || segment === '')
    ) {
        throw new Error(`Unsafe ${label} archive path: ${path}`);
    }
}

export function validateSymlink(
    parent: string,
    link: string,
    displayPath: string,
    root?: string,
    label = 'E2B'
): void {
    if (isAbsolute(link)) {
        throw new Error(
            `Absolute symlink is not allowed in ${label} transfer: ${displayPath}`
        );
    }
    if (root && !contains(root, resolve(parent, link))) {
        throw new Error(
            `Escaping symlink is not allowed in ${label} transfer: ${displayPath}`
        );
    }
}

export function safeProjectNpmrc(content: Uint8Array): boolean {
    // Only known non-secret project settings may cross the workspace boundary.
    // Authentication, URLs, paths, interpolation, and unknown settings stay blocked.
    const booleanSettings = new Set([
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
    if (content.byteLength > 64 * 1024) return false;
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
        return !!match && booleanSettings.has(match[1] ?? '');
    });
}

export function projectNpmrcPath(path: string): boolean {
    return (
        basename(path) === '.npmrc' &&
        !protectedWorkspacePath(`${dirname(path)}/config`)
    );
}

export function protectedWorkspacePath(path: string): boolean {
    const segments = path.split('/');
    if (
        segments.some((segment) =>
            [
                '.git',
                '.hg',
                '.svn',
                '.ssh',
                '.aws',
                '.gnupg',
                '.workbench',
                '.workbench-state',
                'node_modules',
            ].includes(segment)
        )
    ) {
        return true;
    }
    const name = basename(path).toLowerCase();
    if (
        name === '.env' ||
        (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))
    ) {
        return true;
    }
    if (
        [
            '.npmrc',
            '.netrc',
            '.pypirc',
            'id_rsa',
            'id_ed25519',
            'credentials',
            'runtime.secrets.json',
        ].includes(name)
    ) {
        return true;
    }
    return ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'].some((extension) =>
        name.endsWith(extension)
    );
}

export function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
