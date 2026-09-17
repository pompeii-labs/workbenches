import { isAbsolute, posix } from 'node:path';

import { assertArtifactPaths, safeArtifactPath } from './artifact-paths.js';
import type {
    DeclaredOutcome,
    OutcomeApplicationReceipt,
    OutcomeArtifact,
    OutcomeChangeEntry,
    OutcomeChangeset,
    OutcomeContentDescriptor,
    OutcomeDigest,
    OutcomeLink,
    OutcomePathFingerprint,
    OutcomePathState,
    OutcomeWarning,
    OutcomeWorkspace,
    RunOutcome,
} from './contracts.js';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const identifierPattern = /^[a-z][a-z0-9_]{2,127}$/;
const runIdentifierPattern = /^wb_[a-z0-9]{20,64}$/;
const outcomeIdentifierPattern = /^wbo_[a-z0-9]{20,64}$/;

export function parseRunOutcome(value: unknown): RunOutcome {
    const record = object(value, 'Outcome');
    exactKeys(record, 'Outcome', [
        'version',
        'id',
        'run_id',
        'created_at',
        'completeness',
        'turn_index',
        'summary',
        'changesets',
        'artifacts',
        'links',
        'warnings',
    ]);
    requiredLiteral(record.version, 1, 'Outcome version');
    const id = identifier(record.id, outcomeIdentifierPattern, 'Outcome ID');
    const runId = assertOutcomeRunId(record.run_id);
    const createdAt = timestamp(record.created_at, 'Outcome created_at');
    const completeness = oneOf(
        record.completeness,
        ['complete', 'partial'] as const,
        'Outcome completeness'
    );
    const summary = optionalString(record.summary, 'Outcome summary', 16_384);
    const changesets = array(record.changesets, 'Outcome changesets').map(
        parseChangeset
    );
    const artifacts = array(record.artifacts, 'Outcome artifacts').map(parseArtifact);
    assertArtifactPaths(artifacts);
    const links = array(record.links, 'Outcome links').map((link) => parseLink(link));
    const warnings = array(record.warnings, 'Outcome warnings').map(parseWarning);
    const turnIndex = record.turn_index;
    if (turnIndex !== undefined) {
        if (!Number.isSafeInteger(turnIndex) || (turnIndex as number) < 1) {
            throw new Error('Outcome turn_index must be a positive safe integer');
        }
        if (completeness !== 'partial' || changesets.length > 0) {
            throw new Error(
                'Turn outcomes must be partial and contain no workspace changesets'
            );
        }
    }
    uniqueIds([...changesets, ...artifacts, ...links], 'Outcome child IDs');
    return {
        version: 1,
        id,
        run_id: runId,
        created_at: createdAt,
        completeness,
        ...(turnIndex !== undefined ? { turn_index: turnIndex as number } : {}),
        ...(summary ? { summary } : {}),
        changesets,
        artifacts,
        links,
        warnings,
    };
}

export function parseOutcomeApplicationReceipt(
    value: unknown
): OutcomeApplicationReceipt {
    const record = object(value, 'Outcome application receipt');
    exactKeys(record, 'Outcome application receipt', [
        'version',
        'outcome_id',
        'state',
        'updated_at',
        'applied_at',
    ]);
    requiredLiteral(record.version, 1, 'Outcome application receipt version');
    const state = oneOf(
        record.state,
        ['pending', 'present', 'applied'] as const,
        'Outcome application state'
    );
    const appliedAt = optionalTimestamp(
        record.applied_at,
        'Outcome application applied_at'
    );
    if (state === 'applied' && !appliedAt) {
        throw new Error('Applied outcome receipt must include applied_at');
    }
    if (state !== 'applied' && appliedAt) {
        throw new Error('Only an applied outcome receipt may include applied_at');
    }
    return {
        version: 1,
        outcome_id: identifier(
            record.outcome_id,
            outcomeIdentifierPattern,
            'Outcome application outcome_id'
        ),
        state,
        updated_at: timestamp(record.updated_at, 'Outcome application updated_at'),
        ...(appliedAt ? { applied_at: appliedAt } : {}),
    };
}

export function parseDeclaredOutcome(value: unknown): DeclaredOutcome {
    const record = object(value, 'Declared outcome');
    exactKeys(record, 'Declared outcome', ['version', 'summary', 'artifacts', 'links']);
    requiredLiteral(record.version, 1, 'Declared outcome version');
    const summary = optionalString(record.summary, 'Declared outcome summary', 16_384);
    const artifacts = optionalArray(
        record.artifacts,
        'Declared outcome artifacts'
    )?.map((value) => {
        const artifact = object(value, 'Declared outcome artifact');
        exactKeys(artifact, 'Declared outcome artifact', [
            'path',
            'name',
            'description',
            'media_type',
        ]);
        const name = optionalString(artifact.name, 'Declared artifact name', 512);
        const description = optionalString(
            artifact.description,
            'Declared artifact description',
            4_096
        );
        const mediaType = optionalString(
            artifact.media_type,
            'Declared artifact media_type',
            255
        );
        return {
            path: safeRelativePath(artifact.path, 'Declared artifact path'),
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(mediaType ? { media_type: mediaType } : {}),
        };
    });
    const links = optionalArray(record.links, 'Declared outcome links')?.map(
        parseDeclaredLink
    );
    return {
        version: 1,
        ...(summary ? { summary } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(links ? { links } : {}),
    };
}

export function assertSafeOutcomePath(path: string): string {
    return safeRelativePath(path, 'Outcome path');
}

export function assertOutcomeRunId(value: unknown): string {
    return identifier(value, runIdentifierPattern, 'Outcome run ID');
}

export function assertOutcomeDigest(value: string): OutcomeDigest {
    if (!digestPattern.test(value)) throw new Error(`Invalid outcome digest: ${value}`);
    return value as OutcomeDigest;
}

function parseChangeset(value: unknown): OutcomeChangeset {
    const record = object(value, 'Outcome changeset');
    exactKeys(record, 'Outcome changeset', [
        'id',
        'workspace',
        'base',
        'entries',
        'review',
        'stats',
    ]);
    const base = object(record.base, 'Outcome changeset base');
    exactKeys(base, 'Outcome changeset base', ['snapshot_digest', 'git_revision']);
    const entries = array(record.entries, 'Outcome changeset entries').map(
        parseChangeEntry
    );
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
        throw new Error('Outcome changeset paths must be unique');
    }
    const statsRecord = object(record.stats, 'Outcome changeset stats');
    exactKeys(statsRecord, 'Outcome changeset stats', [
        'additions',
        'modifications',
        'deletions',
        'binary_files',
    ]);
    const stats = {
        additions: nonNegativeInteger(statsRecord.additions, 'Changeset additions'),
        modifications: nonNegativeInteger(
            statsRecord.modifications,
            'Changeset modifications'
        ),
        deletions: nonNegativeInteger(statsRecord.deletions, 'Changeset deletions'),
        binary_files: nonNegativeInteger(
            statsRecord.binary_files,
            'Changeset binary_files'
        ),
    };
    const expected = {
        additions: entries.filter((entry) => entry.operation === 'add').length,
        modifications: entries.filter((entry) => entry.operation === 'modify').length,
        deletions: entries.filter((entry) => entry.operation === 'delete').length,
    };
    if (
        stats.additions !== expected.additions ||
        stats.modifications !== expected.modifications ||
        stats.deletions !== expected.deletions
    ) {
        throw new Error('Outcome changeset stats do not match its entries');
    }
    const gitRevision = optionalString(base.git_revision, 'Base git revision', 255);
    return {
        id: identifier(record.id, identifierPattern, 'Outcome changeset ID'),
        workspace: parseWorkspace(record.workspace),
        base: {
            snapshot_digest: digest(base.snapshot_digest, 'Base snapshot digest'),
            ...(gitRevision ? { git_revision: gitRevision } : {}),
        },
        entries,
        ...(record.review !== undefined
            ? { review: parseDescriptor(record.review, 'Changeset review') }
            : {}),
        stats,
    };
}

function parseWorkspace(value: unknown): OutcomeWorkspace {
    const record = object(value, 'Outcome workspace');
    const kind = oneOf(
        record.kind,
        ['primary', 'named'] as const,
        'Outcome workspace kind'
    );
    exactKeys(
        record,
        'Outcome workspace',
        kind === 'named' ? ['kind', 'name'] : ['kind']
    );
    if (kind === 'primary') return { kind };
    return { kind, name: requiredString(record.name, 'Outcome workspace name', 128) };
}

function parseChangeEntry(value: unknown): OutcomeChangeEntry {
    const record = object(value, 'Outcome change entry');
    exactKeys(record, 'Outcome change entry', ['path', 'operation', 'before', 'after']);
    const operation = oneOf(
        record.operation,
        ['add', 'modify', 'delete'] as const,
        'Outcome change operation'
    );
    const before =
        record.before === undefined ? undefined : parseFingerprint(record.before);
    const after = record.after === undefined ? undefined : parseState(record.after);
    if (operation === 'add' && (before || !after)) {
        throw new Error('Added outcome entry must have only an after state');
    }
    if (operation === 'modify' && (!before || !after)) {
        throw new Error('Modified outcome entry must have before and after states');
    }
    if (operation === 'delete' && (!before || after)) {
        throw new Error('Deleted outcome entry must have only a before state');
    }
    return {
        path: safeRelativePath(record.path, 'Outcome change path'),
        operation,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
    };
}

function parseFingerprint(value: unknown): OutcomePathFingerprint {
    const record = object(value, 'Outcome path fingerprint');
    const kind = oneOf(
        record.kind,
        ['file', 'symlink'] as const,
        'Outcome path fingerprint kind'
    );
    if (kind === 'file') {
        exactKeys(record, 'Outcome file fingerprint', [
            'kind',
            'digest',
            'mode',
            'size_bytes',
        ]);
        return {
            kind,
            digest: digest(record.digest, 'Outcome file fingerprint digest'),
            mode: mode(record.mode),
            size_bytes: nonNegativeInteger(
                record.size_bytes,
                'Outcome file fingerprint size_bytes'
            ),
        };
    }
    exactKeys(record, 'Outcome symlink fingerprint', ['kind', 'mode', 'target']);
    return {
        kind,
        mode: mode(record.mode),
        target: safeSymlinkTarget(record.target),
    };
}

function parseState(value: unknown): OutcomePathState {
    const record = object(value, 'Outcome path state');
    const kind = oneOf(
        record.kind,
        ['file', 'symlink'] as const,
        'Outcome path state kind'
    );
    if (kind === 'file') {
        exactKeys(record, 'Outcome file state', ['kind', 'content', 'mode']);
        return {
            kind,
            content: parseDescriptor(record.content, 'Outcome file content'),
            mode: mode(record.mode),
        };
    }
    exactKeys(record, 'Outcome symlink state', ['kind', 'mode', 'target']);
    return {
        kind,
        mode: mode(record.mode),
        target: safeSymlinkTarget(record.target),
    };
}

function parseArtifact(value: unknown): OutcomeArtifact {
    const record = object(value, 'Outcome artifact');
    exactKeys(record, 'Outcome artifact', [
        'id',
        'name',
        'path',
        'content',
        'description',
    ]);
    const description = optionalString(
        record.description,
        'Outcome artifact description',
        4_096
    );
    return {
        id: identifier(record.id, identifierPattern, 'Outcome artifact ID'),
        name: requiredString(record.name, 'Outcome artifact name', 512),
        ...(record.path !== undefined ? { path: safeArtifactPath(record.path) } : {}),
        content: parseDescriptor(record.content, 'Outcome artifact content'),
        ...(description ? { description } : {}),
    };
}

function parseLink(value: unknown): OutcomeLink {
    const record = object(value, 'Outcome link');
    exactKeys(record, 'Outcome link', ['id', 'label', 'uri', 'kind']);
    const kind = parseLinkKind(record.kind);
    return {
        id: identifier(record.id, identifierPattern, 'Outcome link ID'),
        label: requiredString(record.label, 'Outcome link label', 512),
        uri: webUri(record.uri),
        ...(kind ? { kind } : {}),
    };
}

function parseDeclaredLink(value: unknown): Omit<OutcomeLink, 'id'> {
    const record = object(value, 'Declared outcome link');
    exactKeys(record, 'Declared outcome link', ['label', 'uri', 'kind']);
    const kind = parseLinkKind(record.kind);
    return {
        label: requiredString(record.label, 'Declared outcome link label', 512),
        uri: webUri(record.uri),
        ...(kind ? { kind } : {}),
    };
}

function parseLinkKind(value: unknown): OutcomeLink['kind'] {
    return value === undefined
        ? undefined
        : oneOf(
              value,
              ['pull_request', 'preview', 'external'] as const,
              'Outcome link kind'
          );
}

function parseWarning(value: unknown): OutcomeWarning {
    const record = object(value, 'Outcome warning');
    exactKeys(record, 'Outcome warning', ['code', 'message']);
    return {
        code: requiredString(record.code, 'Outcome warning code', 128),
        message: requiredString(record.message, 'Outcome warning message', 4_096),
    };
}

function parseDescriptor(value: unknown, label: string): OutcomeContentDescriptor {
    const record = object(value, label);
    exactKeys(record, label, ['digest', 'media_type', 'size_bytes']);
    return {
        digest: digest(record.digest, `${label} digest`),
        media_type: requiredString(record.media_type, `${label} media_type`, 255),
        size_bytes: nonNegativeInteger(record.size_bytes, `${label} size_bytes`),
    };
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value;
}

function optionalArray(value: unknown, label: string): unknown[] | undefined {
    return value === undefined ? undefined : array(value, label);
}

function exactKeys(
    value: Record<string, unknown>,
    label: string,
    allowed: string[]
): void {
    const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) {
        throw new Error(
            `${label} contains unsupported fields: ${unexpected.join(', ')}`
        );
    }
}

function requiredString(value: unknown, label: string, maximum: number): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`);
    }
    if (value.length > maximum) throw new Error(`${label} is too long`);
    if (
        /\p{Cc}/u.test(
            value.replaceAll('\n', '').replaceAll('\r', '').replaceAll('\t', '')
        )
    ) {
        throw new Error(`${label} contains unsupported control characters`);
    }
    return value;
}

function optionalString(
    value: unknown,
    label: string,
    maximum: number
): string | undefined {
    if (value === undefined) return undefined;
    return requiredString(value, label, maximum);
}

function identifier(value: unknown, pattern: RegExp, label: string): string {
    const parsed = requiredString(value, label, 128);
    if (!pattern.test(parsed)) throw new Error(`${label} is invalid`);
    return parsed;
}

function digest(value: unknown, label: string): OutcomeDigest {
    const parsed = requiredString(value, label, 71);
    if (!digestPattern.test(parsed)) throw new Error(`${label} is invalid`);
    return parsed as OutcomeDigest;
}

function requiredLiteral(value: unknown, expected: number, label: string): void {
    if (value !== expected) throw new Error(`${label} must be ${expected}`);
}

function oneOf<T extends string>(
    value: unknown,
    allowed: readonly T[],
    label: string
): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
    }
    return value as T;
}

function timestamp(value: unknown, label: string): string {
    const parsed = requiredString(value, label, 64);
    const date = new Date(parsed);
    if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== parsed.slice(0, 19)
    ) {
        throw new Error(`${label} must be an RFC 3339 UTC timestamp`);
    }
    return parsed;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
    return value === undefined ? undefined : timestamp(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return value as number;
}

function mode(value: unknown): number {
    const parsed = nonNegativeInteger(value, 'Outcome path mode');
    if (parsed > 0o777) throw new Error('Outcome path mode must be between 0 and 0777');
    return parsed;
}

function safeRelativePath(value: unknown, label: string): string {
    const parsed = requiredString(value, label, 4_096).replaceAll('\\', '/');
    if (
        isAbsolute(parsed) ||
        /^[a-z]:/i.test(parsed) ||
        parsed.startsWith('/') ||
        parsed === '.' ||
        parsed.endsWith('/') ||
        /\p{Cc}/u.test(parsed) ||
        parsed.includes('\0') ||
        parsed
            .split('/')
            .some((segment) => !segment || segment === '.' || segment === '..') ||
        posix.normalize(parsed) !== parsed
    ) {
        throw new Error(`${label} must be a safe relative path`);
    }
    return parsed;
}

function safeSymlinkTarget(value: unknown): string {
    const target = requiredString(value, 'Outcome symlink target', 4_096);
    if (isAbsolute(target) || /\p{Cc}/u.test(target)) {
        throw new Error('Outcome symlink target must be relative');
    }
    return target;
}

function webUri(value: unknown): string {
    const parsed = requiredString(value, 'Outcome link URI', 8_192);
    if (/\p{Cc}/u.test(parsed))
        throw new Error('Outcome link URI contains control characters');
    let url: URL;
    try {
        url = new URL(parsed);
    } catch {
        throw new Error('Outcome link URI must be an absolute URL');
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
        throw new Error('Outcome link URI must use HTTP or HTTPS');
    }
    if (url.username || url.password)
        throw new Error('Outcome link URI must not contain credentials');
    return url.toString();
}

function uniqueIds(values: Array<{ id: string }>, label: string): void {
    const ids = values.map((value) => value.id);
    if (new Set(ids).size !== ids.length) throw new Error(`${label} must be unique`);
}
