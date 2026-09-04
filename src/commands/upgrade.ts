import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog, SavedWorkbenchUpgrade } from '../catalog/index.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

export const upgradeCommand = defineCommand({
    meta: {
        name: 'upgrade',
        description: 'Upgrade saved Workbench snapshots from their sources.',
    },
    args: {
        alias: {
            type: 'positional',
            description: 'Saved Workbench alias (defaults to every saved Workbench)',
            required: false,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const home = workbenchHome();
        const entries = await new SavedWorkbenchCatalog(home).list();
        const aliases = args.alias ? [args.alias] : entries.map((entry) => entry.alias);
        if (aliases.length === 0) {
            output.message('No saved Workbenches.');
            return;
        }

        const failures: string[] = [];
        const upgrade = new SavedWorkbenchUpgrade(home);
        for (const alias of aliases) {
            try {
                output.progress(`Checking ${alias} for updates`);
                const result = await upgrade.upgrade(alias);
                if (!result.changed) {
                    output.record({
                        machine: ['current', alias, result.entry.version],
                        title: `${alias} is current`,
                        details: [result.entry.version],
                    });
                    continue;
                }
                output.record({
                    machine: [
                        'upgraded',
                        alias,
                        result.previous.version,
                        result.entry.version,
                    ],
                    title: `Upgraded ${alias}`,
                    details: [`${result.previous.version} to ${result.entry.version}`],
                });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                failures.push(alias);
                output.record({
                    machine: ['failed', alias, detail],
                    title: `Could not upgrade ${alias}`,
                    details: [detail],
                    tone: 'error',
                    stream: 'stderr',
                });
            }
        }
        if (failures.length > 0) {
            throw new Error(
                `${failures.length} saved Workbench${failures.length === 1 ? '' : 'es'} could not be upgraded`
            );
        }
    },
});
