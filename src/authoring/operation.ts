import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    SavedWorkbenchCatalog,
    type SnapshotFile,
    WorkbenchPackage,
} from '../catalog/index.js';
import { SemanticVersion } from '../releases/index.js';
import { RuntimeSmoke } from '../runtimes/index.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import {
    CredentialFilePolicy,
    type EnvironmentOverrides,
    Workbench,
    WorkbenchEnvironment,
    WorkbenchWorkspaces,
} from '../workbench/index.js';
import { AuthoringRepository, type RepositoryFileState } from './repository.js';

export type AuthoringKind = 'create' | 'edit' | 'improve';

export interface AuthoringFinishOptions {
    environment?: Record<string, string | undefined>;
    environmentOverrides?: EnvironmentOverrides;
    workspaceOverrides?: ReadonlyMap<string, string>;
    workspaces?: WorkbenchWorkspaceBinding[];
    workspaceDirectory?: string;
    allowHostDocker?: boolean;
}

export interface AuthoringSmokeOptions {
    environment: Record<string, string | undefined>;
    workspaces: WorkbenchWorkspaceBinding[];
    allowHostDocker: boolean;
}

export interface AuthoringOperationResult {
    id: string;
    kind: AuthoringKind;
    status: 'completed' | 'unchanged' | 'failed';
    packages: string[];
    changedFiles: string[];
    error?: string;
    warnings?: string[];
}

/** A create operation was finalized before the creator made a package. */
export class AuthoringCreateIncompleteError extends Error {
    constructor() {
        super('Workbench creation did not create a package');
        this.name = 'AuthoringCreateIncompleteError';
    }
}

export type AuthoringSmoke = (
    workbench: Workbench,
    options: AuthoringSmokeOptions
) => Promise<void>;

interface PackageState {
    selector: string;
    name?: string;
    version?: string;
    digest: string;
    validation_error?: string;
    files: Array<{ path: string; digest: string }>;
}

interface AuthoringOperationRecord {
    version: 1;
    id: string;
    kind: AuthoringKind;
    status: 'prepared' | 'completed' | 'unchanged' | 'invalid' | 'failed';
    repository: string;
    target_selector?: string;
    source_session_id?: string;
    evidence_path?: string;
    creator: {
        version: string;
        digest: string;
        registry_version_id: string;
        cached: boolean;
    };
    before: PackageState[];
    after?: PackageState[];
    changed_files?: string[];
    error?: string;
    started_at: string;
    finished_at?: string;
}

export interface PrepareAuthoringOperationOptions {
    id: string;
    kind: AuthoringKind;
    repository: string;
    targetSelector?: string;
    sourceSessionId?: string;
    evidencePath?: string;
    creator: AuthoringOperationRecord['creator'];
    verification?: AuthoringFinishOptions;
}

export class AuthoringOperation {
    static readonly #credentials = new CredentialFilePolicy();
    readonly #path: string;
    readonly #smoke: AuthoringSmoke;
    readonly #finishOptions: AuthoringFinishOptions;
    readonly #repository: AuthoringRepository;
    private constructor(
        readonly home: string,
        private record: AuthoringOperationRecord,
        private readonly repositoryBefore: RepositoryFileState[],
        smoke?: AuthoringSmoke,
        finishOptions: AuthoringFinishOptions = {}
    ) {
        this.#path = join(home, 'authoring', record.id, 'operation.json');
        this.#smoke = smoke ?? ((workbench, options) => this.smoke(workbench, options));
        this.#finishOptions = finishOptions;
        this.#repository = new AuthoringRepository();
    }

    get id(): string {
        return this.record.id;
    }

    get repository(): string {
        return this.record.repository;
    }

    get evidencePath(): string | undefined {
        return this.record.evidence_path;
    }

    get verification(): AuthoringFinishOptions {
        return this.#finishOptions;
    }

    async checkpoint(): Promise<void> {
        await writeFile(
            join(this.home, 'authoring', this.id, 'baseline.json'),
            JSON.stringify(this.repositoryBefore),
            { mode: 0o600 }
        );
    }

    static async load(
        home: string,
        id: string,
        verification: AuthoringFinishOptions = {},
        smoke?: AuthoringSmoke
    ): Promise<AuthoringOperation> {
        if (!/^author_[a-z0-9_]+$/.test(id))
            throw new Error('Invalid authoring operation ID');
        const directory = join(home, 'authoring', id);
        const record = JSON.parse(
            await readFile(join(directory, 'operation.json'), 'utf8')
        ) as AuthoringOperationRecord;
        const baseline = JSON.parse(
            await readFile(join(directory, 'baseline.json'), 'utf8')
        ) as RepositoryFileState[];
        if (
            record.version !== 1 ||
            record.id !== id ||
            typeof record.repository !== 'string' ||
            !Array.isArray(record.before) ||
            !Array.isArray(baseline) ||
            !baseline.every(
                (file) =>
                    typeof file.path === 'string' && typeof file.digest === 'string'
            )
        )
            throw new Error('Invalid authoring checkpoint');
        return new AuthoringOperation(home, record, baseline, smoke, verification);
    }

    static async prepare(
        home: string,
        options: PrepareAuthoringOperationOptions,
        smoke?: AuthoringSmoke
    ): Promise<AuthoringOperation> {
        const repository = new AuthoringRepository();
        const [before, repositoryBefore] = await Promise.all([
            AuthoringOperation.packages(options.repository),
            repository.snapshot(options.repository),
        ]);
        const operation = new AuthoringOperation(
            home,
            {
                version: 1,
                id: options.id,
                kind: options.kind,
                status: 'prepared',
                repository: options.repository,
                ...(options.targetSelector
                    ? { target_selector: options.targetSelector }
                    : {}),
                ...(options.sourceSessionId
                    ? { source_session_id: options.sourceSessionId }
                    : {}),
                ...(options.evidencePath
                    ? { evidence_path: options.evidencePath }
                    : {}),
                creator: options.creator,
                before,
                started_at: new Date().toISOString(),
            },
            repositoryBefore,
            smoke,
            options.verification
        );
        await operation.write(operation.record);
        return operation;
    }

    async finish(
        options: AuthoringFinishOptions = {}
    ): Promise<AuthoringOperationResult> {
        const finishOptions = { ...this.#finishOptions, ...options };
        let after: PackageState[];
        let repositoryAfter: RepositoryFileState[];
        try {
            [after, repositoryAfter] = await Promise.all([
                AuthoringOperation.packages(this.record.repository),
                this.#repository.snapshot(this.record.repository),
            ]);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.write({
                ...this.record,
                status: 'invalid',
                error: message,
                finished_at: new Date().toISOString(),
            });
            throw new Error(message);
        }
        const changedFiles = this.#repository.changes(
            this.repositoryBefore,
            repositoryAfter
        );
        const status = changedFiles.length === 0 ? 'unchanged' : 'completed';
        const candidates = this.candidateSelectors(after, changedFiles);
        const validation = this.validateCandidate(after, changedFiles, candidates);
        let error = validation instanceof Error ? validation.message : validation;
        if (!error) {
            for (const selector of candidates) {
                try {
                    const workbench = await Workbench.load(
                        join(this.record.repository, '.workbenches', selector)
                    );
                    await this.#smoke(
                        workbench,
                        await this.smokeOptions(workbench, finishOptions)
                    );
                } catch (cause) {
                    const message =
                        cause instanceof Error ? cause.message : String(cause);
                    error = `Workbench ${selector} failed smoke: ${message}`;
                    break;
                }
            }
        }
        const { error: _previousError, ...record } = this.record;
        await this.write({
            ...record,
            status: error ? 'invalid' : status,
            after,
            changed_files: changedFiles,
            ...(error ? { error } : {}),
            finished_at: new Date().toISOString(),
        });
        if (validation instanceof Error) throw validation;
        if (error) throw new Error(error);
        const warnings: string[] = [];
        for (const selector of candidates) {
            const path = join(this.record.repository, '.workbenches', selector);
            try {
                await new SavedWorkbenchCatalog(this.home).addLocal({
                    workbench: await Workbench.load(path),
                });
            } catch (cause) {
                warnings.push(
                    `Package verified at ${path}, but not added: ${cause instanceof Error ? cause.message : String(cause)} Run wb add ${JSON.stringify(path)} --as <alias>.`
                );
            }
        }
        return {
            id: this.record.id,
            kind: this.record.kind,
            status,
            packages: candidates,
            changedFiles,
            ...(warnings.length ? { warnings } : {}),
        };
    }

    async fail(message: string): Promise<AuthoringOperationResult> {
        await this.write({
            ...this.record,
            status: 'failed',
            error: message,
            finished_at: new Date().toISOString(),
        });
        return {
            id: this.record.id,
            kind: this.record.kind,
            status: 'failed',
            packages: this.record.target_selector ? [this.record.target_selector] : [],
            changedFiles: this.record.changed_files ?? [],
            error: message,
        };
    }

    private validateCandidate(
        after: PackageState[],
        changedFiles: string[],
        selectors: string[]
    ): string | AuthoringCreateIncompleteError | undefined {
        const allowed = new Set(
            this.record.target_selector ? [this.record.target_selector] : selectors
        );
        const outside = changedFiles.filter((path) => {
            const [root, selector] = path.split('/');
            return root !== '.workbenches' || !selector || !allowed.has(selector);
        });
        if (outside.length > 0) {
            const boundary = this.record.target_selector
                ? `.workbenches/${this.record.target_selector}`
                : selectors.length === 1
                  ? `.workbenches/${selectors[0]}`
                  : 'the created Workbench package';
            return `Authoring changed files outside the requested ${boundary} package: ${summarizePaths(outside)}`;
        }
        const changedSelectors = new Set(
            changedFiles
                .filter((path) => path.startsWith('.workbenches/'))
                .map((path) => path.split('/')[1])
                .filter((selector): selector is string => Boolean(selector))
        );
        if (this.record.target_selector) {
            const unexpected = [...changedSelectors].filter(
                (selector) => selector !== this.record.target_selector
            );
            if (unexpected.length > 0) {
                return `Authoring changed Workbench ${summarizePaths(unexpected)} outside the requested ${this.record.target_selector} package`;
            }
        } else if (this.record.kind === 'create') {
            const existing = [...changedSelectors].filter((selector) =>
                this.record.before.some((entry) => entry.selector === selector)
            );
            if (existing.length > 0) {
                return `Workbench creation modified existing package ${existing.join(', ')}`;
            }
            if (selectors.length === 0) {
                return new AuthoringCreateIncompleteError();
            }
            if (selectors.length > 1) {
                return `Workbench creation created multiple packages: ${selectors.join(', ')}`;
            }
        }
        for (const selector of selectors) {
            const before = this.record.before.find(
                (entry) => entry.selector === selector
            );
            const candidate = after.find((entry) => entry.selector === selector);
            if (!candidate) {
                return `Workbench ${selector} was removed during authoring`;
            }
            if (candidate.validation_error) {
                return `Workbench ${candidate.selector} is invalid: ${candidate.validation_error}`;
            }
            if (!before || before.digest === candidate.digest) continue;
            if (!candidate.version) {
                return `Workbench ${candidate.selector} changed without a valid version increment`;
            }
            if (
                before.version &&
                SemanticVersion.compare(candidate.version, before.version) <= 0
            ) {
                return `Workbench ${candidate.selector} changed without incrementing its version above ${before.version}`;
            }
        }
        return undefined;
    }

    private candidateSelectors(
        after: PackageState[],
        changedFiles: string[]
    ): string[] {
        if (this.record.target_selector) return [this.record.target_selector];
        const before = new Set(this.record.before.map((entry) => entry.selector));
        const changed = new Set(
            changedFiles
                .filter((path) => path.startsWith('.workbenches/'))
                .map((path) => path.split('/')[1])
                .filter(Boolean)
        );
        return after
            .map((entry) => entry.selector)
            .filter((selector) => changed.has(selector) && !before.has(selector));
    }

    private async smokeOptions(
        workbench: Workbench,
        options: AuthoringFinishOptions
    ): Promise<AuthoringSmokeOptions> {
        if (options.workspaces && options.workspaceOverrides?.size) {
            throw new Error(
                'Pass either resolved workspaces or workspace overrides, not both'
            );
        }
        const environment = new WorkbenchEnvironment().bind(
            workbench,
            options.environmentOverrides ?? { file: {}, explicit: new Map() },
            options.environment ?? process.env
        );
        const workspaces =
            options.workspaces ??
            (await new WorkbenchWorkspaces().bind({
                workbench,
                rawArgs: [...(options.workspaceOverrides ?? new Map())].flatMap(
                    ([name, path]) => ['--workspace', `${name}=${path}`]
                ),
                cwd: options.workspaceDirectory ?? this.record.repository,
            }));
        return {
            environment,
            workspaces,
            allowHostDocker: options.allowHostDocker ?? false,
        };
    }

    private async smoke(
        workbench: Workbench,
        options: AuthoringSmokeOptions
    ): Promise<void> {
        const result = await new RuntimeSmoke({
            workbench,
            workspaceDirectory: this.record.repository,
            environment: options.environment,
            workspaces: options.workspaces,
            allowHostDocker: options.allowHostDocker,
            reference: `${this.record.repository}#${workbench.manifest.name}`,
            home: this.home,
        }).check();
        if (!result.authentication.ready) {
            throw new Error(result.authentication.connectCommand);
        }
    }

    private static async packages(repository: string): Promise<PackageState[]> {
        const root = join(repository, '.workbenches');
        const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
            if (AuthoringOperation.errorCode(error) === 'ENOENT') return [];
            throw error;
        });
        return Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .toSorted((left, right) => left.name.localeCompare(right.name))
                .map((entry) =>
                    AuthoringOperation.package(join(root, entry.name), entry.name)
                )
        );
    }

    private static async package(
        directory: string,
        selector: string
    ): Promise<PackageState> {
        const files = await AuthoringOperation.files(directory);
        const sensitive = files.filter((file) => file.sensitive);
        const portable = files
            .filter((file) => !file.sensitive)
            .map(({ path, bytes, executable }) => ({
                path,
                bytes,
                executable,
            })) satisfies SnapshotFile[];
        let workbench: Workbench | undefined;
        let validationError: string | undefined;
        try {
            workbench = await Workbench.load(directory);
        } catch (error) {
            validationError = error instanceof Error ? error.message : String(error);
        }
        const partial = workbench
            ? undefined
            : await AuthoringOperation.partialIdentity(directory);
        if (sensitive.length > 0) {
            validationError = `Credential-like files are not allowed in a Workbench package: ${sensitive.map((file) => file.path).join(', ')}`;
        }
        return {
            selector,
            ...(workbench
                ? {
                      name: workbench.manifest.name,
                      version: workbench.manifest.version,
                  }
                : partial),
            digest: WorkbenchPackage.digest(portable),
            ...(validationError ? { validation_error: validationError } : {}),
            files: files.map((file) => ({ path: file.path, digest: file.digest })),
        };
    }

    private static async files(
        directory: string,
        relativePath = ''
    ): Promise<
        Array<{
            path: string;
            bytes: Uint8Array;
            executable: boolean;
            sensitive: boolean;
            digest: string;
        }>
    > {
        const entries = await readdir(join(directory, relativePath), {
            withFileTypes: true,
        });
        const files: Array<{
            path: string;
            bytes: Uint8Array;
            executable: boolean;
            sensitive: boolean;
            digest: string;
        }> = [];
        for (const entry of entries.toSorted((left, right) =>
            left.name.localeCompare(right.name)
        )) {
            const path = join(relativePath, entry.name);
            const details = await lstat(join(directory, path));
            if (details.isSymbolicLink()) {
                throw new Error(`Workbench packages may not contain symlinks: ${path}`);
            }
            if (entry.isDirectory()) {
                files.push(...(await AuthoringOperation.files(directory, path)));
                continue;
            }
            if (!entry.isFile()) continue;
            const sensitive = AuthoringOperation.sensitive(entry.name);
            const bytes = sensitive
                ? new Uint8Array()
                : new Uint8Array(await readFile(join(directory, path)));
            files.push({
                path,
                bytes,
                executable: Boolean(details.mode & 0o111),
                sensitive,
                digest: sensitive
                    ? '[REDACTED]'
                    : new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
            });
        }
        return files;
    }

    private static sensitive(name: string): boolean {
        return AuthoringOperation.#credentials.matches(name);
    }

    private static async partialIdentity(
        directory: string
    ): Promise<{ name?: string; version?: string }> {
        const source = await readFile(join(directory, 'workbench.yml'), 'utf8').catch(
            () => undefined
        );
        if (!source) return {};
        let value: unknown;
        try {
            value = Bun.YAML.parse(source);
        } catch {
            return {};
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const name = Reflect.get(value, 'name');
        const version = Reflect.get(value, 'version');
        return {
            ...(typeof name === 'string' ? { name } : {}),
            ...(typeof version === 'string' && SemanticVersion.parse(version)
                ? { version }
                : {}),
        };
    }

    private static errorCode(error: unknown): string | undefined {
        if (!error || typeof error !== 'object') return undefined;
        const code = Reflect.get(error, 'code');
        return typeof code === 'string' ? code : undefined;
    }

    private async write(record: AuthoringOperationRecord): Promise<void> {
        const directory = join(this.home, 'authoring', this.record.id);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, this.#path);
        this.record = record;
    }
}

function summarizePaths(paths: string[], limit = 8): string {
    const visible = paths.slice(0, limit);
    const remaining = paths.length - visible.length;
    return `${visible.join(', ')}${remaining > 0 ? `, and ${remaining} more` : ''}`;
}
