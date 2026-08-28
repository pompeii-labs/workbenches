import type { ResolvedWorkbench } from '../types.js';
import { OpenCodeRunner } from './opencode/runner.js';
import { PiRunner } from './pi/runner.js';
import type { PreparedRunner, Runner } from './runner.js';
import {
    RUNNER_CAPABILITIES,
    type RunnerAdapterDeclaration,
    type RunnerSessionAdapter,
} from './session.js';

export class RunnerRegistry {
    readonly #runners = new Map<string, Runner>();

    constructor(runners: Runner[]) {
        for (const runner of runners) {
            const name = runner.name.trim();
            if (!name) throw new Error('Runner name must not be empty');
            if (this.#runners.has(name)) {
                throw new Error(`Duplicate runner: ${name}`);
            }
            if (runner.session.runner !== name) {
                throw new Error(
                    `Runner session name ${runner.session.runner} does not match runner ${name}`
                );
            }
            validateDeclaration(name, runner.session.declaration);
            this.#runners.set(name, runner);
        }
    }

    static standard(): RunnerRegistry {
        return new RunnerRegistry([new OpenCodeRunner(), new PiRunner()]);
    }

    resolve(name: string): Runner {
        const runner = this.#runners.get(name);
        if (!runner) throw new Error(`Unsupported runner: ${name}`);
        return runner;
    }

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined> = process.env
    ): Promise<PreparedRunner> {
        return await this.resolve(workbench.manifest.runner).prepare(
            workbench,
            environment
        );
    }

    session(name: string): RunnerSessionAdapter {
        return this.resolve(name).session;
    }
}

function validateDeclaration(
    runner: string,
    declaration: RunnerAdapterDeclaration
): void {
    if (!declaration) {
        throw new Error(`Runner adapter declaration is required: ${runner}`);
    }
    if (!declaration.native.command.trim()) {
        throw new Error(`Runner adapter native command must not be empty: ${runner}`);
    }
    if (declaration.native.verified.length === 0) {
        throw new Error(
            `Runner adapter must declare a verified native version: ${runner}`
        );
    }
    for (const verified of declaration.native.verified) {
        if (!verified.version.trim() || verified.surfaces.length === 0) {
            throw new Error(
                `Runner adapter verified versions require native surfaces: ${runner}`
            );
        }
        if (verified.surfaces.some((surface) => !surface.trim())) {
            throw new Error(
                `Runner adapter native surfaces must not be empty: ${runner}`
            );
        }
    }
    for (const capability of RUNNER_CAPABILITIES) {
        const support = declaration.capabilities[capability];
        if (!support) {
            throw new Error(
                `Runner adapter capability is not declared: ${runner}.${capability}`
            );
        }
        if (!['supported', 'degraded', 'unsupported'].includes(support.status)) {
            throw new Error(
                `Runner adapter capability status is invalid: ${runner}.${capability}`
            );
        }
        if (support.status !== 'supported' && !support.detail?.trim()) {
            throw new Error(
                `Runner adapter ${support.status} capability requires detail: ${runner}.${capability}`
            );
        }
    }
}
