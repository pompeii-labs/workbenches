import { defineCommand } from 'citty';
import { CloudClient } from '../cloud/client.js';
import { CliPresenter } from './presenter.js';

export const projectListCommand = defineCommand({
    meta: {
        name: 'list',
        description: 'List organization projects on workbenches.dev.',
    },
    args: {
        json: {
            type: 'boolean',
            description: 'Print projects as JSON',
            default: false,
        },
    },
    async run({ args, data }) {
        const projects = await CloudClient.from(data).projects.list();
        if (args.json) console.log(JSON.stringify(projects));
        else {
            const output = new CliPresenter();
            if (!projects.length) output.message('No organization projects.');
            for (const project of projects)
                output.record({
                    machine: [project.slug, project.name],
                    title: project.name,
                    details: [project.slug],
                });
        }
    },
});

export const projectCreateCommand = defineCommand({
    meta: {
        name: 'create',
        description: 'Create an organization project on workbenches.dev.',
    },
    args: {
        name: { type: 'positional', description: 'Project name', required: true },
        json: {
            type: 'boolean',
            description: 'Print the project as JSON',
            default: false,
        },
    },
    async run({ args, data }) {
        const project = await CloudClient.from(data).projects.create(args.name);
        if (args.json) console.log(JSON.stringify(project));
        else
            new CliPresenter().record({
                machine: ['created', project.slug, project.name],
                title: `Created ${project.name}`,
                details: [project.slug],
            });
    },
});

export const projectCommand = defineCommand({
    meta: {
        name: 'project',
        description: 'Manage projects on the optional workbenches.dev hosted service.',
    },
    subCommands: { list: projectListCommand, create: projectCreateCommand },
});
