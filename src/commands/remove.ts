import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
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
        const entry = await new SavedWorkbenchCatalog(workbenchHome()).remove(
            args.alias
        );
        console.log(`removed\t${entry.alias}`);
    },
});
