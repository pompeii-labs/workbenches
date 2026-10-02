import { describe, expect, test } from 'bun:test';

import { record, string, stringArray } from '../../../src/runners/opencode/json.js';

describe('record', () => {
    test('returns a plain object and nothing else', () => {
        const value = { a: 1 };
        expect(record(value)).toBe(value);
        for (const other of [null, undefined, [], [1], 'x', 1, true]) {
            expect(record(other)).toBe(undefined);
        }
    });
});

describe('string', () => {
    test('returns a non-empty string and nothing else', () => {
        expect(string('x')).toBe('x');
        for (const other of ['', null, undefined, 1, {}, ['x']]) {
            expect(string(other)).toBe(undefined);
        }
    });
});

describe('stringArray', () => {
    test('keeps only the strings of a list', () => {
        expect(stringArray(['a', 1, 'b', null, ''])).toEqual(['a', 'b', '']);
    });

    test('is empty for anything that is not a list', () => {
        for (const other of ['a', null, undefined, { 0: 'a' }, 1]) {
            expect(stringArray(other)).toEqual([]);
        }
    });
});
