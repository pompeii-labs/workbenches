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

import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import { ReleaseTarget, SemanticVersion } from './semantic-version.js';

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

export interface CliUpdaterOptions {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    repository?: string;
    platform?: NodeJS.Platform;
    architecture?: string;
    executable?: string;
}

export class CliUpdater {
    private readonly fetcher: NonNullable<CliUpdaterOptions['fetch']>;
    private readonly repository: string;

    constructor(private readonly options: CliUpdaterOptions = {}) {
        this.fetcher = options.fetch ?? fetch;
        this.repository = options.repository ?? defaultRepository;
    }

    async available(currentVersion: string): Promise<CliRelease | undefined> {
        const current = SemanticVersion.parse(currentVersion);
        if (!current) throw new Error(`Invalid current CLI version: ${currentVersion}`);
        const releases = await this.releases();
        return releases
            .filter((release) => current.prerelease || !release.prerelease)
            .filter(
                (release) =>
                    SemanticVersion.compare(release.version, currentVersion) > 0
            )
            .sort((left, right) =>
                SemanticVersion.compare(right.version, left.version)
            )[0];
    }

    async install(release: CliRelease): Promise<string> {
        const targetName = ReleaseTarget.from(
            this.options.platform ?? process.platform,
            this.options.architecture ?? process.arch
        ).name;
        const archiveName = `${targetName}.tar.gz`;
        const archiveAsset = release.assets.find((asset) => asset.name === archiveName);
        const checksumsAsset = release.assets.find(
            (asset) => asset.name === 'checksums.txt'
        );
        if (!archiveAsset || !checksumsAsset) {
            throw new Error(`Workbench ${release.tag} does not support this platform`);
        }

        const target = this.options.executable
            ? await realpath(this.options.executable)
            : await this.installedExecutable();
        const temporary = await mkdtemp(join(tmpdir(), 'workbench-update-'));
        const archive = join(temporary, archiveName);
        try {
            const [archiveBytes, checksumBytes] = await Promise.all([
                this.download(archiveAsset, maximumArchiveBytes),
                this.download(checksumsAsset, maximumChecksumBytes),
            ]);
            await writeFile(archive, archiveBytes, { mode: 0o600 });
            this.verifyChecksum(
                archiveBytes,
                new TextDecoder().decode(checksumBytes),
                archiveName
            );
            const source = await this.extract(archive, temporary, targetName);
            return await this.replace(source, target);
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }

    private async releases(): Promise<CliRelease[]> {
        const url = `https://api.github.com/repos/${this.repository}/releases?per_page=100`;
        let response: Response;
        try {
            response = await this.fetcher(url, {
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
        return value
            .map((release) => this.parseRelease(release))
            .filter((release): release is CliRelease => Boolean(release));
    }

    private async download(
        asset: CliReleaseAsset,
        maximumBytes: number
    ): Promise<Uint8Array> {
        let url: URL;
        try {
            url = new URL(asset.url);
        } catch {
            throw new Error(
                `Workbench release asset has an invalid URL: ${asset.name}`
            );
        }
        if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
            throw new Error(`Workbench release asset has an unsafe URL: ${asset.name}`);
        }
        let response: Response;
        try {
            response = await this.fetcher(url, {
                headers: { 'User-Agent': WORKBENCH_USER_AGENT },
                redirect: 'follow',
                signal: AbortSignal.timeout(120_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not download ${asset.name}: ${detail}`);
        }
        if (!response.ok) {
            throw new Error(
                `Could not download ${asset.name} (HTTP ${response.status})`
            );
        }
        const declaredSize = Number(response.headers.get('content-length') ?? '0');
        if (declaredSize > maximumBytes) {
            throw new Error(`Workbench release asset is too large: ${asset.name}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
            throw new Error(
                `Workbench release asset has an invalid size: ${asset.name}`
            );
        }
        return bytes;
    }

    private verifyChecksum(
        archive: Uint8Array,
        checksums: string,
        archiveName: string
    ): void {
        const line = checksums
            .split(/\r?\n/)
            .map((entry) => entry.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/))
            .find((match) => match?.[2] === archiveName);
        if (!line?.[1]) throw new Error(`Checksum is missing for ${archiveName}`);
        const actual = createHash('sha256').update(archive).digest('hex');
        if (actual !== line[1].toLowerCase()) {
            throw new Error(`Checksum verification failed for ${archiveName}`);
        }
    }

    private async extract(
        archive: string,
        temporary: string,
        targetName: string
    ): Promise<string> {
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
        return source;
    }

    private async replace(source: string, target: string): Promise<string> {
        const staged = join(
            dirname(target),
            `.workbench-update-${crypto.randomUUID()}`
        );
        try {
            await copyFile(source, staged);
            await chmod(staged, 0o755);
            await rename(staged, target);
            return target;
        } catch (error) {
            await rm(staged, { force: true });
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not replace the installed Workbench CLI: ${detail}`);
        }
    }

    private async installedExecutable(): Promise<string> {
        const name = basename(process.execPath).toLowerCase();
        if (name === 'bun' || name === 'bunx') {
            throw new Error(
                'CLI self-update is available only from an installed Workbench binary'
            );
        }
        return realpath(process.execPath);
    }

    private parseRelease(value: unknown): CliRelease | undefined {
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
        if (!SemanticVersion.parse(version) || !Array.isArray(value.assets)) {
            return undefined;
        }
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
