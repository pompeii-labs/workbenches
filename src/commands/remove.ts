import { defineCommand } from 'citty';

import { removeFromCatalog } from '../catalog.js';
import { workbenchHome } from '../storage.js';

export const removeCommand = defineCommand({
    meta: { name: 'remove', description: 'Remove a saved Workbench alias.' },
    args: {
        alias: {
            type: 'positional',
            description: 'Saved Workbench alias',
            required: true,
        },
    },
    async run({ args }) {
        const entry = await removeFromCatalog(workbenchHome(), args.alias);
        console.log(`removed\t${entry.alias}`);
    },
});
