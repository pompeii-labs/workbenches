import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelCatalog } from '../models/catalog.js';
import type { ResolvedWorkbench } from '../types.js';
import { Workbench } from '../workbench/index.js';
import { type ConnectionTarget, connectionModel } from './targets.js';

export interface PreparedConnectionWorkbench {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    cleanup(): Promise<void>;
}

export async function prepareConnectionSetupWorkbench(
    target: ConnectionTarget
): Promise<PreparedConnectionWorkbench> {
    const root = await mkdtemp(join(tmpdir(), 'workbench-connect-'));
    const packageDirectory = join(root, '.workbenches', 'connection');
    const workspaceDirectory = join(root, 'workspace');
    try {
        await Promise.all([
            mkdir(packageDirectory, { recursive: true }),
            mkdir(workspaceDirectory, { recursive: true }),
        ]);
        const model = connectionModel(target.provider, ModelCatalog.current());
        await Promise.all([
            writeFile(
                join(packageDirectory, 'instructions.md'),
                '# Connection setup\n\nThis internal package is used only to open the selected harness authentication flow.\n'
            ),
            writeFile(join(packageDirectory, 'workbench.yml'), manifest(target, model)),
            ...(target.runtime !== 'local' && target.harness === 'pi'
                ? [
                      writeFile(
                          join(packageDirectory, 'Dockerfile.workbench'),
                          'FROM node:22-bookworm-slim\n\nRUN npm install --global @earendil-works/pi-coding-agent@0.84.3\n'
                      ),
                  ]
                : []),
        ]);
        return {
            workbench: await Workbench.load(packageDirectory),
            workspaceDirectory,
            cleanup: () => rm(root, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

function manifest(
    target: ConnectionTarget,
    model: { canonical: string; native: string }
): string {
    const image =
        target.runtime === 'local'
            ? ''
            : target.harness === 'opencode'
              ? '\nimage: ghcr.io/anomalyco/opencode:1.18.30\n'
              : '\nimage:\n  build: ./Dockerfile.workbench\n  context: .\n';
    return `spec: 0
version: 0.1.0
name: workbench-connection-setup
description: Internal authentication environment for ${target.harness} in ${target.runtime}.
runner: ${target.harness}
model:
  id: ${model.canonical}
  routes:
    - provider: ${target.provider}
      model: ${model.native}
instructions: ./instructions.md
skills: []
tools: []
mcps: []
env: {}
runtime: ${target.runtime}${image}`;
}
