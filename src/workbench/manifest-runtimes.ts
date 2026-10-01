import type {
    WorkbenchDaytonaClass,
    WorkbenchDockerConfiguration,
    WorkbenchManifest,
    WorkbenchRequirements,
    WorkbenchRuntimeConfig,
} from '../types.js';
import { ManifestValues } from './manifest-values.js';
import {
    daytonaClasses,
    type RuntimeProviderName,
    runtimeProviderNames,
} from './runtimes.js';

const operatingSystems = ['linux', 'macos', 'windows'] as const;
const architectures = ['x64', 'arm64'] as const;

/** The fields each runtime provider accepts in its `runtimes` entry. */
const runtimeFields: Record<RuntimeProviderName, readonly string[]> = {
    local: [],
    docker: ['image', 'docker'],
    e2b: ['image'],
    daytona: ['class', 'image'],
};
const requirementFields = ['os', 'arch', 'cpu', 'memory_gb', 'disk_gb', 'gpu'];

/** Parses the `runtimes` and `requirements` sections of a manifest. */
export class WorkbenchRuntimeParser extends ManifestValues {
    /**
     * Spec 1 declares `runtimes`. A spec 0 manifest declares one runtime with
     * `runtime`, `image`, and `docker`; the engine turns that into a one-entry
     * `runtimes` map for selection and also returns the fields as written.
     * The one-entry map is engine-internal, never a manifest form.
     */
    runtimes(
        body: Record<string, unknown>,
        spec: 0 | 1
    ): {
        declared: Record<string, WorkbenchRuntimeConfig>;
        singular: Pick<WorkbenchManifest, 'runtime' | 'image' | 'docker'>;
    } {
        if (spec === 1 && body.runtimes === undefined) {
            throw new Error('runtimes is required in spec 1');
        }
        if (spec === 0) {
            const runtime = this.text(body.runtime, 'runtime');
            const docker = this.docker(body.docker);
            if (docker?.engine && runtime !== 'docker') {
                throw new Error('docker.engine requires runtime: docker');
            }
            const image = body.image === undefined ? undefined : this.image(body.image);
            return {
                declared: {
                    [runtime]: {
                        ...(image === undefined ? {} : { image }),
                        ...(docker ? { docker } : {}),
                    },
                },
                singular: {
                    runtime,
                    ...(image === undefined ? {} : { image }),
                    ...(docker ? { docker } : {}),
                },
            };
        }
        const entries = this.record(body.runtimes, 'runtimes');
        if (Object.keys(entries).length === 0) {
            throw new Error('runtimes must declare at least one runtime');
        }
        const declared: Record<string, WorkbenchRuntimeConfig> = {};
        for (const [name, value] of Object.entries(entries)) {
            declared[name] = this.runtimeEntry(name, value);
        }
        return { declared, singular: {} };
    }

    requirements(value: unknown): WorkbenchRequirements {
        const body = this.optionalRecord(value, 'requirements');
        for (const key of Object.keys(body)) {
            if (!requirementFields.includes(key)) {
                throw new Error(`Unknown requirements field: ${key}`);
            }
        }
        const os = this.choices(body.os, 'requirements.os', operatingSystems);
        const arch = this.choices(body.arch, 'requirements.arch', architectures);
        if (
            body.cpu !== undefined &&
            (!Number.isInteger(body.cpu) || (body.cpu as number) < 1)
        ) {
            throw new Error('requirements.cpu must be a positive integer');
        }
        if (body.gpu !== undefined && typeof body.gpu !== 'boolean') {
            throw new Error('requirements.gpu must be a boolean');
        }
        return {
            ...(os ? { os } : {}),
            ...(arch ? { arch } : {}),
            ...(body.cpu === undefined ? {} : { cpu: body.cpu as number }),
            ...(body.memory_gb === undefined
                ? {}
                : {
                      memory_gb: this.positive(
                          body.memory_gb,
                          'requirements.memory_gb'
                      ),
                  }),
            ...(body.disk_gb === undefined
                ? {}
                : { disk_gb: this.positive(body.disk_gb, 'requirements.disk_gb') }),
            gpu: body.gpu === true,
        };
    }

    private runtimeEntry(name: string, value: unknown): WorkbenchRuntimeConfig {
        const field = `runtimes.${name}`;
        if (!(runtimeProviderNames as readonly string[]).includes(name)) {
            throw new Error(
                `Unknown runtime provider: ${name}. Known providers: ${runtimeProviderNames.join(', ')}`
            );
        }
        // YAML `local:` with no value parses as null: an empty entry.
        if (
            value !== null &&
            (typeof value !== 'object' || value === undefined || Array.isArray(value))
        ) {
            throw new Error(`${field} must be an object or an empty value`);
        }
        const body = value === null ? {} : this.record(value, field);
        const allowed = runtimeFields[name as RuntimeProviderName];
        for (const key of Object.keys(body)) {
            if (!allowed.includes(key)) {
                throw new Error(`Unknown ${field} field: ${key}`);
            }
        }
        if ((name === 'docker' || name === 'e2b') && body.image === undefined) {
            throw new Error(`${field}.image is required`);
        }
        const image = body.image === undefined ? undefined : this.image(body.image);
        const docker = this.docker(body.docker);
        if (name !== 'daytona') {
            return {
                ...(image === undefined ? {} : { image }),
                ...(docker ? { docker } : {}),
            };
        }
        const daytonaClass = this.text(body.class, `${field}.class`);
        if (!(daytonaClasses as readonly string[]).includes(daytonaClass)) {
            throw new Error(
                `${field}.class must be one of ${daytonaClasses.join(', ')}`
            );
        }
        return {
            class: daytonaClass as WorkbenchDaytonaClass,
            ...(image === undefined ? {} : { image }),
        };
    }

    private choices<T extends string>(
        value: unknown,
        field: string,
        allowed: readonly T[]
    ): T[] | undefined {
        if (value === undefined) return undefined;
        if (!Array.isArray(value) || value.length === 0) {
            throw new Error(`${field} must be a non-empty array`);
        }
        for (const entry of value) {
            if (!allowed.includes(entry as T)) {
                throw new Error(
                    `${field} entries must be one of ${allowed.join(', ')}`
                );
            }
        }
        if (new Set(value).size !== value.length) {
            throw new Error(`${field} must not repeat an entry`);
        }
        return value as T[];
    }

    private positive(value: unknown, field: string): number {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error(`${field} must be a positive number`);
        }
        return value;
    }

    private docker(value: unknown): WorkbenchDockerConfiguration | undefined {
        if (value === undefined) return undefined;
        const body = this.record(value, 'docker');
        for (const key of Object.keys(body)) {
            if (key !== 'engine') {
                throw new Error(`Unknown docker field: ${key}`);
            }
        }
        if (body.engine === undefined) return {};
        const engine = this.record(body.engine, 'docker.engine');
        for (const key of Object.keys(engine)) {
            if (key !== 'mode') {
                throw new Error(`Unknown docker.engine field: ${key}`);
            }
        }
        if (engine.mode !== 'host') {
            throw new Error('docker.engine.mode must be host');
        }
        return { engine: { mode: 'host' } };
    }

    private image(value: unknown) {
        if (typeof value === 'string') return this.text(value, 'image');
        const body = this.record(value, 'image');
        for (const key of Object.keys(body)) {
            if (!['build', 'context'].includes(key)) {
                throw new Error(`Unknown image field: ${key}`);
            }
        }
        return {
            build: this.text(body.build, 'image.build'),
            ...(body.context === undefined
                ? {}
                : { context: this.text(body.context, 'image.context') }),
        };
    }
}
