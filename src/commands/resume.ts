import { defineCommand } from 'citty';

import { SessionResolver } from '../sessions/index.js';
import { workbenchHome } from '../storage.js';
import { launchWorkbenchTui } from '../tui.js';

export const resumeCommand = defineCommand({
    meta: {
        name: 'resume',
        description: 'Continue a resumable Workbench session.',
    },
    args: {
        session: {
            type: 'positional',
            description: 'Workbench session ID',
            required: true,
        },
    },
    async run({ args }) {
        const target = await new SessionResolver(workbenchHome()).resolve(args.session);
        await launchWorkbenchTui({ initial: target });
    },
});
