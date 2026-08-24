import { defineCommand } from 'citty';
import packageMetadata from '../../package.json' with { type: 'json' };

import { availableCliUpdate, installCliUpdate } from '../self-update.js';

export const updateCommand = defineCommand({
    meta: { name: 'update', description: 'Update the Workbench CLI.' },
    args: {
        check: {
            type: 'boolean',
            description: 'Check for an update without installing it',
            default: false,
        },
    },
    async run({ args }) {
        const current = packageMetadata.version;
        const release = await availableCliUpdate(current);
        if (!release) {
            console.log(`current\t${current}`);
            return;
        }
        if (args.check) {
            console.log(`available\t${current}\t${release.version}`);
            return;
        }
        const path = await installCliUpdate(release);
        console.log(`updated\t${current}\t${release.version}\t${path}`);
    },
});
