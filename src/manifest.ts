import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
    ResolvedWorkbench,
    ResolvedWorkbenchSkill,
    WorkbenchDockerConfiguration,
    WorkbenchEnvRequirement,
    WorkbenchManifest,
    WorkbenchMcp,
    WorkbenchWorkspaceRequirement,
} from './types.js';

export const supportedWorkbenchSpecs = [0] as const;

const manifestKeysV0 = new Set([
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
    'runtime',
    'image',
    'docker',
]);

export async function resolveWorkbench(inputPath: string): Promise<ResolvedWorkbench> {
    const requested = resolve(inputPath);
    const input = await stat(requested).catch(() => null);
    if (!input) throw new Error(`Workbench path does not exist: ${requested}`);

    const manifestPath = input.isDirectory()
        ? join(requested, 'workbench.yml')
        : requested;
    const manifestFile = await stat(manifestPath).catch(() => null);
    if (!manifestFile?.isFile()) {
        throw new Error(`Workbench manifest does not exist: ${manifestPath}`);
    }

    const packageDirectory = dirname(manifestPath);
    const repositoryDirectory = repositoryRoot(packageDirectory);
    const parsed = Bun.YAML.parse(await readFile(manifestPath, 'utf8'));
    const manifest = parseWorkbenchManifest(parsed);
    validateImagePaths(manifest, packageDirectory, repositoryDirectory);
    const instructionsPath = resolvePackagePath(
        packageDirectory,
        repositoryDirectory,
        manifest.instructions,
        'instructions'
    );
    const instructions = await stat(instructionsPath).catch(() => null);
    if (!instructions?.isFile()) {
        throw new Error(`Instructions file does not exist: ${instructionsPath}`);
    }
    const skills = await Promise.all(
        manifest.skills.map((skill) =>
            resolveSkill(packageDirectory, repositoryDirectory, skill)
        )
    );
    const duplicateSkill = skills.find(
        (skill, index) =>
            skills.findIndex((entry) => entry.name === skill.name) !== index
    );
    if (duplicateSkill) {
        throw new Error(`Duplicate skill name: ${duplicateSkill.name}`);
    }

    return {
        manifestPath,
        packageDirectory,
        repositoryDirectory,
        instructionsPath,
        skills,
        manifest,
    };
}

function validateImagePaths(
    manifest: WorkbenchManifest,
    packageDirectory: string,
    repositoryDirectory: string
): void {
    if (!manifest.image || typeof manifest.image === 'string') return;
    resolvePackagePath(
        packageDirectory,
        repositoryDirectory,
        manifest.image.build,
        'image.build'
    );
    resolvePackagePath(
        packageDirectory,
        repositoryDirectory,
        manifest.image.context ?? '.',
        'image.context'
    );
}

export function parseWorkbenchManifest(value: unknown): WorkbenchManifest {
    const body = record(value, 'Workbench manifest');
    switch (body.spec) {
        case 0:
            return parseManifestV0(body);
        default:
            throw new Error(
                `Unsupported Workbench spec: ${String(body.spec)}. Supported specs: ${supportedWorkbenchSpecs.join(', ')}`
            );
    }
}

export function parseSkillMetadata(
    source: string,
    expectedDirectoryName: string,
    label = expectedDirectoryName
): { name: string; description: string } {
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter?.[1]) {
        throw new Error(`Skill must begin with YAML frontmatter: ${label}`);
    }
    const metadata = record(Bun.YAML.parse(frontmatter[1]), `Skill ${label}`);
    const name = text(metadata.name, `Skill ${label} name`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
        throw new Error(`Invalid skill name: ${name}`);
    }
    const description = text(metadata.description, `Skill ${label} description`);
    if (name !== expectedDirectoryName) {
        throw new Error(`Skill name must match its directory: ${name}`);
    }
    return { name, description };
}

function parseManifestV0(body: Record<string, unknown>): WorkbenchManifest {
    for (const key of Object.keys(body)) {
        if (!manifestKeysV0.has(key)) throw new Error(`Unknown manifest field: ${key}`);
    }

    const envBody = optionalRecord(body.env, 'env');
    const env = Object.fromEntries(
        Object.entries(envBody).map(([name, requirement]) => [
            environmentName(name),
            parseEnvRequirement(requirement, name),
        ])
    );
    const workspaceBody = optionalRecord(body.workspaces, 'workspaces');
    const workspaces = Object.fromEntries(
        Object.entries(workspaceBody).map(([name, requirement]) => [
            workspaceName(name),
            parseWorkspaceRequirement(requirement, name),
        ])
    );
    const runtime = text(body.runtime, 'runtime');
    const docker = parseDockerConfiguration(body.docker);
    if (docker?.engine && runtime !== 'docker') {
        throw new Error('docker.engine requires runtime: docker');
    }

    return {
        spec: 0,
        version: semanticVersion(body.version),
        name: text(body.name, 'name'),
        ...(body.description === undefined
            ? {}
            : { description: text(body.description, 'description') }),
        runner: text(body.runner, 'runner'),
        model: text(body.model, 'model'),
        instructions: text(body.instructions, 'instructions'),
        skills: stringArray(body.skills, 'skills'),
        tools: stringArray(body.tools, 'tools'),
        mcps: mcpArray(body.mcps),
        env,
        ...(body.workspaces === undefined ? {} : { workspaces }),
        runtime,
        ...(body.image === undefined ? {} : { image: image(body.image) }),
        ...(docker ? { docker } : {}),
    };
}

function parseDockerConfiguration(
    value: unknown
): WorkbenchDockerConfiguration | undefined {
    if (value === undefined) return undefined;
    const body = record(value, 'docker');
    for (const key of Object.keys(body)) {
        if (key !== 'engine') throw new Error(`Unknown docker field: ${key}`);
    }
    if (body.engine === undefined) return {};
    const engine = record(body.engine, 'docker.engine');
    for (const key of Object.keys(engine)) {
        if (key !== 'mode') throw new Error(`Unknown docker.engine field: ${key}`);
    }
    if (engine.mode !== 'host') {
        throw new Error('docker.engine.mode must be host');
    }
    return { engine: { mode: 'host' } };
}

function image(value: unknown) {
    if (typeof value === 'string') return text(value, 'image');
    const body = record(value, 'image');
    for (const key of Object.keys(body)) {
        if (!['build', 'context'].includes(key)) {
            throw new Error(`Unknown image field: ${key}`);
        }
    }
    return {
        build: text(body.build, 'image.build'),
        ...(body.context === undefined
            ? {}
            : { context: text(body.context, 'image.context') }),
    };
}

function semanticVersion(value: unknown): string {
    const version = text(value, 'version');
    if (
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
            version
        )
    ) {
        throw new Error('version must be a semantic version');
    }
    return version;
}

async function resolveSkill(
    packageDirectory: string,
    repositoryDirectory: string,
    value: string
): Promise<ResolvedWorkbenchSkill> {
    const directory = resolvePackagePath(
        packageDirectory,
        repositoryDirectory,
        value,
        'skills'
    );
    const manifestPath = join(directory, 'SKILL.md');
    const file = await stat(manifestPath).catch(() => null);
    if (!file?.isFile()) {
        throw new Error(`Skill manifest does not exist: ${manifestPath}`);
    }

    const source = await readFile(manifestPath, 'utf8');
    const { name } = parseSkillMetadata(source, basename(directory), value);
    return { name, directory, manifestPath };
}

function mcpArray(value: unknown): WorkbenchMcp[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error('mcps must be an array');
    const names = new Set<string>();
    return value.map((entry, index) => {
        const body = record(entry, `mcps[${index}]`);
        for (const key of Object.keys(body)) {
            if (!['name', 'transport', 'url', 'headers'].includes(key)) {
                throw new Error(`Unknown mcps[${index}] field: ${key}`);
            }
        }
        const name = text(body.name, `mcps[${index}].name`);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
            throw new Error(`Invalid MCP name: ${name}`);
        }
        if (names.has(name)) throw new Error(`Duplicate MCP name: ${name}`);
        names.add(name);
        const transport = body.transport ?? 'http';
        if (transport !== 'http') {
            throw new Error(`mcps[${index}].transport must be http`);
        }
        const url = text(body.url, `mcps[${index}].url`);
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`mcps[${index}].url must be an absolute URL`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`mcps[${index}].url must use http or https`);
        }
        const headerBody = optionalRecord(body.headers, `mcps[${index}].headers`);
        const headers = Object.fromEntries(
            Object.entries(headerBody).map(([header, headerValue]) => [
                text(header, `mcps[${index}] header name`),
                text(headerValue, `mcps[${index}].headers.${header}`),
            ])
        );
        return { name, transport, url, headers };
    });
}

function parseEnvRequirement(value: unknown, name: string): WorkbenchEnvRequirement {
    const requirement = record(value, `env.${name}`);
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

function parseWorkspaceRequirement(
    value: unknown,
    name: string
): WorkbenchWorkspaceRequirement {
    const requirement = record(value, `workspaces.${name}`);
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
        throw new Error(`workspaces.${name}.access must be read-only or read-write`);
    }
    return {
        required: requirement.required ?? true,
        access: access as WorkbenchWorkspaceRequirement['access'],
    };
}

function repositoryRoot(packageDirectory: string): string {
    let current = packageDirectory;
    while (true) {
        if (basename(current) === '.workbenches') return dirname(current);
        const parent = dirname(current);
        if (parent === current) {
            throw new Error('Workbench must live beneath a .workbenches directory');
        }
        current = parent;
    }
}

function resolvePackagePath(
    packageDirectory: string,
    repositoryDirectory: string,
    value: string,
    field: string
): string {
    if (isAbsolute(value)) throw new Error(`${field} must be a relative path`);
    const path = resolve(packageDirectory, value);
    const fromRepository = relative(repositoryDirectory, path);
    if (fromRepository.startsWith('..') || isAbsolute(fromRepository)) {
        throw new Error(`${field} must remain inside the repository`);
    }
    return path;
}

function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${field} must be an array of strings`);
    }
    return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
    if (value === undefined) return {};
    return record(value, field);
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object`);
    }
    return value as Record<string, unknown>;
}

function environmentName(value: string): string {
    if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
        throw new Error(`Invalid environment variable name: ${value}`);
    }
    return value;
}

function workspaceName(value: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value === 'primary') {
        throw new Error(`Invalid workspace name: ${value}`);
    }
    return value;
}
