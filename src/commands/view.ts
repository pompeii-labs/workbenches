import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { findCatalogEntry, readCatalog } from '../catalog.js';
import {
    listGitHubWorkbenches,
    type RemoteWorkbenchSummary,
    resolvedRemoteWorkbench,
} from '../github.js';
import { resolveWorkbench } from '../manifest.js';
import {
    parseWorkbenchReference,
    resolveLocalSource,
    selectWorkbench,
} from '../source.js';
import { workbenchHome } from '../storage.js';
import { describeWorkbench, renderWorkbenchView, type WorkbenchView } from '../view.js';

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
        const view = await resolveView(args.workbench);
        process.stdout.write(
            args.json ? `${JSON.stringify(view)}\n` : renderWorkbenchView(view)
        );
    },
});

async function resolveView(value: string): Promise<WorkbenchView> {
    const home = workbenchHome();
    const saved =
        !value.includes('/') && !value.includes('#')
            ? findCatalogEntry(await readCatalog(home), value)
            : undefined;
    if (saved) {
        return describeWorkbench({
            workbench: await resolveWorkbench(saved.packagePath),
            origin: {
                kind: 'saved',
                alias: saved.alias,
                source: saved.source,
                selector: saved.selector,
                ...(saved.revision ? { revision: saved.revision } : {}),
                digest: saved.digest,
                added_at: saved.addedAt,
                package: saved.packagePath,
            },
        });
    }

    const reference = parseWorkbenchReference(value);
    const local = await resolveLocalSource(reference.source);
    if (local) {
        const workbench = await selectWorkbench(local.directory, reference.selector);
        return describeWorkbench({
            workbench,
            origin: {
                kind: 'local',
                source: local.source,
                selector: basename(workbench.packageDirectory),
                ...(local.revision ? { revision: local.revision } : {}),
            },
        });
    }

    const selected = selectRemote(
        await listGitHubWorkbenches(reference.source),
        reference.selector
    );
    return describeWorkbench({
        workbench: resolvedRemoteWorkbench(selected),
        origin: {
            kind: 'github',
            source: selected.source,
            selector: selected.selector,
            revision: selected.revision,
        },
    });
}

function selectRemote(
    available: RemoteWorkbenchSummary[],
    selector?: string
): RemoteWorkbenchSummary {
    if (available.length === 0) throw new Error('No Workbenches found in repository');
    if (selector) {
        const selected = available.find(
            (workbench) =>
                workbench.selector === selector || workbench.manifest.name === selector
        );
        if (!selected) throw new Error(`Workbench not found: ${selector}`);
        return selected;
    }
    if (available.length > 1) {
        throw new Error(
            `Workbench selector required. Available: ${available.map((workbench) => workbench.selector).join(', ')}`
        );
    }
    return available[0] as RemoteWorkbenchSummary;
}
