import { defineCommand } from 'citty';

import { RegistryTelemetry } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

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
        const output = new CliPresenter();
        const state = args.state ?? 'status';
        if (state !== 'on' && state !== 'off' && state !== 'status') {
            throw new Error('Telemetry state must be on, off, or status');
        }
        const telemetry = new RegistryTelemetry();
        if (state === 'on' || state === 'off') {
            await telemetry.setEnabled(state === 'on');
        }
        const enabled = await telemetry.enabled();
        const stateLabel = enabled ? 'on' : 'off';
        output.record({
            machine: [`anonymous run reporting: ${stateLabel}`],
            title: `Anonymous run reporting is ${stateLabel}`,
            tone: enabled ? 'success' : 'muted',
        });
    },
});
