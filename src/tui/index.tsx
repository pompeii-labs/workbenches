import { render } from '@opentui/solid';

import { readCatalog } from '../catalog.js';
import { startInteractiveWorkbench } from '../interactive.js';
import { type ResolvedReference, resolveReference } from '../references.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchApp } from './app.js';

export async function renderWorkbenchTui(
    options: { initial?: { alias: string; resolved: ResolvedReference } } = {}
): Promise<void> {
    const home = workbenchHome();
    const entries = await readCatalog(home);
    await render(
        () => (
            <WorkbenchApp
                entries={entries}
                {...(options.initial ? { initial: options.initial } : {})}
                resolve={(alias) => resolveReference(alias, { home })}
                start={(sessionOptions) =>
                    startInteractiveWorkbench({
                        ...sessionOptions,
                    })
                }
            />
        ),
        {
            screenMode: 'alternate-screen',
            exitOnCtrlC: false,
            clearOnShutdown: true,
            targetFps: 30,
            maxFps: 60,
            useMouse: true,
            backgroundColor: '#101014',
        }
    );
}
