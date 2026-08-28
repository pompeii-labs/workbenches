import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog, SavedWorkbenchUpgrade } from '../catalog/index.js';
import { workbenchHome } from '../storage.js';

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
        const home = workbenchHome();
        const entries = await new SavedWorkbenchCatalog(home).list();
        const aliases = args.alias ? [args.alias] : entries.map((entry) => entry.alias);
        if (aliases.length === 0) {
            console.log('No saved Workbenches.');
            return;
        }

        const failures: string[] = [];
        const upgrade = new SavedWorkbenchUpgrade(home);
        for (const alias of aliases) {
            try {
                const result = await upgrade.upgrade(alias);
                if (!result.changed) {
                    console.log(`current\t${alias}\t${result.entry.version}`);
                    continue;
                }
                console.log(
                    `upgraded\t${alias}\t${result.previous.version}\t${result.entry.version}`
                );
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                failures.push(alias);
                console.error(`failed\t${alias}\t${detail}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(
                `${failures.length} saved Workbench${failures.length === 1 ? '' : 'es'} could not be upgraded`
            );
        }
    },
});
