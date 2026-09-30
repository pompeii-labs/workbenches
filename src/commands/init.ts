import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { defineCommand } from 'citty';

import { ModelCatalog } from '../models/index.js';
import { runtimeProviderNames } from '../workbench/runtimes.js';
import { CliPresenter } from './presenter.js';

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
        runner: {
            type: 'string',
            description: 'Runner recorded in the generated manifest',
            default: 'opencode',
        },
        model: {
            type: 'string',
            description:
                'Provider-neutral lab/model identifier (defaults to openai/gpt-5.6-terra)',
        },
        runtimes: {
            type: 'string',
            valueHint: 'local,docker',
            description:
                'Comma-separated runtimes to declare, in order (local, docker, e2b, daytona)',
            default: 'local',
        },
        image: {
            type: 'string',
            description: 'Image for the docker and e2b runtimes',
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.name)) {
            throw new Error(`Invalid Workbench name: ${args.name}`);
        }
        const model = args.model ?? 'openai/gpt-5.6-terra';
        const routes = ModelCatalog.current().models[model]?.routes;
        if (!routes || Object.keys(routes).length === 0) {
            throw new Error(
                `Model is not available in the model catalog: ${model}. Configure unknown models directly with explicit routes and runner_config.`
            );
        }
        const runtimes = runtimeLines(args.runtimes, args.image);
        const root = resolve(args.dir ?? process.cwd());
        const directory = resolve(root, '.workbenches', args.name);
        if (await stat(directory).catch(() => null)) {
            throw new Error(`Workbench already exists: ${directory}`);
        }
        await mkdir(directory, { recursive: true });
        await writeFile(
            resolve(directory, 'instructions.md'),
            [
                `# ${args.name}`,
                '',
                "Use this repository's source, documentation, and tests as the authority.",
                'Inspect the relevant implementation before acting, follow documented',
                'project conventions, and report uncertainty instead of inventing behavior.',
                '',
            ].join('\n')
        );
        await writeFile(
            resolve(directory, 'workbench.yml'),
            [
                'spec: 1',
                'version: 0.1.0',
                `name: ${args.name}`,
                `description: Repository-maintained expertise for ${args.name} tasks.`,
                `runner: ${JSON.stringify(args.runner)}`,
                'model:',
                `  id: ${JSON.stringify(model)}`,
                'instructions: ./instructions.md',
                'skills: []',
                'tools: []',
                'mcps: []',
                'env: {}',
                ...runtimes,
                '',
            ].join('\n')
        );
        output.record({
            machine: [directory],
            title: `Created ${args.name}`,
            details: [directory],
        });
    },
});

/** The manifest lines declaring the requested runtimes, in the order given. */
function runtimeLines(value: string, image: string | undefined): string[] {
    const names = value
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    if (names.length === 0)
        throw new Error('--runtimes must name at least one runtime');
    const known = runtimeProviderNames as readonly string[];
    for (const name of names) {
        if (!known.includes(name)) {
            throw new Error(
                `Unknown runtime: ${name}. Known runtimes: ${known.join(', ')}`
            );
        }
    }
    if (new Set(names).size !== names.length) {
        throw new Error('--runtimes must not repeat a runtime');
    }
    const needsImage = names.filter((name) => name === 'docker' || name === 'e2b');
    if (needsImage.length > 0 && !image) {
        throw new Error(
            `--image is required for the ${needsImage.join(' and ')} runtime`
        );
    }
    if (image && needsImage.length === 0) {
        throw new Error('--image applies only to the docker and e2b runtimes');
    }
    return [
        'runtimes:',
        ...names.flatMap((name) => {
            if (name === 'local') return ['  local: {}'];
            if (name === 'daytona') return ['  daytona:', '    class: linux'];
            return [`  ${name}:`, `    image: ${JSON.stringify(image)}`];
        }),
    ];
}
