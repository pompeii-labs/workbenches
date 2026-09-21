import { afterEach } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { OutcomeChangeEntry, RunOutcome } from '../../src/outcomes/contracts.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { WorkspaceSnapshot } from '../../src/outcomes/workspace.js';
import type { RepositoryBinding } from '../../src/repositories/contracts.js';
import { RepositoryGit } from '../../src/repositories/git.js';
import { RepositoryGitHub } from '../../src/repositories/github.js';
import { RunStore } from '../../src/runs/store.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTemporary));
});

async function removeTemporary(path: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await rm(path, { recursive: true, force: true });
            return;
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'EACCES'
                ) ||
                attempt === 19
            )
                throw error;
            // Docker Desktop can briefly retain the nested .git mount after exit.
            await setTimeout(250);
        }
    }
}

export async function temporary(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'workbench-repository-'));
    directories.push(path);
    return path;
}

export const revision = 'a'.repeat(40);
export const baseTree = 'b'.repeat(40);
export const fixtureIdentity = async () => ({
    name: 'example',
    email: '123+example@users.noreply.github.com',
});
export const binding: RepositoryBinding = {
    owner: 'example',
    name: 'project',
    default_branch: 'main',
    base_branch: 'main',
    revision,
    tree: baseTree,
    session_id: 'wb_1234567890abcdefghij',
    delivery: 'pr',
};

export async function git(directory: string, args: string[]): Promise<string> {
    const child = Bun.spawn(
        [
            'git',
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            ...args,
        ],
        {
            cwd: directory,
            env: {
                PATH: process.env.PATH,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_SYSTEM: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
            },
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'ignore',
        }
    );
    const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) throw new Error(`Fixture Git failed: ${errors}`);
    return output.trim();
}

export class FixtureGit extends RepositoryGit {
    readonly calls: Array<{ directory: string; args: string[]; token?: string }> = [];
    constructor(private readonly source: string) {
        super({ PATH: process.env.PATH });
    }
    override async execute(
        directory: string,
        args: string[],
        token?: string
    ): Promise<string> {
        this.calls.push({ directory, args, ...(token ? { token } : {}) });
        if (args[0] === 'fetch')
            return git(directory, [
                'fetch',
                '--depth=1',
                this.source,
                args[3] as string,
            ]);
        return super.execute(directory, args, token);
    }
}

export async function checkoutFixture() {
    const root = await temporary();
    const source = join(root, 'source');
    const home = join(root, 'home');
    await mkdir(source);
    await git(source, ['init', '--template=', '--initial-branch=main']);
    await writeFile(join(source, 'original.txt'), 'original\n');
    await git(source, ['add', '.']);
    await git(source, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-m',
        'Initial',
    ]);
    const selected = {
        ...binding,
        revision: await git(source, ['rev-parse', 'HEAD']),
        tree: await git(source, ['rev-parse', 'HEAD^{tree}']),
    };
    return { root, source, home, binding: selected, git: new FixtureGit(source) };
}

export async function saveRun(
    home: string,
    selected: RepositoryBinding,
    id: string,
    outcome?: RunOutcome,
    previous?: string
) {
    const runs = new RunStore(home);
    await runs.create({
        id,
        metadata: {
            workbench: 'fixture',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            workspace: '/discovery',
            repository: selected,
            ...(previous ? { resumed_from: previous } : {}),
        },
        request: {
            workbench_path: '/fixture',
            workspace: '/discovery',
            repository: selected,
            task: 'Test',
        },
    });
    if (outcome) await runs.update(id, { outcome_id: outcome.id, status: 'completed' });
}

export async function result(
    home: string,
    entries: OutcomeChangeEntry[] = [],
    runId = binding.session_id
): Promise<RunOutcome> {
    const store = new OutcomeStore(home);
    const outcome: RunOutcome = {
        version: 1,
        id: `wbo_${runId.slice(3)}`,
        run_id: runId,
        created_at: '2026-09-18T12:00:00.000Z',
        completeness: 'complete',
        summary: 'Add the requested feature',
        changesets: entries.length
            ? [
                  {
                      id: 'change_primary',
                      workspace: { kind: 'primary' },
                      base: {
                          snapshot_digest: `sha256:${'c'.repeat(64)}`,
                          git_revision: revision,
                      },
                      entries,
                      stats: {
                          additions: entries.filter(
                              (entry) => entry.operation === 'add'
                          ).length,
                          modifications: entries.filter(
                              (entry) => entry.operation === 'modify'
                          ).length,
                          deletions: entries.filter(
                              (entry) => entry.operation === 'delete'
                          ).length,
                          binary_files: 0,
                      },
                  },
              ]
            : [],
        artifacts: [],
        links: [],
        warnings: [],
    };
    await store.commit(outcome, 'pending');
    await saveRun(home, binding, runId, outcome);
    await store.close();
    return outcome;
}

export async function capture(
    home: string,
    directory: string,
    runId: string,
    mutate: () => Promise<void>
): Promise<RunOutcome> {
    const snapshot = await WorkspaceSnapshot.create(directory, {
        workspace: { kind: 'primary' },
    });
    const store = new OutcomeStore(home);
    try {
        await mutate();
        const changes = await snapshot.collect(store);
        const outcome: RunOutcome = {
            version: 1,
            id: `wbo_${runId.slice(3)}`,
            run_id: runId,
            created_at: new Date().toISOString(),
            completeness: 'complete',
            changesets: changes ? [changes] : [],
            artifacts: [],
            links: [],
            warnings: [],
        };
        await store.commit(outcome, 'pending');
        return outcome;
    } finally {
        await snapshot.cleanup();
        await store.close();
    }
}

export class GitHubFixture {
    readonly calls: Array<{
        path: string;
        method: string;
        body: Record<string, unknown>;
        headers: Headers;
        redirect?: string | undefined;
    }> = [];
    readonly blobs: Buffer[] = [];
    base: Array<Record<string, string>> = [
        { path: 'untouched.txt', mode: '100644', type: 'blob', sha: 'd'.repeat(40) },
    ];
    tree: Array<Record<string, string>> = [];
    branch: string | undefined;
    pull: Record<string, unknown> | undefined;
    fail = '';
    loseBranchResponse = false;
    losePullResponse = false;
    stalePullReads = 0;
    stalePull: Record<string, unknown> | undefined;
    treeTruncated = false;
    private trees: string[] = [];
    private commits = 0;
    client = new RepositoryGitHub('fixture-credential', (async (input, init) => {
        const url = new URL(String(input));
        const path = url.pathname.replace('/repos/example/project', '') + url.search;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        this.calls.push({
            path,
            method: init?.method ?? 'GET',
            body,
            headers: new Headers(init?.headers),
            redirect: init?.redirect,
        });
        if (this.fail === path)
            return Response.json(
                { message: 'fixture-credential should never leak' },
                { status: 403 }
            );
        if (path.startsWith('/git/trees/') && init?.method === 'GET')
            return Response.json({
                sha: baseTree,
                tree: this.base,
                truncated: this.treeTruncated,
            });
        if (path === '/git/blobs') {
            this.blobs.push(Buffer.from(body.content, 'base64'));
            return Response.json({
                sha: String(this.blobs.length).repeat(40).slice(0, 40),
            });
        }
        if (path === '/git/trees') {
            this.tree = body.tree;
            const encoded = JSON.stringify(body.tree);
            if (!this.trees.includes(encoded)) this.trees.push(encoded);
            return Response.json({
                sha: (this.trees.indexOf(encoded) === 0 ? 'e' : 'c').repeat(40),
            });
        }
        if (path === '/git/commits')
            return Response.json({
                sha: (++this.commits === 1 ? 'f' : '8').repeat(40),
            });
        if (path.startsWith('/git/refs/heads/') && init?.method === 'PATCH') {
            this.stalePull = this.pull ? structuredClone(this.pull) : undefined;
            this.branch = body.sha;
            if (this.pull) (this.pull.head as { sha: string }).sha = body.sha;
            return Response.json({ object: { sha: this.branch } });
        }
        if (path.startsWith('/git/ref/heads/'))
            return this.branch
                ? Response.json({ object: { sha: this.branch } })
                : Response.json({}, { status: 404 });
        if (path === '/git/refs') {
            this.branch = body.sha;
            if (this.loseBranchResponse) throw new Error('lost response');
            return Response.json({ object: { sha: this.branch } });
        }
        if (path.startsWith('/pulls?'))
            return Response.json(this.pull ? [this.readPull()] : []);
        if (path === '/pulls/1') {
            if (init?.method === 'PATCH' && this.pull) Object.assign(this.pull, body);
            return Response.json(this.readPull());
        }
        if (path === '/pulls') {
            this.pull = {
                number: 1,
                state: 'open',
                merged: false,
                html_url: 'https://github.com/example/project/pull/1',
                base: { ref: body.base },
                head: {
                    ref: body.head,
                    sha: this.branch,
                    repo: { full_name: 'example/project' },
                },
            };
            if (this.losePullResponse) throw new Error('lost response');
            return Response.json(this.pull);
        }
        throw new Error(`Unexpected fixture request: ${path}`);
    }) as typeof fetch);

    private readPull() {
        if (this.stalePull && this.stalePullReads > 0) {
            this.stalePullReads--;
            return this.stalePull;
        }
        return this.pull;
    }
}
