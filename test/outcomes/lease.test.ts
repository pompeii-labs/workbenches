import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeStorageLease } from '../../src/outcomes/lease.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-lease-'));
    directories.push(root);
    await mkdir(join(root, '.lease'));
    return root;
}

describe('OutcomeStorageLease', () => {
    test('serializes contenders while recovering crashed owners, including choosing tickets', async () => {
        const root = await fixture();
        for (const choosing of [true, false])
            await writeFile(
                join(root, '.lease', `2147483647.${crypto.randomUUID()}.json`),
                JSON.stringify({ pid: 2147483647, choosing, number: choosing ? 0 : 1 })
            );
        let active = 0;
        let peak = 0;
        await Promise.all(
            Array.from({ length: 12 }, () =>
                new OutcomeStorageLease(root).exclusive(async () => {
                    peak = Math.max(peak, ++active);
                    await Bun.sleep(5);
                    active--;
                })
            )
        );
        expect(peak).toBe(1);
        expect(await readdir(join(root, '.lease'))).toEqual([]);
    });

    test('serializes separate engine processes and leaves no owner tickets', async () => {
        const root = await fixture();
        await writeFile(join(root, 'counter'), '0');
        await writeFile(
            join(root, '.lease', `2147483647.${crypto.randomUUID()}.json`),
            JSON.stringify({ pid: 2147483647, choosing: false, number: 1 })
        );
        const source = new URL('../../src/outcomes/lease.ts', import.meta.url).pathname;
        const script = `import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path'; import {OutcomeStorageLease} from ${JSON.stringify(source)}; const root=process.argv[1]; for(let i=0;i<4;i++) await new OutcomeStorageLease(root).exclusive(async()=>{const path=join(root,'counter');const n=Number(await readFile(path,'utf8')); await Bun.sleep(5); await writeFile(path,String(n+1));});`;
        const children = Array.from({ length: 6 }, () =>
            Bun.spawn([process.execPath, '-e', script, root], {
                env: { PATH: process.env.PATH },
                stdout: 'pipe',
                stderr: 'pipe',
            })
        );
        await Promise.all(
            children.map(async (child) => {
                const error = await new Response(child.stderr).text();
                expect(await child.exited, error).toBe(0);
            })
        );
        expect(await readFile(join(root, 'counter'), 'utf8')).toBe('24');
        expect(await readdir(join(root, '.lease'))).toEqual([]);
    });

    test('releases its own ticket when the operation fails', async () => {
        const root = await fixture();
        await expect(
            new OutcomeStorageLease(root).exclusive(async () => {
                throw new Error('failed');
            })
        ).rejects.toThrow('failed');
        expect(await new OutcomeStorageLease(root).exclusive(async () => 'retry')).toBe(
            'retry'
        );
        expect(await readdir(join(root, '.lease'))).toEqual([]);
    });

    test('rejects symlinked lease directories and owner tickets', async () => {
        const root = await fixture();
        const outside = await fixture();
        await rm(join(root, '.lease'), { recursive: true });
        await symlink(outside, join(root, '.lease'));
        await expect(
            new OutcomeStorageLease(root).exclusive(async () => {})
        ).rejects.toThrow('real directory');
        await rm(join(root, '.lease'));
        await mkdir(join(root, '.lease'));
        const ticket = join(outside, 'owner');
        await writeFile(
            ticket,
            JSON.stringify({ pid: process.pid, choosing: false, number: 1 })
        );
        await symlink(
            ticket,
            join(root, '.lease', `${process.pid}.${crypto.randomUUID()}.json`)
        );
        await expect(
            new OutcomeStorageLease(root).exclusive(async () => {})
        ).rejects.toThrow('Invalid outcome storage lease ticket');
    });
});
