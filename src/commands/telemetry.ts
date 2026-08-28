import { defineCommand } from 'citty';

import { RegistryTelemetry } from '../registry/index.js';

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
        const telemetry = new RegistryTelemetry();
        if (state === 'on' || state === 'off') {
            await telemetry.setEnabled(state === 'on');
        }
        const enabled = await telemetry.enabled();
        console.log(`anonymous run reporting: ${enabled ? 'on' : 'off'}`);
    },
});
