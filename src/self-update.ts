import { createHash } from 'node:crypto';
import {
    chmod,
    copyFile,
    mkdtemp,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { WORKBENCH_USER_AGENT } from './user-agent.js';

const defaultRepository = 'pompeii-labs/workbenches';
const maximumArchiveBytes = 250 * 1024 * 1024;
const maximumChecksumBytes = 1024 * 1024;

export interface CliReleaseAsset {
    name: string;
    url: string;
}

export interface CliRelease {
    version: string;
    tag: string;
    prerelease: boolean;
    assets: CliReleaseAsset[];
}

export interface SelfUpdateDependencies {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    repository?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
    executable?: string;
}

export async function availableCliUpdate(
    currentVersion: string,
    dependencies: SelfUpdateDependencies = {}
): Promise<CliRelease | undefined> {
    const current = parseSemanticVersion(currentVersion);
    if (!current) throw new Error(`Invalid current CLI version: ${currentVersion}`);
    const repository = dependencies.repository ?? defaultRepository;
    const url = `https://api.github.com/repos/${repository}/releases?per_page=100`;
    let response: Response;
    try {
        response = await (dependencies.fetch ?? fetch)(url, {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': WORKBENCH_USER_AGENT,
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not check for Workbench CLI updates: ${detail}`);
    }
    if (!response.ok) {
        throw new Error(
            `Could not check for Workbench CLI updates (HTTP ${response.status})`
        );
    }
    const value: unknown = await response.json().catch(() => null);
    if (!Array.isArray(value)) {
        throw new Error('The Workbench release service returned malformed data');
    }
    const releases = value
        .map(parseRelease)
        .filter((release): release is CliRelease => Boolean(release))
        .filter((release) => current.prerelease || !release.prerelease)
        .filter(
            (release) => compareSemanticVersions(release.version, currentVersion) > 0
        )
        .sort((left, right) => compareSemanticVersions(right.version, left.version));
    return releases[0];
}

export async function installCliUpdate(
    release: CliRelease,
    dependencies: SelfUpdateDependencies = {}
): Promise<string> {
    const targetName = releaseTargetName(
        dependencies.platform ?? process.platform,
        dependencies.architecture ?? process.arch
    );
    const archiveName = `${targetName}.tar.gz`;
    const archiveAsset = release.assets.find((asset) => asset.name === archiveName);
    const checksumsAsset = release.assets.find(
        (asset) => asset.name === 'checksums.txt'
    );
    if (!archiveAsset || !checksumsAsset) {
        throw new Error(`Workbench ${release.tag} does not support this platform`);
    }

    const target = dependencies.executable
        ? await realpath(dependencies.executable)
        : await installedCliExecutable();
    const temporary = await mkdtemp(join(tmpdir(), 'workbench-update-'));
    const archive = join(temporary, archiveName);
    try {
        const fetcher = dependencies.fetch ?? fetch;
        const [archiveBytes, checksumBytes] = await Promise.all([
            downloadReleaseAsset(archiveAsset, maximumArchiveBytes, fetcher),
            downloadReleaseAsset(checksumsAsset, maximumChecksumBytes, fetcher),
        ]);
        await writeFile(archive, archiveBytes, { mode: 0o600 });
        const expected = checksumFor(
            new TextDecoder().decode(checksumBytes),
            archiveName
        );
        const actual = createHash('sha256').update(archiveBytes).digest('hex');
        if (actual !== expected) {
            throw new Error(`Checksum verification failed for ${archiveName}`);
        }

        const extraction = Bun.spawn(
            ['tar', '-xzf', archive, '-C', temporary, `${targetName}/workbench`],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' }
        );
        const [code, stderr] = await Promise.all([
            extraction.exited,
            new Response(extraction.stderr).text(),
        ]);
        if (code !== 0) {
            throw new Error(
                `Could not extract the Workbench update${stderr.trim() ? `: ${stderr.trim()}` : ''}`
            );
        }
        const source = join(temporary, targetName, 'workbench');
        if (!(await stat(source).catch(() => null))) {
            throw new Error('The Workbench release archive does not contain the CLI');
        }

        const staged = join(
            dirname(target),
            `.workbench-update-${crypto.randomUUID()}`
        );
        try {
            await copyFile(source, staged);
            await chmod(staged, 0o755);
            await rename(staged, target);
        } catch (error) {
            await rm(staged, { force: true });
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not replace the installed Workbench CLI: ${detail}`);
        }
        return target;
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

export function compareSemanticVersions(left: string, right: string): number {
    const leftVersion = parseSemanticVersion(left);
    const rightVersion = parseSemanticVersion(right);
    if (!leftVersion || !rightVersion) {
        throw new Error(`Cannot compare CLI versions: ${left}, ${right}`);
    }
    for (const key of ['major', 'minor', 'patch'] as const) {
        if (leftVersion[key] !== rightVersion[key]) {
            return leftVersion[key] > rightVersion[key] ? 1 : -1;
        }
    }
    if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
    if (!leftVersion.prerelease) return 1;
    if (!rightVersion.prerelease) return -1;
    const length = Math.max(
        leftVersion.prerelease.length,
        rightVersion.prerelease.length
    );
    for (let index = 0; index < length; index += 1) {
        const leftIdentifier = leftVersion.prerelease[index];
        const rightIdentifier = rightVersion.prerelease[index];
        if (leftIdentifier === undefined) return -1;
        if (rightIdentifier === undefined) return 1;
        if (leftIdentifier === rightIdentifier) continue;
        const leftNumeric = /^\d+$/.test(leftIdentifier);
        const rightNumeric = /^\d+$/.test(rightIdentifier);
        if (leftNumeric && rightNumeric) {
            return Number(leftIdentifier) > Number(rightIdentifier) ? 1 : -1;
        }
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
}

export function releaseTargetName(platform: string, architecture: string): string {
    if (platform !== 'darwin' && platform !== 'linux') {
        throw new Error(`Unsupported release operating system: ${platform}`);
    }
    const normalizedArchitecture =
        architecture === 'arm64' || architecture === 'aarch64'
            ? 'arm64'
            : architecture === 'x64' || architecture === 'x86_64'
              ? 'x64'
              : undefined;
    if (!normalizedArchitecture) {
        throw new Error(`Unsupported release architecture: ${architecture}`);
    }
    return `workbench-${platform}-${normalizedArchitecture}`;
}

async function installedCliExecutable(): Promise<string> {
    const name = basename(process.execPath).toLowerCase();
    if (name === 'bun' || name === 'bunx') {
        throw new Error(
            'CLI self-update is available only from an installed Workbench binary'
        );
    }
    return realpath(process.execPath);
}

async function downloadReleaseAsset(
    asset: CliReleaseAsset,
    maximumBytes: number,
    fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): Promise<Uint8Array> {
    let url: URL;
    try {
        url = new URL(asset.url);
    } catch {
        throw new Error(`Workbench release asset has an invalid URL: ${asset.name}`);
    }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
        throw new Error(`Workbench release asset has an unsafe URL: ${asset.name}`);
    }
    let response: Response;
    try {
        response = await fetcher(url, {
            headers: { 'User-Agent': WORKBENCH_USER_AGENT },
            redirect: 'follow',
            signal: AbortSignal.timeout(120_000),
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not download ${asset.name}: ${detail}`);
    }
    if (!response.ok) {
        throw new Error(`Could not download ${asset.name} (HTTP ${response.status})`);
    }
    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (declaredSize > maximumBytes) {
        throw new Error(`Workbench release asset is too large: ${asset.name}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
        throw new Error(`Workbench release asset has an invalid size: ${asset.name}`);
    }
    return bytes;
}

function checksumFor(contents: string, assetName: string): string {
    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (match?.[2] === assetName) return match[1]?.toLowerCase() as string;
    }
    throw new Error(`Checksum is missing for ${assetName}`);
}

function parseRelease(value: unknown): CliRelease | undefined {
    if (
        !isRecord(value) ||
        value.draft === true ||
        typeof value.tag_name !== 'string'
    ) {
        return undefined;
    }
    const version = value.tag_name.startsWith('v')
        ? value.tag_name.slice(1)
        : value.tag_name;
    if (!parseSemanticVersion(version) || !Array.isArray(value.assets))
        return undefined;
    const assets = value.assets
        .map((asset) => {
            if (
                !isRecord(asset) ||
                typeof asset.name !== 'string' ||
                typeof asset.browser_download_url !== 'string'
            ) {
                return undefined;
            }
            return { name: asset.name, url: asset.browser_download_url };
        })
        .filter((asset): asset is CliReleaseAsset => Boolean(asset));
    return {
        version,
        tag: value.tag_name,
        prerelease: value.prerelease === true,
        assets,
    };
}

function parseSemanticVersion(value: string): {
    major: number;
    minor: number;
    patch: number;
    prerelease?: string[];
} | null {
    const match = value.match(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    );
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        ...(match[4] ? { prerelease: match[4].split('.') } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
