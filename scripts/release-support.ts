export interface ReleaseTarget {
    os: 'darwin' | 'linux' | 'windows';
    architecture: 'arm64' | 'x64';
    name: string;
    executable: 'workbench' | 'workbench.exe';
}

export function resolveReleaseTarget(
    platform = process.platform,
    architecture = process.arch
): ReleaseTarget {
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
        throw new Error(`Unsupported release operating system: ${platform}`);
    }
    if (architecture !== 'arm64' && architecture !== 'x64') {
        throw new Error(`Unsupported release architecture: ${architecture}`);
    }
    const os = platform === 'win32' ? 'windows' : platform;
    return {
        os,
        architecture,
        name: `workbench-${os}-${architecture}`,
        executable: os === 'windows' ? 'workbench.exe' : 'workbench',
    };
}

export function verifyReleaseTag(tag: string, version: string): void {
    if (version === '0.0.0') {
        throw new Error('Refusing to release the development-only version 0.0.0');
    }
    const expected = `v${version}`;
    if (tag !== expected) {
        throw new Error(`Release tag ${tag} does not match package version ${version}`);
    }
}
