import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { defineCommand } from 'citty';

export const initCommand = defineCommand({
    meta: { name: 'init', description: 'Scaffold a repository-owned Workbench.' },
    args: {
        name: {
            type: 'positional',
            description: 'Workbench directory name',
            required: true,
        },
        dir: {
            type: 'string',
            description: 'Repository directory (defaults to the current directory)',
        },
    },
    async run({ args }) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name)) {
            throw new Error(`Invalid Workbench name: ${args.name}`);
        }
        const root = resolve(args.dir ?? process.cwd());
        const directory = resolve(root, '.workbenches', args.name);
        if (await stat(directory).catch(() => null)) {
            throw new Error(`Workbench already exists: ${directory}`);
        }
        await mkdir(directory, { recursive: true });
        await writeFile(
            resolve(directory, 'instructions.md'),
            `# ${args.name}\n\nDescribe the expertise and operating rules for this Workbench.\n`
        );
        await writeFile(
            resolve(directory, 'workbench.yml'),
            [
                'spec: 0',
                'version: 0.1.0',
                `name: ${args.name}`,
                `description: Work with ${args.name}.`,
                'runner: opencode',
                '# Provisional cheap baseline; evaluate the model for this Workbench.',
                'model: openrouter/openai/gpt-5.6-luna',
                'instructions: ./instructions.md',
                'skills: []',
                'tools: []',
                'mcps: []',
                'env: {}',
                'runtime: local',
                '',
            ].join('\n')
        );
        console.log(directory);
    },
});
