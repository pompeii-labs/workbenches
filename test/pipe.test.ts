import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { exitOnBrokenPipe } from '../src/commands/pipe.js';

describe('CLI pipe handling', () => {
    test('exits successfully when a downstream pipe closes', () => {
        const stream = new EventEmitter();
        const exits: number[] = [];
        exitOnBrokenPipe(stream, (code) => {
            exits.push(code);
            throw new ExitSignal();
        });
        const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });

        expect(() => stream.emit('error', error)).toThrow(ExitSignal);
        expect(exits).toEqual([0]);
    });

    test('does not hide unrelated output failures', () => {
        const stream = new EventEmitter();
        exitOnBrokenPipe(stream, () => {
            throw new Error('unexpected exit');
        });
        const error = Object.assign(new Error('output failed'), { code: 'EIO' });

        expect(() => stream.emit('error', error)).toThrow(error);
    });
});

class ExitSignal extends Error {}
