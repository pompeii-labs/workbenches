import { defineCommand } from 'citty';

import { WorkbenchInspector } from '../workbench/index.js';

export const viewCommand = defineCommand({
    meta: {
        name: 'view',
        description: 'Show resolved Workbench configuration and provenance.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local/remote Workbench reference',
            required: true,
        },
        json: {
            type: 'boolean',
            description: 'Emit the resolved view as JSON',
            default: false,
        },
    },
    async run({ args }) {
        const inspection = await new WorkbenchInspector().inspect(args.workbench);
        process.stdout.write(
            args.json ? `${JSON.stringify(inspection)}\n` : inspection.render()
        );
    },
});
