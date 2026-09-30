import { describe, expect, test } from 'bun:test';

import type { RunnerFiles } from '../../src/runners/files.js';
import { stageOpenCodeSkillsWith } from '../../src/runners/opencode/staging.js';
import type { ResolvedWorkbench } from '../../src/types.js';

/** A storage with no disk behind it, to show adapters only need the interface. */
class MemoryFiles implements RunnerFiles {
    readonly entries = new Map<string, Uint8Array | 'directory'>();
    readonly modes = new Map<string, number>();
    private temporary = 0;

    constructor(initial: Record<string, string>) {
        for (const [path, text] of Object.entries(initial)) {
            this.entries.set(path, new TextEncoder().encode(text));
        }
    }

    async readFile(path: string) {
        const entry = this.entries.get(path);
        if (!(entry instanceof Uint8Array)) throw new Error(`No such file: ${path}`);
        return entry;
    }

    async writeFile(
        path: string,
        data: string | Uint8Array,
        options: { mode?: number; exclusive?: boolean } = {}
    ) {
        if (options.exclusive && this.entries.has(path)) {
            throw new Error(`Already exists: ${path}`);
        }
        this.entries.set(
            path,
            typeof data === 'string' ? new TextEncoder().encode(data) : data
        );
        if (options.mode !== undefined) this.modes.set(path, options.mode);
    }

    async mkdir(path: string, options: { recursive?: boolean } = {}) {
        if (this.entries.has(path) && !options.recursive) {
            throw new Error(`Already exists: ${path}`);
        }
        this.entries.set(path, 'directory');
    }

    async list(path: string) {
        return [...this.entries.keys()]
            .filter((key) => key.startsWith(`${path}/`))
            .map((key) => key.slice(path.length + 1).split('/')[0] as string);
    }

    async stat(path: string) {
        const entry = this.entries.get(path);
        if (entry === undefined) return undefined;
        return entry === 'directory'
            ? { kind: 'directory' as const, size: 0 }
            : { kind: 'file' as const, size: entry.byteLength };
    }

    async tempDirectory(prefix: string) {
        const path = `/memory/${prefix}${this.temporary++}`;
        this.entries.set(path, 'directory');
        return path;
    }

    async copy(from: string, to: string) {
        for (const [key, value] of [...this.entries]) {
            if (key === from || key.startsWith(`${from}/`)) {
                this.entries.set(`${to}${key.slice(from.length)}`, value);
            }
        }
    }

    async chmod(path: string, mode: number) {
        this.modes.set(path, mode);
    }

    async remove(path: string) {
        for (const key of [...this.entries.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key);
        }
    }
}

describe('runner file staging', () => {
    test('stages OpenCode skills and context without a local filesystem', async () => {
        const files = new MemoryFiles({
            '/pkg/instructions.md': '# Authored behavior',
            '/pkg/skills/review/SKILL.md': 'Review carefully.',
        });
        const workbench = {
            manifestPath: '/pkg/workbench.yml',
            packageDirectory: '/pkg',
            repositoryDirectory: '/pkg',
            instructionsPath: '/pkg/instructions.md',
            skills: [
                {
                    name: 'review',
                    directory: '/pkg/skills/review',
                    manifestPath: '/pkg/skills/review/SKILL.md',
                },
            ],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'probe',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                instructions: './instructions.md',
                skills: ['./skills/review'],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'local',
            },
        } as unknown as ResolvedWorkbench;

        const staged = await stageOpenCodeSkillsWith(files, workbench);

        expect(staged.directory).toStartWith('/memory/workbench-opencode-');
        expect(files.entries.has(`${staged.directory}/skills/review/SKILL.md`)).toBe(
            true
        );
        const prefix = new TextDecoder().decode(
            await files.readFile(staged.context.prefix)
        );
        expect(prefix).toContain('# Authored behavior');
        expect(files.modes.get(staged.context.prefix)).toBe(0o444);
        expect(files.modes.get(staged.directory)).toBe(0o555);

        await staged.cleanup();
        expect(await files.stat(staged.directory)).toBeUndefined();
    });
});
