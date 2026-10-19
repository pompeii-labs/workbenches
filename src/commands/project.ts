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
            const project = await new Services(home, connection).projects.create(
                args.name
            );
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
            const projects = (await new Services(home, connection).projects.list()).map(
                ({ name, slug, created_at }) => ({ name, slug, created_at })
            );
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
                        project.created_at,
                    ],
                    title: project.name,
                    details: [project.slug],
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
        description:
            'Manage local projects or shared organization projects when signed in.',
    },
    subCommands: { create: createCommand, list: listCommand },
});
