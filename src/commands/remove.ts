import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliPresenter } from './presenter.js';

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
