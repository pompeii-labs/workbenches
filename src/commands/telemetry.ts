import { defineCommand } from 'citty';

import { workbenchHome } from '../storage.js';
import { runTelemetryEnabled, setRunTelemetry } from '../telemetry.js';

export const telemetryCommand = defineCommand({
    meta: {
        name: 'telemetry',
        description: 'Control anonymous run reporting.',
    },
    args: {
        state: {
            type: 'positional',
            description: 'on, off, or status',
            required: false,
        },
    },
    async run({ args }) {
        const state = args.state ?? 'status';
        if (state !== 'on' && state !== 'off' && state !== 'status') {
            throw new Error('Telemetry state must be on, off, or status');
        }
        const home = workbenchHome();
        if (state === 'on' || state === 'off') {
            await setRunTelemetry(home, state === 'on');
        }
        const enabled = await runTelemetryEnabled(home);
        console.log(`anonymous run reporting: ${enabled ? 'on' : 'off'}`);
    },
});
