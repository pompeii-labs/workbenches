import { defineCommand } from 'citty';

import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliPresenter } from './presenter.js';

const createCommand = defineCommand({
    meta: { name: 'create', description: 'Create a project.' },
    args: {
        name: {
            type: 'positional',
            description: 'Project name',
            required: true,
        },
        json: {
            type: 'boolean',
            description: 'Print the project as JSON',
            default: false,
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const project = new Services(home, connection).projects.create(args.name);
            const result = {
                name: project.name,
                slug: project.slug,
                created_at: project.created_at,
            };
            if (args.json) {
                process.stdout.write(`${JSON.stringify({ project: result })}\n`);
                return;
            }
            new CliPresenter().record({
                machine: ['project', result.name, result.slug, result.created_at],
                title: result.name,
                details: [result.slug],
                tone: 'success',
            });
        } finally {
            connection.close();
        }
    },
});

const listCommand = defineCommand({
    meta: { name: 'list', description: 'List projects.' },
    args: {
        json: {
            type: 'boolean',
            description: 'Print projects as JSON',
            default: false,
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const projects = (
                await new Services(home, connection).studio.board.projects()
            ).map(({ name, slug, counts, created_at }) => ({
                name,
                slug,
                counts,
                created_at,
            }));
            if (args.json) {
                process.stdout.write(`${JSON.stringify({ projects })}\n`);
                return;
            }
            const output = new CliPresenter();
            if (projects.length === 0) {
                output.empty('No projects. Create one with wb project create <name>.');
                return;
            }
            for (const project of projects) {
                output.record({
                    machine: [
                        'project',
                        project.name,
                        project.slug,
                        String(project.counts.needs_you),
                        String(project.counts.running),
                        String(project.counts.done),
                        String(project.counts.failed),
                        project.created_at,
                    ],
                    title: project.name,
                    details: [
                        `${project.counts.needs_you} needs you, ${project.counts.running} running, ${project.counts.done} done, ${project.counts.failed} failed`,
                    ],
                });
            }
        } finally {
            connection.close();
        }
    },
});

export const projectCommand = defineCommand({
    meta: {
        name: 'project',
        description: 'Manage local projects.',
    },
    subCommands: { create: createCommand, list: listCommand },
});
