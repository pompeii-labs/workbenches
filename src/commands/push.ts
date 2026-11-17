import { defineCommand } from 'citty';

import { RegistryPublisher, type RegistryPushedVersion } from '../registry/index.js';
import { WorkbenchResolver } from '../workbench/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter, type CliRecord } from './presenter.js';

export const pushCommand = defineCommand({
    meta: {
        name: 'push',
        description: 'Store a new Workbench version in your organization, internal.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Local package (.#name, /path#name) or saved alias',
            required: false,
        },
        org: orgArgument,
        as: {
            type: 'string',
            description: 'Registry name (defaults to the manifest name)',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const { workbench } = await new WorkbenchResolver().resolve(args.source ?? '.');
        const publisher = new RegistryPublisher();
        const account = await publisher.account(args.org);
        const pushed = await publisher.push(account, workbench, {
            ...(args.as ? { slug: args.as } : {}),
            progress: (message) => output.progress(message),
        });
        output.record(pushedRecord(pushed));
    },
});

/** What `wb push` prints for a stored version, for people and for scripts. */
export function pushedRecord(pushed: RegistryPushedVersion): CliRecord {
    const reference = `${pushed.reference.publisher}/${pushed.reference.workbench}`;
    return {
        // Build fields follow the original four, so existing readers keep working.
        machine: [
            'push',
            reference,
            pushed.version,
            pushed.digest,
            ...(pushed.imageBuild
                ? [
                      pushed.imageBuild.id,
                      pushed.imageBuild.state,
                      ...(pushed.imageBuild.url ? [pushed.imageBuild.url] : []),
                  ]
                : []),
        ],
        // Every push is internal; outside the organization a public Workbench keeps its approved version.
        title: `Pushed ${reference}@${pushed.version} (internal)`,
        details: [
            pushed.digest,
            ...(pushed.imageBuild
                ? [
                      pushed.imageBuild.state === 'ready'
                          ? `Cloud image build ${pushed.imageBuild.id}: ready.`
                          : `Cloud image build ${pushed.imageBuild.id}: ${pushed.imageBuild.state}. This version can be published once it is ready.`,
                      ...(pushed.imageBuild.url
                          ? [`Build log: ${pushed.imageBuild.url}`]
                          : []),
                  ]
                : []),
            ...(pushed.visibility === 'public'
                ? [
                      `The public version changes only when this one is approved: wb publish ${reference}`,
                  ]
                : []),
        ],
    };
}
