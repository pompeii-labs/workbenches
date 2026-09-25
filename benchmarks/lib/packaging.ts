// Staging Workbench packages (and the plain-control package) into a trial's
// work directory, and preparing the evaluation runtime the grader shares
// with the submission.
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_MODEL,
    ENGINE_IMAGE,
    fingerprint,
    InfraError,
    runContainer,
} from './container.ts';
import { exec, type Paths, socketPath } from './runtime.ts';
import { identifier, type TaskSpec } from './spec.ts';

export function stagePackage(paths: Paths, name: string, work: string) {
    identifier(name, 'workbench');
    const source = join(paths.workbenches, name),
        target = join(work, '.workbenches', name);
    if (!existsSync(join(source, 'workbench.yml')))
        throw new InfraError(`Missing Workbench: ${source}`);
    fingerprint(source);
    cpSync(source, target, { recursive: true });
    return target;
}
/**
 * Every arm of a comparison runs the campaign's model. The staged copy's declared
 * model is replaced; the source package is never touched.
 */
export function pinModel(pkg: string, model: string) {
    const path = join(pkg, 'workbench.yml'),
        lines = readFileSync(path, 'utf8').split('\n'),
        start = lines.findIndex((l) => /^model:/.test(l));
    if (start < 0) throw new InfraError(`Workbench declares no model: ${path}`);
    let end = start + 1;
    while (end < lines.length && (/^\s/.test(lines[end]!) || !lines[end]!.trim()))
        end++;
    lines.splice(
        start,
        end - start,
        'model:',
        `  id: ${model}`,
        '  routes:',
        '    - provider: openrouter',
        `      model: ${model}`,
        ''
    );
    writeFileSync(path, lines.join('\n'));
    return pkg;
}
export function stagePlainControl(
    paths: Paths,
    work: string,
    hostDocker: boolean,
    model = DEFAULT_MODEL
) {
    const pkg = join(work, '.workbenches', 'plain-control');
    mkdirSync(pkg, { recursive: true });
    cpSync(
        join(paths.bench, 'lib/runtime-assets/agent.Dockerfile'),
        join(pkg, 'Dockerfile')
    );
    writeFileSync(join(pkg, 'instructions.md'), 'Follow the user request.\n');
    cpSync(
        join(paths.workbenches, 'grader', 'opencode.json'),
        join(pkg, 'opencode.json')
    );
    writeFileSync(
        join(pkg, 'workbench.yml'),
        [
            'spec: 0',
            'version: 1.0.0',
            'name: plain-control',
            'description: Generic coding environment without domain expertise.',
            'runner: opencode',
            'runner_config: ./opencode.json',
            'model:',
            `  id: ${model}`,
            '  routes:',
            '    - provider: openrouter',
            `      model: ${model}`,
            'instructions: ./instructions.md',
            'skills: []',
            'mcps: []',
            'tools: [opencode, node, bun]',
            'env:',
            '  OPENROUTER_API_KEY:',
            '    required: true',
            'runtime: docker',
            'image:',
            '  build: ./Dockerfile',
            '  context: .',
            ...(hostDocker ? ['docker:', '  engine:', '    mode: host'] : []),
            '',
        ].join('\n')
    );
    return pkg;
}
export async function packageCommand(
    work: string,
    daemon: string,
    pkg: string,
    project: string,
    text: string
) {
    const inspected = await runContainer({
        name: 'inspect',
        daemon,
        work,
        cwd: project,
        image: ENGINE_IMAGE,
        command: ['wb', 'view', pkg, '--json'],
        timeoutMs: 120000,
        credential: true,
    });
    if (inspected.code !== 0)
        throw new InfraError(`wb view failed: ${inspected.stderr.slice(-800)}`);
    const view = JSON.parse(inspected.stdout);
    if (view.runner !== 'opencode')
        throw new InfraError(
            'The benchmark adapter currently supports OpenCode Workbenches'
        );
    const command = ['wb', 'run', pkg, '--dir', project, '--task', text, '--json'];
    if (view.docker_engine?.mode === 'host') command.push('--allow-host-docker');
    return { command, model: view.model as string, view };
}

export async function prepareEvaluationRuntime(
    paths: Paths,
    task: TaskSpec,
    work: string,
    daemon: string,
    project: string
) {
    const pkg = stagePackage(paths, task.workbench, work);
    const product = await packageCommand(
        work,
        daemon,
        pkg,
        project,
        'Prepare evaluation runtime only.'
    );
    if (product.view.runtime !== 'docker')
        throw new InfraError('Evaluation requires a Docker product runtime');
    const prepared = await runContainer({
        name: 'evaluation-preflight',
        daemon,
        work,
        cwd: project,
        image: ENGINE_IMAGE,
        command: [...product.command, '--dry-run'],
        credential: true,
        timeoutMs: 1800000,
    });
    if (prepared.code !== 0)
        throw new InfraError('Product evaluation runtime failed engine preflight');
    // The fresh grading daemon contains only generic harness images before this
    // preparation. Resolve the engine-built image, fail closed on ambiguity.
    const image = product.view.image;
    const args =
        typeof image === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(image)
            ? ['image', 'inspect', '--format', '{{.Id}}', image]
            : [
                  'image',
                  'ls',
                  '--no-trunc',
                  '--filter',
                  'reference=workbench-local/*',
                  '--format',
                  '{{.ID}}',
              ];
    const listed = await exec([
        'docker',
        'exec',
        daemon,
        'docker',
        '-H',
        `unix://${socketPath()}`,
        ...args,
    ]);
    const ids = [...new Set(listed.stdout.trim().split(/\s+/).filter(Boolean))];
    if (listed.code !== 0 || ids.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(ids[0]!))
        throw new InfraError(
            'Could not unambiguously resolve product evaluation image'
        );
    mkdirSync(join(work, 'evaluation-home'), { recursive: true });
    // The judge must not see the product's actor instructions or skills.
    rmSync(join(work, '.workbenches'), { recursive: true, force: true });
    return { image: ids[0]!, hostDocker: product.view.docker_engine?.mode === 'host' };
}
export function stageChecks(paths: Paths, task: TaskSpec, work: string) {
    const source = join(paths.tasks, task.id, 'checks'),
        target = join(work, 'checks');
    if (existsSync(source)) cpSync(source, target, { recursive: true });
    return target;
}
