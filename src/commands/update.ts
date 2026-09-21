import { defineCommand } from 'citty';
import packageMetadata from '../../package.json' with { type: 'json' };

import { CliUpdater } from '../releases/index.js';
import { CliPresenter } from './presenter.js';

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
        const output = new CliPresenter();
        const current = packageMetadata.version;
        const updater = new CliUpdater();
        output.progress('Checking for a Workbench CLI update');
        const release = await updater.available(current);
        if (!release) {
            output.record({
                machine: ['current', current],
                title: `Workbench ${current} is current`,
            });
            return;
        }
        if (args.check) {
            output.record({
                machine: ['available', current, release.version],
                title: `Workbench ${release.version} is available`,
                details: [`current ${current}`],
                tone: 'info',
            });
            return;
        }
        output.progress(`Installing Workbench ${release.version}`);
        const installation = await updater.install(release);
        output.record({
            machine: [
                installation.pendingRestart ? 'staged' : 'updated',
                current,
                release.version,
                installation.path,
            ],
            title: installation.pendingRestart
                ? process.env.WORKBENCH_UPDATE_WRAPPER === '1'
                    ? `Workbench ${release.version} will be ready after this command exits`
                    : `Workbench ${release.version} is staged; run wb to finish the update`
                : `Updated Workbench to ${release.version}`,
            details: [installation.path],
        });
    },
});
