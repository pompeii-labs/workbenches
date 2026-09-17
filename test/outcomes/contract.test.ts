import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import {
    assertSafeOutcomePath,
    parseDeclaredOutcome,
    parseOutcomeApplicationReceipt,
    parseRunOutcome,
} from '../../src/outcomes/index.js';

const digest = `sha256:${'a'.repeat(64)}`;
const ajv = new Ajv2020({ allErrors: true });
ajv.addFormat('date-time', fullFormats['date-time']);
ajv.addFormat('uri', fullFormats.uri);

async function schemaValidator(name: string) {
    const source = await readFile(
        join(import.meta.dir, '..', '..', 'schemas', 'outcomes', 'v1', name),
        'utf8'
    );
    const schema = JSON.parse(source);
    return ajv.getSchema(schema.$id) ?? ajv.compile(schema);
}

function validOutcome(): Record<string, unknown> {
    return {
        version: 1,
        id: 'wbo_1234567890abcdefghij',
        run_id: 'wb_1234567890abcdefghij',
        created_at: '2026-09-15T12:00:00.000Z',
        completeness: 'complete',
        summary: 'Created the requested files.',
        changesets: [
            {
                id: 'change_primary',
                workspace: { kind: 'primary' },
                base: { snapshot_digest: digest, git_revision: 'abc123' },
                entries: [
                    {
                        path: 'src/new.ts',
                        operation: 'add',
                        after: {
                            kind: 'file',
                            mode: 0o644,
                            content: {
                                digest,
                                media_type: 'text/typescript',
                                size_bytes: 12,
                            },
                        },
                    },
                    {
                        path: 'old.txt',
                        operation: 'delete',
                        before: {
                            kind: 'file',
                            digest,
                            mode: 0o644,
                            size_bytes: 8,
                        },
                    },
                ],
                review: {
                    digest,
                    media_type: 'text/x-diff',
                    size_bytes: 48,
                },
                stats: {
                    additions: 1,
                    modifications: 0,
                    deletions: 1,
                    binary_files: 0,
                },
            },
        ],
        artifacts: [
            {
                id: 'artifact_report',
                name: 'report.html',
                content: {
                    digest,
                    media_type: 'text/html',
                    size_bytes: 100,
                },
            },
        ],
        links: [
            {
                id: 'link_preview',
                label: 'Preview',
                uri: 'https://example.com/preview',
                kind: 'preview',
            },
        ],
        warnings: [{ code: 'partial_metadata', message: 'A harmless warning.' }],
    };
}

describe('run outcome contract', () => {
    test('validates outbox-only turn snapshots at both contract boundaries', async () => {
        const validate = await schemaValidator('outcome.schema.json');
        const snapshot = {
            ...validOutcome(),
            completeness: 'partial',
            changesets: [],
            turn_index: 2,
        };
        expect(parseRunOutcome(snapshot).turn_index).toBe(2);
        expect(validate(snapshot), JSON.stringify(validate.errors)).toBeTrue();
        for (const invalid of [
            { ...snapshot, turn_index: 0 },
            { ...snapshot, turn_index: -1 },
            { ...snapshot, turn_index: 1.5 },
            { ...snapshot, turn_index: Number.MAX_SAFE_INTEGER + 1 },
            { ...snapshot, completeness: 'complete' },
            { ...snapshot, changesets: validOutcome().changesets },
        ]) {
            expect(() => parseRunOutcome(invalid)).toThrow();
            expect(validate(invalid)).toBeFalse();
        }
    });
    test('parses a complete portable outcome', () => {
        expect(parseRunOutcome(validOutcome()) as unknown).toEqual(validOutcome());
    });

    test('validates original artifact paths independently of display names at both boundaries', async () => {
        const validate = await schemaValidator('outcome.schema.json');
        const candidate = parseRunOutcome(validOutcome());
        const artifact = candidate.artifacts[0];
        if (!artifact) throw new Error('Expected artifact fixture');
        artifact.name = 'Research findings';
        for (const path of ['x', 'reports/index.html', 'assets/résumé.svg']) {
            artifact.path = path;
            expect(parseRunOutcome(candidate)).toEqual(candidate);
            expect(validate(candidate), JSON.stringify(validate.errors)).toBeTrue();
        }
        for (const path of [
            '../x',
            '/x',
            'C:/x',
            'a/../x',
            'a//x',
            'x\\y',
            'x/',
            'outcome.json',
            ' ',
            'x\n',
        ]) {
            artifact.path = path;
            expect(() => parseRunOutcome(candidate)).toThrow('safe relative path');
            expect(validate(candidate), path).toBeFalse();
        }
    });

    test('rejects path traversal and operation/state mismatches', () => {
        const traversal = validOutcome();
        const changeset = (traversal.changesets as Array<Record<string, unknown>>)[0];
        const entry = ((changeset?.entries ?? []) as Array<Record<string, unknown>>)[0];
        if (entry) entry.path = '../secret';
        expect(() => parseRunOutcome(traversal)).toThrow('safe relative path');

        const mismatch = validOutcome();
        const mismatchChangeset = (
            mismatch.changesets as Array<Record<string, unknown>>
        )[0];
        const mismatchEntry = (
            (mismatchChangeset?.entries ?? []) as Array<Record<string, unknown>>
        )[0];
        if (mismatchEntry)
            mismatchEntry.before = { kind: 'symlink', mode: 0o777, target: 'x' };
        expect(() => parseRunOutcome(mismatch)).toThrow(
            'Added outcome entry must have only an after state'
        );
    });

    test('rejects duplicate child IDs and inconsistent stats', () => {
        const duplicate = validOutcome();
        const links = duplicate.links as Array<Record<string, unknown>>;
        links[0] = { ...links[0], id: 'artifact_report' };
        expect(() => parseRunOutcome(duplicate)).toThrow(
            'Outcome child IDs must be unique'
        );

        const inconsistent = validOutcome();
        const changeset = (
            inconsistent.changesets as Array<Record<string, unknown>>
        )[0];
        if (changeset) {
            changeset.stats = {
                additions: 2,
                modifications: 0,
                deletions: 1,
                binary_files: 0,
            };
        }
        expect(() => parseRunOutcome(inconsistent)).toThrow('stats do not match');
    });

    test('validates application receipt transitions', () => {
        expect(
            parseOutcomeApplicationReceipt({
                version: 1,
                outcome_id: 'wbo_1234567890abcdefghij',
                state: 'applied',
                updated_at: '2026-09-15T12:00:01.000Z',
                applied_at: '2026-09-15T12:00:01.000Z',
            }).state
        ).toBe('applied');
        expect(() =>
            parseOutcomeApplicationReceipt({
                version: 1,
                outcome_id: 'wbo_1234567890abcdefghij',
                state: 'pending',
                updated_at: '2026-09-15T12:00:01.000Z',
                applied_at: '2026-09-15T12:00:01.000Z',
            })
        ).toThrow('Only an applied outcome receipt');
    });

    test('parses bounded, safe harness-declared metadata', () => {
        expect(
            parseDeclaredOutcome({
                version: 1,
                summary: 'Research complete.',
                artifacts: [
                    {
                        path: 'report/index.html',
                        name: 'Research report',
                        media_type: 'text/html',
                    },
                ],
                links: [
                    {
                        label: 'Source',
                        uri: 'https://example.com/source',
                        kind: 'external',
                    },
                ],
            }).artifacts?.[0]?.path
        ).toBe('report/index.html');
        expect(() =>
            parseDeclaredOutcome({
                version: 1,
                artifacts: [{ path: '/etc/passwd' }],
            })
        ).toThrow('safe relative path');
    });

    test('normalizes platform separators before validating paths', () => {
        expect(assertSafeOutcomePath('reports\\result.txt')).toBe('reports/result.txt');
        expect(() => assertSafeOutcomePath('C:\\private\\result.txt')).toThrow(
            'safe relative path'
        );
    });

    test('accepts canonical outcomes in the published JSON Schema, including one-character paths', async () => {
        const validate = await schemaValidator('outcome.schema.json');
        const candidate = parseRunOutcome(validOutcome());
        const entry = candidate.changesets[0]?.entries[0];
        if (!entry) throw new Error('Expected changeset fixture');
        for (const path of ['x', 'src/x', 'résumé.txt']) {
            entry.path = path;
            expect(validate(candidate), JSON.stringify(validate.errors)).toBeTrue();
            expect(parseRunOutcome(candidate)).toEqual(candidate);
        }
        for (const path of [
            '/x',
            '../x',
            'src/../x',
            'src//x',
            'src/x/',
            'C:/x',
            'x\n',
        ]) {
            entry.path = path;
            expect(validate(candidate), path).toBeFalse();
            expect(() => parseRunOutcome(candidate)).toThrow('safe relative path');
        }
    });

    test('rejects non-RFC-3339 and impossible calendar timestamps at both boundaries', async () => {
        const validate = await schemaValidator('outcome.schema.json');
        for (const timestamp of [
            '09/15/2026Z',
            '2026-02-30T12:00:00Z',
            '2026-09-15T12:00:00+01:00',
        ]) {
            const candidate = { ...validOutcome(), created_at: timestamp };
            expect(validate(candidate)).toBeFalse();
            expect(() => parseRunOutcome(candidate)).toThrow('RFC 3339');
        }
    });

    test('validates all receipt states with a standards-compliant JSON Schema validator', async () => {
        const validate = await schemaValidator('application.schema.json');
        for (const state of ['pending', 'present', 'applied'] as const) {
            const receipt = {
                version: 1 as const,
                outcome_id: 'wbo_1234567890abcdefghij',
                state,
                updated_at: '2026-09-15T12:00:00Z',
                ...(state === 'applied' ? { applied_at: '2026-09-15T12:00:00Z' } : {}),
            };
            expect(validate(receipt), JSON.stringify(validate.errors)).toBeTrue();
            expect(parseOutcomeApplicationReceipt(receipt)).toEqual(receipt);
            const invalid: Record<string, unknown> = {
                ...receipt,
                applied_at: state === 'applied' ? undefined : '2026-09-15T12:00:00Z',
            };
            if (state === 'applied') delete invalid.applied_at;
            expect(validate(invalid)).toBeFalse();
            expect(() => parseOutcomeApplicationReceipt(invalid)).toThrow();
        }
    });

    test('validates the outbox example in the public contract and its schema identity', async () => {
        const validate = await schemaValidator('outbox.schema.json');
        const docs = await readFile(
            join(import.meta.dir, '..', '..', 'docs', 'OUTCOMES.md'),
            'utf8'
        );
        const example = docs.match(/```json\n([\s\S]*?)\n```/)?.[1];
        if (!example) throw new Error('Expected public outbox JSON example');
        const declaration = JSON.parse(example);
        expect(validate(declaration), JSON.stringify(validate.errors)).toBeTrue();
        expect(parseDeclaredOutcome(declaration)).toEqual(declaration);
        expect(validate.schema).toMatchObject({
            $id: 'https://workbenches.dev/schemas/outcomes/v1/outbox.schema.json',
        });
    });

    test('publishes the versioned schema at the stable URL', async () => {
        const schema = JSON.parse(
            await readFile(
                join(
                    import.meta.dir,
                    '..',
                    '..',
                    'schemas',
                    'outcomes',
                    'v1',
                    'outcome.schema.json'
                ),
                'utf8'
            )
        ) as Record<string, unknown>;
        expect(schema.$id).toBe(
            'https://workbenches.dev/schemas/outcomes/v1/outcome.schema.json'
        );
    });
});
