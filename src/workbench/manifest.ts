import type {
    WorkbenchDaytonaClass,
    WorkbenchDockerConfiguration,
    WorkbenchEnvRequirement,
    WorkbenchManifest,
    WorkbenchMcp,
    WorkbenchModelPolicy,
    WorkbenchRequirements,
    WorkbenchRuntimeConfig,
    WorkbenchWorkspaceRequirement,
} from '../types.js';
import { runtimeProviderNames } from './runtimes.js';

const manifestKeys = new Set([
    'spec',
    'version',
    'name',
    'description',
    'runner',
    'model',
    'instructions',
    'skills',
    'tools',
    'mcps',
    'env',
    'workspaces',
    'runner_config',
]);
const specZeroKeys = new Set([...manifestKeys, 'runtime', 'image', 'docker']);
const specOneKeys = new Set([...manifestKeys, 'requirements', 'runtimes']);

const operatingSystems = ['linux', 'macos', 'windows'] as const;
const architectures = ['x64', 'arm64'] as const;
const daytonaClasses = ['linux', 'windows', 'gpu', 'macos'] as const;

export class WorkbenchManifestParser {
    readonly supportedSpecs = [0, 1] as const;

    parse(value: unknown): WorkbenchManifest {
        const body = this.record(value, 'Workbench manifest');
        if (body.spec === 0 || body.spec === 1) {
            return this.parseManifest(body, body.spec);
        }
        throw new Error(
            `Manifest spec ${String(body.spec)} is not supported by this engine; upgrade wb`
        );
    }

    parseSkill(
        source: string,
        expectedDirectoryName: string,
        label = expectedDirectoryName
    ): { name: string; description: string } {
        const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!frontmatter?.[1]) {
            throw new Error(`Skill must begin with YAML frontmatter: ${label}`);
        }
        const metadata = this.record(Bun.YAML.parse(frontmatter[1]), `Skill ${label}`);
        const name = this.text(metadata.name, `Skill ${label} name`);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
            throw new Error(`Invalid skill name: ${name}`);
        }
        const description = this.text(
            metadata.description,
            `Skill ${label} description`
        );
        if (name !== expectedDirectoryName) {
            throw new Error(`Skill name must match its directory: ${name}`);
        }
        return { name, description };
    }

    private parseManifest(
        body: Record<string, unknown>,
        spec: 0 | 1
    ): WorkbenchManifest {
        if (spec === 1) {
            const legacy = ['runtime', 'image', 'docker'].filter(
                (key) => body[key] !== undefined
            );
            if (legacy.length > 0) {
                throw new Error(
                    `Spec 1 manifests declare runtimes, not ${legacy.join(', ')}. Move them under runtimes; runtime, image, and docker are spec 0 fields.`
                );
            }
        }
        const allowed = spec === 1 ? specOneKeys : specZeroKeys;
        for (const key of Object.keys(body)) {
            if (!allowed.has(key)) {
                throw new Error(`Unknown manifest field: ${key}`);
            }
        }

        const envBody = this.optionalRecord(body.env, 'env');
        const env = Object.fromEntries(
            Object.entries(envBody).map(([name, requirement]) => [
                this.environmentName(name),
                this.environmentRequirement(requirement, name),
            ])
        );
        const workspaceBody = this.optionalRecord(body.workspaces, 'workspaces');
        const workspaces = Object.fromEntries(
            Object.entries(workspaceBody).map(([name, requirement]) => [
                this.workspaceName(name),
                this.workspaceRequirement(requirement, name),
            ])
        );
        const runtimes = this.runtimes(body, spec);
        const requirements = this.requirements(body.requirements);

        return {
            spec,
            version: this.semanticVersion(body.version),
            name: this.text(body.name, 'name'),
            ...(body.description === undefined
                ? {}
                : { description: this.text(body.description, 'description') }),
            runner: this.text(body.runner, 'runner'),
            model: this.model(body.model),
            instructions: this.text(body.instructions, 'instructions'),
            skills: this.stringArray(body.skills, 'skills'),
            tools: this.stringArray(body.tools, 'tools'),
            mcps: this.mcps(body.mcps),
            env,
            ...(body.workspaces === undefined ? {} : { workspaces }),
            requirements,
            runtimes: runtimes.declared,
            ...runtimes.singular,
            ...(body.runner_config === undefined
                ? {}
                : {
                      runner_config: this.text(body.runner_config, 'runner_config'),
                  }),
        };
    }

    /**
     * Spec 1 declares `runtimes`. A spec 0 manifest declares one runtime with
     * `runtime`, `image`, and `docker`; the engine turns that into a one-entry
     * `runtimes` map for selection and also returns the fields as written.
     * The one-entry map is engine-internal, never a manifest form.
     */
    private runtimes(
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

    private runtimeEntry(name: string, value: unknown): WorkbenchRuntimeConfig {
        const field = `runtimes.${name}`;
        if (!(runtimeProviderNames as readonly string[]).includes(name)) {
            throw new Error(
                `Unknown runtime provider: ${name}. Known providers: ${runtimeProviderNames.join(', ')}`
            );
        }
        const body = this.record(value, field);
        const allowed: Record<string, string[]> = {
            local: [],
            docker: ['image', 'docker'],
            e2b: ['image'],
            daytona: ['class', 'image'],
        };
        for (const key of Object.keys(body)) {
            if (!allowed[name]?.includes(key)) {
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

    private requirements(value: unknown): WorkbenchRequirements {
        const body = this.optionalRecord(value, 'requirements');
        for (const key of Object.keys(body)) {
            if (!['os', 'arch', 'cpu', 'memory_gb', 'disk_gb', 'gpu'].includes(key)) {
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

    private model(value: unknown): WorkbenchModelPolicy {
        const body = this.record(value, 'model');
        for (const key of Object.keys(body)) {
            if (!['id', 'routes'].includes(key)) {
                throw new Error(`Unknown model field: ${key}`);
            }
        }
        const id = this.text(body.id, 'model.id');
        if (!/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) {
            throw new Error('model.id must be a provider-neutral lab/model identifier');
        }
        if (body.routes === undefined) return { id };
        if (!Array.isArray(body.routes) || body.routes.length === 0) {
            throw new Error('model.routes must be a non-empty array');
        }
        const seen = new Set<string>();
        const routes = body.routes.map((entry, index) => {
            const route = this.record(entry, `model.routes[${index}]`);
            for (const key of Object.keys(route)) {
                if (!['provider', 'model'].includes(key)) {
                    throw new Error(`Unknown model.routes[${index}] field: ${key}`);
                }
            }
            const provider = this.text(
                route.provider,
                `model.routes[${index}].provider`
            );
            if (!/^[a-z0-9][a-z0-9._-]*$/.test(provider)) {
                throw new Error(`Invalid model.routes[${index}].provider`);
            }
            if (seen.has(provider)) {
                throw new Error(`Duplicate model route provider: ${provider}`);
            }
            seen.add(provider);
            return {
                provider,
                ...(route.model === undefined
                    ? {}
                    : {
                          model: this.text(route.model, `model.routes[${index}].model`),
                      }),
            };
        });
        return { id, routes };
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

    private mcps(value: unknown): WorkbenchMcp[] {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new Error('mcps must be an array');
        const names = new Set<string>();
        return value.map((entry, index) => {
            const body = this.record(entry, `mcps[${index}]`);
            for (const key of Object.keys(body)) {
                if (!['name', 'transport', 'url', 'headers'].includes(key)) {
                    throw new Error(`Unknown mcps[${index}] field: ${key}`);
                }
            }
            const name = this.text(body.name, `mcps[${index}].name`);
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
                throw new Error(`Invalid MCP name: ${name}`);
            }
            if (names.has(name)) throw new Error(`Duplicate MCP name: ${name}`);
            names.add(name);
            const transport = body.transport ?? 'http';
            if (transport !== 'http') {
                throw new Error(`mcps[${index}].transport must be http`);
            }
            const url = this.text(body.url, `mcps[${index}].url`);
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                throw new Error(`mcps[${index}].url must be an absolute URL`);
            }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                throw new Error(`mcps[${index}].url must use http or https`);
            }
            const headerBody = this.optionalRecord(
                body.headers,
                `mcps[${index}].headers`
            );
            const headers = Object.fromEntries(
                Object.entries(headerBody).map(([header, headerValue]) => [
                    this.text(header, `mcps[${index}] header name`),
                    this.text(headerValue, `mcps[${index}].headers.${header}`),
                ])
            );
            return { name, transport, url, headers };
        });
    }

    private environmentRequirement(
        value: unknown,
        name: string
    ): WorkbenchEnvRequirement {
        const requirement = this.record(value, `env.${name}`);
        for (const key of Object.keys(requirement)) {
            if (key !== 'required') {
                throw new Error(`Unknown env.${name} field: ${key}`);
            }
        }
        if (
            requirement.required !== undefined &&
            typeof requirement.required !== 'boolean'
        ) {
            throw new Error(`env.${name}.required must be a boolean`);
        }
        return { required: requirement.required ?? true };
    }

    private workspaceRequirement(
        value: unknown,
        name: string
    ): WorkbenchWorkspaceRequirement {
        const requirement = this.record(value, `workspaces.${name}`);
        for (const key of Object.keys(requirement)) {
            if (!['required', 'access'].includes(key)) {
                throw new Error(`Unknown workspaces.${name} field: ${key}`);
            }
        }
        if (
            requirement.required !== undefined &&
            typeof requirement.required !== 'boolean'
        ) {
            throw new Error(`workspaces.${name}.required must be a boolean`);
        }
        const access = requirement.access ?? 'read-only';
        if (!['read-only', 'read-write'].includes(String(access))) {
            throw new Error(
                `workspaces.${name}.access must be read-only or read-write`
            );
        }
        return {
            required: requirement.required ?? true,
            access: access as WorkbenchWorkspaceRequirement['access'],
        };
    }

    private semanticVersion(value: unknown): string {
        const version = this.text(value, 'version');
        if (
            !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
                version
            )
        ) {
            throw new Error('version must be a semantic version');
        }
        return version;
    }

    private stringArray(value: unknown, field: string): string[] {
        if (value === undefined) return [];
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
            throw new Error(`${field} must be an array of strings`);
        }
        return value.map((entry) => entry.trim()).filter(Boolean);
    }

    private optionalRecord(value: unknown, field: string): Record<string, unknown> {
        if (value === undefined) return {};
        return this.record(value, field);
    }

    private record(value: unknown, field: string): Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`${field} must be an object`);
        }
        return value as Record<string, unknown>;
    }

    private text(value: unknown, field: string): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error(`${field} must be a non-empty string`);
        }
        return value.trim();
    }

    private environmentName(value: string): string {
        if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
            throw new Error(`Invalid environment variable name: ${value}`);
        }
        return value;
    }

    private workspaceName(value: string): string {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value === 'primary') {
            throw new Error(`Invalid workspace name: ${value}`);
        }
        return value;
    }
}
