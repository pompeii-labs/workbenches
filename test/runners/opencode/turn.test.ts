import { describe, expect, test } from 'bun:test';

import { TurnSteering } from '../../../src/runners/opencode/turn.js';

/** Settles to 'pending' if the promise has not settled yet. */
async function state(promise: Promise<void>): Promise<string> {
    return Promise.race([
        promise.then(
            () => 'delivered',
            (error: Error) => `failed: ${error.message}`
        ),
        Promise.resolve().then(() => 'pending'),
    ]);
}

describe('TurnSteering', () => {
    test('delivering an input also delivers the ones sent before it', async () => {
        const steering = new TurnSteering();
        const first = steering.add('m1');
        const second = steering.add('m2');
        const third = steering.add('m3');
        steering.deliverThrough('m2');
        expect(await state(first)).toBe('delivered');
        expect(await state(second)).toBe('delivered');
        expect(await state(third)).toBe('pending');
        expect(steering.has('m1')).toBe(false);
        expect(steering.has('m3')).toBe(true);
    });

    test('delivering an unknown input changes nothing', async () => {
        const steering = new TurnSteering();
        const first = steering.add('m1');
        steering.deliverThrough('m9');
        expect(await state(first)).toBe('pending');
    });

    test('dropping an input fails only that input', async () => {
        const steering = new TurnSteering();
        const first = steering.add('m1');
        const second = steering.add('m2');
        steering.drop('m1', new Error('send failed'));
        expect(await state(first)).toBe('failed: send failed');
        steering.deliverThrough('m2');
        expect(await state(second)).toBe('delivered');
    });

    test('rejecting all fails the undelivered inputs and clears them', async () => {
        const steering = new TurnSteering();
        const first = steering.add('m1');
        const second = steering.add('m2');
        steering.deliverThrough('m1');
        steering.rejectAll(new Error('turn ended'));
        expect(await state(first)).toBe('delivered');
        expect(await state(second)).toBe('failed: turn ended');
        expect(steering.has('m2')).toBe(false);
    });

    test('an input nobody awaits does not raise an unhandled rejection', async () => {
        const steering = new TurnSteering();
        steering.add('m1');
        steering.rejectAll(new Error('turn ended'));
        await Bun.sleep(0);
    });
});
