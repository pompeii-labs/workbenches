import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RunnerRegistry } from '../runners/registry.js';
import type {
    ResolvedWorkbench,
    ResolvedWorkbenchSkill,
    WorkbenchManifest,
} from '../types.js';
import { WorkbenchManifestParser } from './manifest.js';
import { RunnerConfiguration } from './runner-configuration.js';
import { declaredRuntimes } from './runtimes.js';

export class Workbench implements ResolvedWorkbench {
    readonly runnerConfigPath?: string;

    private constructor(
        readonly manifestPath: string,
        readonly packageDirectory: string,
        readonly repositoryDirectory: string,
        readonly instructionsPath: string,
        readonly skills: ResolvedWorkbenchSkill[],
        readonly manifest: WorkbenchManifest,
        runnerConfigPath?: string
    ) {
        if (runnerConfigPath) this.runnerConfigPath = runnerConfigPath;
    }

    static async load(
        inputPath: string,
        parser = new WorkbenchManifestParser(),
        runnerConfiguration = new RunnerConfiguration()
    ): Promise<Workbench> {
        const requested = resolve(inputPath);
        const input = await stat(requested).catch(() => null);
        if (!input) {
            throw new Error(`Workbench path does not exist: ${requested}`);
        }

        const manifestPath = input.isDirectory()
            ? join(requested, 'workbench.yml')
            : requested;
        const manifestFile = await stat(manifestPath).catch(() => null);
        if (!manifestFile?.isFile()) {
            throw new Error(`Workbench manifest does not exist: ${manifestPath}`);
        }

        const packageDirectory = dirname(manifestPath);
        const repositoryDirectory = Workbench.repositoryRoot(packageDirectory);
        const manifest = parser.parse(
            Bun.YAML.parse(await readFile(manifestPath, 'utf8'))
        );
        Workbench.validateImagePaths(manifest, packageDirectory, repositoryDirectory);

        const instructionsPath = Workbench.packagePath(
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
                Workbench.loadSkill(
                    packageDirectory,
                    repositoryDirectory,
                    skill,
                    parser
                )
            )
        );
        const duplicate = skills.find(
            (skill, index) =>
                skills.findIndex((candidate) => candidate.name === skill.name) !== index
        );
        if (duplicate) {
            throw new Error(`Duplicate skill name: ${duplicate.name}`);
        }

        const runnerConfigPath = manifest.runner_config
            ? Workbench.packagePath(
                  packageDirectory,
                  packageDirectory,
                  manifest.runner_config,
                  'runner_config'
              )
            : undefined;
        if (runnerConfigPath) {
            await runnerConfiguration.validate(runnerConfigPath);
            const shape = RunnerRegistry.standard().authentication(
                manifest.runner
            ).runnerConfigShape;
            const metadata = await lstat(runnerConfigPath);
            if (shape === 'directory' && !metadata.isDirectory()) {
                throw new Error(
                    `${RunnerRegistry.standard().displayName(manifest.runner)} runner_config must be a directory`
                );
            }
            if (shape === 'file' && !metadata.isFile()) {
                throw new Error(
                    `${RunnerRegistry.standard().displayName(manifest.runner)} runner_config must be a JSON file`
                );
            }
        }

        return new Workbench(
            manifestPath,
            packageDirectory,
            repositoryDirectory,
            instructionsPath,
            skills,
            manifest,
            runnerConfigPath
        );
    }

    private static async loadSkill(
        packageDirectory: string,
        repositoryDirectory: string,
        value: string,
        parser: WorkbenchManifestParser
    ): Promise<ResolvedWorkbenchSkill> {
        const directory = Workbench.packagePath(
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
        const { name } = parser.parseSkill(source, basename(directory), value);
        return { name, directory, manifestPath };
    }

    private static validateImagePaths(
        manifest: WorkbenchManifest,
        packageDirectory: string,
        repositoryDirectory: string
    ): void {
        const declared = declaredRuntimes(manifest);
        const named = manifest.runtime === undefined;
        for (const [name, runtime] of Object.entries(declared)) {
            const image = runtime.image;
            if (!image || typeof image === 'string') continue;
            const prefix = named ? `runtimes.${name}.image` : 'image';
            Workbench.packagePath(
                packageDirectory,
                repositoryDirectory,
                image.build,
                `${prefix}.build`
            );
            Workbench.packagePath(
                packageDirectory,
                repositoryDirectory,
                image.context ?? '.',
                `${prefix}.context`
            );
        }
    }

    private static repositoryRoot(packageDirectory: string): string {
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

    private static packagePath(
        packageDirectory: string,
        repositoryDirectory: string,
        value: string,
        field: string
    ): string {
        if (isAbsolute(value)) {
            throw new Error(`${field} must be a relative path`);
        }
        const path = resolve(packageDirectory, value);
        const fromRepository = relative(repositoryDirectory, path);
        if (fromRepository.startsWith('..') || isAbsolute(fromRepository)) {
            throw new Error(`${field} must remain inside the repository`);
        }
        return path;
    }
}
