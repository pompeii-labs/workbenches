import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { CloudClient } from '../cloud/client.js';
import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliPresenter } from './presenter.js';

export const unsaveCommand = defineCommand({
    meta: { name: 'unsave', description: 'Remove a saved Workbench alias.' },
    args: {
        cloud: {
            type: 'boolean',
            description:
                'Remove an organization save on the optional workbenches.dev hosted service',
            default: false,
        },
        alias: {
            type: 'positional',
            description: 'Saved Workbench alias, or cloud org/name or save ID',
            required: true,
        },
    },
    async run({ args, data }) {
        if (args.cloud) {
            await CloudClient.from(data).library.unsave(args.alias);
            new CliPresenter().record({
                machine: ['removed', args.alias],
                title: `Removed ${args.alias}`,
            });
            return;
        }
        const home = workbenchHome();
        const catalog = new SavedWorkbenchCatalog(home);
        const existing = await catalog.find(args.alias);
        let entry: Awaited<ReturnType<SavedWorkbenchCatalog['remove']>>;
        if (!existing || existing.localPath) {
            // Nothing to release: a local entry has no snapshot.
            entry = await catalog.remove(args.alias);
        } else {
            const connection = Connection.open(home);
            try {
                entry = await new Services(home, connection).writer.remove(args.alias);
            } finally {
                connection.close();
            }
        }
        new CliPresenter().record({
            machine: ['removed', entry.alias],
            title: `Removed ${entry.alias}`,
        });
    },
});
