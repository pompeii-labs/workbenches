import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelConnection } from '../src/commands/connection.js';
import { CliPresenter } from '../src/commands/presenter.js';
import type { ConnectionCheck } from '../src/connections/check.js';
import { HostCredentialFiles } from '../src/connections/credentials.js';
import { AuthenticationRequiredError } from '../src/connections/error.js';
import type { RunnerAuthenticationStatus } from '../src/connections/inspector.js';
import { NativeCredentialFile } from '../src/connections/nativecredentials.js';
import { ConnectionSetup, type ConnectionWorkbench } from '../src/connections/setup.js';
import { HostSignIn } from '../src/connections/signin.js';
import { ConnectionStore } from '../src/connections/store.js';
import type { ConnectionTarget } from '../src/connections/targets.js';
import type {
    PreparedRuntime,
    RuntimeCredentialFiles,
} from '../src/runtimes/contracts.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('native credential files', () => {
    test('merges one provider into the store, keeping other entries private', async () => {
        const root = await temporary('workbench-native-');
        const files = new HostCredentialFiles(root);
        const file = NativeCredentialFile.for('opencode');
        await file.save(files, 'anthropic', file.apiKey('fixture-anthropic'));
        await file.save(files, 'openrouter', file.apiKey(' fixture-openrouter\n'));

        const path = join(root, 'opencode', 'auth.json');
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
            anthropic: { type: 'api', key: 'fixture-anthropic' },
            openrouter: { type: 'api', key: 'fixture-openrouter' },
        });
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(root, 'opencode'))).mode & 0o777).toBe(0o700);
        expect(await readdir(join(root, 'opencode'))).toEqual(['auth.json']);

        expect(await file.remove(files, 'openrouter')).toBeTrue();
        expect(await file.remove(files, 'openrouter')).toBeFalse();
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
            anthropic: { type: 'api', key: 'fixture-anthropic' },
        });
    });

    test('uses each runner documented format', async () => {
        const pi = NativeCredentialFile.for('pi');
        expect(pi.path).toBe('auth.json');
        expect(pi.apiKey('fixture').value).toEqual({ type: 'api_key', key: 'fixture' });
        const openCode = NativeCredentialFile.for('opencode');
        expect(openCode.path).toBe('opencode/auth.json');
        expect(openCode.apiKey('fixture').value).toEqual({
            type: 'api',
            key: 'fixture',
        });
        expect(() => openCode.apiKey('  ')).toThrow('The API key is empty');
        expect(openCode.serves({ type: 'oauth', value: {} }, 'api')).toBeFalse();
        expect(openCode.serves({ type: 'oauth', value: {} }, 'native')).toBeTrue();
        expect(() => NativeCredentialFile.for('codex')).toThrow('Unsupported runner');
    });

    test('removes its temporary file when a write fails', async () => {
        const root = await temporary('workbench-native-failed-');
        // A directory where the file belongs makes the final rename fail.
        await mkdir(join(root, 'auth.json', 'blocked'), { recursive: true });
        await expect(
            new HostCredentialFiles(root).write('auth.json', '{"fixture":true}\n')
        ).rejects.toThrow();
        expect((await readdir(root)).toSorted()).toEqual(['auth.json']);
        await expect(
            new HostCredentialFiles(root).write('../auth.json', 'x')
        ).rejects.toThrow('Invalid credential path');
    });

    test('leaves a credential file it cannot parse unchanged', async () => {
        const root = await temporary('workbench-native-invalid-');
        await writeFile(join(root, 'auth.json'), 'not json');
        const file = NativeCredentialFile.for('pi');
        await expect(
            file.save(
                new HostCredentialFiles(root),
                'openrouter',
                file.apiKey('fixture')
            )
        ).rejects.toThrow('was left unchanged');
        expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('not json');
    });
});

describe('connection setup', () => {
    test('writes Docker credentials inside the prepared runtime and reports what the runner lists', async () => {
        const home = await temporary('workbench-setup-docker-');
        const volume = new MemoryFiles();
        const checks: string[] = [];
        const setup = new ConnectionSetup({
            home,
            target: target('docker'),
            environment: {},
            workbench: workbench(),
            check: () => ({
                open: (work) => work(runtime(volume), unusedRunner()),
                inspect: async (options = {}) => {
                    checks.push('inspect');
                    await options.before?.(runtime(volume));
                    return status(volume.lists('openrouter'));
                },
            }),
        });
        const file = NativeCredentialFile.for('opencode');

        await expect(setup.save(file.apiKey('fixture-key'))).resolves.toEqual({
            ready: true,
            saved: false,
            fromEnvironment: false,
        });
        expect(JSON.parse(volume.get('opencode/auth.json'))).toEqual({
            openrouter: { type: 'api', key: 'fixture-key' },
        });
        expect(checks).toEqual(['inspect']);
        expect(await setup.remove(['openrouter'])).toBeTrue();
        expect(JSON.parse(volume.get('opencode/auth.json'))).toEqual({});
        await expect(setup.verify()).resolves.toMatchObject({
            ready: false,
            missing:
                'OpenCode in Docker has no OpenRouter credential for OpenRouter sign-in',
        });
    });

    test('counts only routes that serve the chosen method', async () => {
        const home = await temporary('workbench-setup-method-');
        const routes = [
            {
                provider: 'openai',
                nativeProvider: 'openai',
                nativeModel: 'gpt',
                authenticationMethod: 'api',
            },
        ];
        const setup = new ConnectionSetup({
            home,
            target: chatgpt('docker'),
            environment: { OPENAI_API_KEY: 'fixture' },
            workbench: workbench(),
            check: () => ({
                open: (work) => work(runtime(new MemoryFiles()), unusedRunner()),
                inspect: async () => ({ ...status(false), connections: routes }),
            }),
        });
        // An API key in the environment does not make a ChatGPT subscription ready.
        await expect(setup.verify()).resolves.toMatchObject({ ready: false });
        const e2b = new ConnectionSetup({
            home,
            target: chatgpt('e2b'),
            environment: { OPENAI_API_KEY: 'fixture' },
        });
        await expect(e2b.verify()).resolves.toMatchObject({ ready: false });
        await NativeCredentialFile.for('opencode').save(
            new HostCredentialFiles(
                await mkdirPrivate(join(home, 'runtime-credentials', 'e2b', 'opencode'))
            ),
            'openai',
            { type: 'oauth', value: { type: 'oauth', refresh: 'fixture' } }
        );
        await expect(e2b.verify()).resolves.toEqual({
            ready: true,
            saved: true,
            fromEnvironment: false,
        });
    });

    test('lets a stored Pi entry decide readiness, as Pi reads it before the environment', async () => {
        const home = await temporary('workbench-setup-pi-');
        const target = {
            ...chatgpt('e2b'),
            harness: 'pi' as const,
            method: {
                id: 'api-key',
                label: 'OpenAI API key',
                nativeProvider: 'openai',
                authenticationMethod: 'api' as const,
            },
        };
        const setup = new ConnectionSetup({
            home,
            target,
            environment: { OPENAI_API_KEY: 'fixture' },
        });
        await expect(setup.verify()).resolves.toMatchObject({
            ready: true,
            fromEnvironment: true,
        });
        await NativeCredentialFile.for('pi').save(
            new HostCredentialFiles(
                await mkdirPrivate(join(home, 'runtime-credentials', 'e2b', 'pi'))
            ),
            'openai',
            { type: 'oauth', value: { type: 'oauth', refresh: 'fixture' } }
        );
        await expect(setup.verify()).resolves.toMatchObject({
            ready: false,
            missing: 'The saved OpenAI credential for Pi is oauth, not OpenAI API key',
        });
    });

    test('verifies E2B from the host store without preparing a sandbox', async () => {
        const home = await temporary('workbench-setup-remote-');
        const setup = new ConnectionSetup({
            home,
            target: target('e2b'),
            environment: {},
            workbench: workbench(),
            check: () => {
                throw new Error('a sandbox must not be prepared');
            },
        });
        await expect(setup.verify()).resolves.toMatchObject({ ready: false });
        expect(await readdir(home)).toEqual([]);
        await expect(
            setup.save(NativeCredentialFile.for('opencode').apiKey('fixture'))
        ).resolves.toEqual({ ready: true, saved: true, fromEnvironment: false });
        const directory = join(home, 'runtime-credentials', 'e2b', 'opencode');
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
    });

    test('treats Daytona as environment-only because runs mount no runner store', async () => {
        const home = await temporary('workbench-setup-daytona-');
        const setup = (environment: Record<string, string>) =>
            new ConnectionSetup({
                home,
                target: target('daytona'),
                environment,
                check: () => {
                    throw new Error('a sandbox must not be prepared');
                },
            });
        expect(() => setup({}).requireStore()).toThrow(
            'Daytona has no runner credential store'
        );
        await expect(setup({}).verify()).resolves.toMatchObject({
            ready: false,
            missing:
                'Daytona has no runner credential store, so OpenCode there reads OpenRouter keys only from the environment',
        });
        await expect(
            setup({ OPENROUTER_API_KEY: 'fixture' }).verify()
        ).resolves.toEqual({ ready: true, saved: false, fromEnvironment: true });
        await expect(
            setup({}).save(NativeCredentialFile.for('opencode').apiKey('fixture'))
        ).rejects.toThrow('Daytona has no runner credential store');
        await expect(setup({}).remove(['openrouter'])).rejects.toThrow(
            'Daytona has no runner credential store'
        );
        expect(await readdir(home)).toEqual([]);
    });
});

describe('model connection', () => {
    test('exits 3 with the missing piece and the command that fixes it', async () => {
        const home = await temporary('workbench-connection-missing-');
        const connection = new ModelConnection({
            home,
            target: target('e2b'),
            output: presenter([]),
            environment: { HOME: await temporary('workbench-user-') },
            interactive: false,
            signIn: new HostSignIn({ which: () => null }),
        });

        const failure = await connection
            .connect({ stdin: false })
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AuthenticationRequiredError);
        expect((failure as AuthenticationRequiredError).exitCode).toBe(3);
        expect((failure as Error).message).toBe(
            'No OpenRouter credential is saved for OpenCode in E2B. Pass the OpenRouter API key on standard input: wb connect --runtime e2b --harness opencode --provider openrouter --method native --stdin. For one run, --env-file also works.'
        );
        // Nothing is written, and no default is saved for a route that cannot run.
        expect(await readdir(home)).toEqual([]);
    });

    test('rejects flags that would do nothing, before reading or writing', async () => {
        const home = await temporary('workbench-connection-flags-');
        const connect = (connectionTarget: ConnectionTarget) =>
            new ModelConnection({
                home,
                target: connectionTarget,
                output: presenter([]),
                environment: {},
                interactive: false,
                readKey: async () => {
                    throw new Error('stdin must not be read');
                },
            }).connect({ stdin: true });

        await expect(connect(target('local'))).rejects.toThrow(
            'Workbench neither writes nor removes it'
        );
        await expect(connect(target('daytona'))).rejects.toThrow(
            'Daytona has no runner credential store'
        );
        await expect(connect(chatgpt('e2b'))).rejects.toThrow(
            '--stdin reads an API key, but ChatGPT subscription (headless) is a sign-in'
        );
        expect(await readdir(home)).toEqual([]);
    });

    test('asks for a pasted key, never a sign-in, for a method that is not a subscription', async () => {
        const home = await temporary('workbench-connection-paste-');
        const failure = await new ModelConnection({
            home,
            target: target('e2b'),
            output: presenter([]),
            environment: {},
            interactive: false,
            signIn: {
                available: () => true,
                run: () => Promise.reject(new Error('a key method must not sign in')),
            },
        })
            .connect({ stdin: false })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AuthenticationRequiredError);
        expect((failure as Error).message).toContain(
            'Pass the OpenRouter API key on standard input'
        );
    });

    test('rejects a piped value that is not a bare key', async () => {
        const home = await temporary('workbench-connection-key-');
        const connect = (value: string) =>
            new ModelConnection({
                home,
                target: target('e2b'),
                output: presenter([]),
                environment: {},
                interactive: false,
                readKey: async () => value,
            }).connect({ stdin: true });

        await expect(connect('OPENROUTER_API_KEY=fixture\n')).rejects.toThrow(
            'not an env-file line'
        );
        await expect(connect('fixture one\n')).rejects.toThrow(
            'contains whitespace or several lines'
        );
        await expect(connect('fixture\nsecond\n')).rejects.toThrow(
            'contains whitespace or several lines'
        );
        await expect(connect(' fixture\n')).rejects.toThrow('contains whitespace');
        expect(await readdir(home)).toEqual([]);
        await connect('fixture-padded==\n');
        expect(await readdir(home)).toContain('runtime-credentials');
    });

    test('keeps the previous default when a connection fails, and forgets it on remove', async () => {
        const home = await temporary('workbench-connection-default-');
        const store = new ConnectionStore(home);
        const context = { runner: 'opencode', runtime: 'e2b' };
        const connection = (connectionTarget: ConnectionTarget, key?: string) =>
            new ModelConnection({
                home,
                target: connectionTarget,
                output: presenter([]),
                environment: { HOME: home },
                interactive: false,
                ...(key ? { readKey: async () => key } : {}),
            });

        await connection(target('e2b'), 'fixture').connect({ stdin: true });
        expect((await store.find(context))?.provider).toBe('openrouter');
        await expect(
            connection(chatgpt('e2b')).connect({ stdin: false })
        ).rejects.toBeInstanceOf(AuthenticationRequiredError);
        expect((await store.find(context))?.provider).toBe('openrouter');

        await connection(chatgpt('e2b')).remove([chatgpt('e2b').method]);
        expect((await store.find(context))?.provider).toBe('openrouter');
        await connection(target('e2b')).remove([target('e2b').method]);
        expect(await store.find(context)).toBeUndefined();
    });

    test('writes a key read from stdin and reports a saved remote route', async () => {
        const home = await temporary('workbench-connection-stdin-');
        const lines: string[] = [];
        await new ModelConnection({
            home,
            target: target('e2b'),
            output: presenter(lines),
            environment: {},
            interactive: false,
            readKey: async () => 'fixture-stdin-key\n',
        }).connect({ stdin: true });

        expect(lines).toEqual(['saved\te2b\topencode\topenrouter\n']);
        expect(
            JSON.parse(
                await readFile(
                    join(
                        home,
                        'runtime-credentials',
                        'e2b',
                        'opencode',
                        'opencode',
                        'auth.json'
                    ),
                    'utf8'
                )
            )
        ).toEqual({ openrouter: { type: 'api', key: 'fixture-stdin-key' } });
    });

    test('prints Ready only after the runtime check lists the provider', async () => {
        const home = await temporary('workbench-connection-ready-');
        const lines: string[] = [];
        const volume = new MemoryFiles();
        const setup = new ConnectionSetup({
            home,
            target: target('docker'),
            environment: {},
            workbench: workbench(),
            check: () => ({
                open: (work) => work(runtime(volume), unusedRunner()),
                inspect: async (options = {}) => {
                    await options.before?.(runtime(volume));
                    return status(volume.lists('openrouter'));
                },
            }),
        });
        await new ModelConnection({
            home,
            target: target('docker'),
            workbench: workbench(),
            output: presenter(lines),
            environment: {},
            interactive: false,
            readKey: async () => 'fixture-pasted\n',
            setup,
        }).connect({ stdin: true });

        expect(lines).toEqual(['ready\tdocker\topencode\topenrouter\n']);
        expect(JSON.parse(volume.get('opencode/auth.json'))).toEqual({
            openrouter: { type: 'api', key: 'fixture-pasted' },
        });
    });

    test('signs in fresh for a subscription into a private directory', async () => {
        const home = await temporary('workbench-connection-fresh-');
        const user = await temporary('workbench-user-');
        const subscription = chatgpt('e2b');
        const signIns: string[] = [];
        const lines: string[] = [];
        await new ModelConnection({
            home,
            target: subscription,
            output: presenter(lines),
            environment: { HOME: user },
            interactive: true,
            signIn: {
                available: () => true,
                run: async (target) => {
                    signIns.push(target.method.id);
                    return {
                        type: 'oauth',
                        value: { type: 'oauth', refresh: 'fixture-fresh' },
                    };
                },
            },
        }).connect({ stdin: false });

        expect(signIns).toEqual(['chatgpt']);
        expect(lines).toEqual(['saved\te2b\topencode\topenai\n']);
        expect(
            JSON.parse(
                await readFile(
                    join(
                        home,
                        'runtime-credentials',
                        'e2b',
                        'opencode',
                        'opencode',
                        'auth.json'
                    ),
                    'utf8'
                )
            )
        ).toEqual({ openai: { type: 'oauth', refresh: 'fixture-fresh' } });
    });

    test('offers Pi subscriptions an API key, since Pi has no command-line sign-in', async () => {
        const home = await temporary('workbench-connection-pi-');
        const user = await temporary('workbench-user-');
        const target = {
            ...chatgpt('e2b'),
            harness: 'pi' as const,
            method: {
                id: 'chatgpt',
                label: 'ChatGPT subscription',
                nativeProvider: 'openai-codex',
                authenticationMethod: 'oauth' as const,
            },
        };
        const failure = await new ModelConnection({
            home,
            target,
            output: presenter([]),
            environment: { HOME: user },
            interactive: false,
        })
            .connect({ stdin: false })
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AuthenticationRequiredError);
        expect((failure as Error).message).toContain(
            'Pi has no command-line sign-in, so a Pi subscription cannot be connected here. Use an API key instead: wb connect --runtime e2b --harness pi --provider openai --method api-key --stdin'
        );
        await expect(stat(join(home, 'runtime-credentials'))).rejects.toThrow();
    });
});

describe('host sign-in', () => {
    test('survives Ctrl-C during the login and still removes its temporary home', async () => {
        const root = await temporary('workbench-signin-signal-');
        const user = await mkdirPrivate(join(root, 'user'));
        const scratch = await mkdirPrivate(join(root, 'tmp'));
        const script = join(root, 'signal.ts');
        await writeFile(
            script,
            [
                `import { stat } from 'node:fs/promises';`,
                `import { HostSignIn } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'connections', 'signin.ts'))};`,
                `const before = process.listenerCount('SIGINT');`,
                'let home = "";',
                'const signIn = new HostSignIn({',
                `    which: () => '/usr/local/bin/opencode',`,
                '    interact: async (_command, env) => {',
                '        home = env.XDG_DATA_HOME ?? "";',
                // The terminal sends Ctrl-C to the whole process group, wb included.
                `        process.kill(process.pid, 'SIGINT');`,
                `        process.kill(process.pid, 'SIGTERM');`,
                '        await Bun.sleep(200);',
                '        return 130;',
                '    },',
                '});',
                'const target = { runtime: "e2b", harness: "opencode", provider: "openai", method: { id: "chatgpt", label: "ChatGPT", nativeProvider: "openai", authenticationMethod: "oauth" } };',
                'const entry = await signIn.run(target, process.env);',
                'const removed = await stat(home).then(() => false, () => true);',
                `console.log(JSON.stringify({ entry: entry ?? null, removed, restored: process.listenerCount('SIGINT') === before }));`,
            ].join('\n')
        );
        const child = Bun.spawn([process.execPath, script], {
            cwd: root,
            env: {
                PATH: process.env.PATH,
                HOME: user,
                XDG_DATA_HOME: join(user, '.local', 'share'),
                PI_CODING_AGENT_DIR: join(user, '.pi', 'agent'),
                TMPDIR: scratch,
            },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(JSON.parse(stdout)).toEqual({
            entry: null,
            removed: true,
            restored: true,
        });
        expect(await readdir(scratch)).toEqual([]);
    });

    test('signs in against a private temporary data home and keeps only the provider entry', async () => {
        let command: string[] = [];
        let dataHome = '';
        const signIn = new HostSignIn({
            which: () => '/usr/local/bin/opencode',
            interact: async (argv, env) => {
                command = argv;
                dataHome = env.XDG_DATA_HOME ?? '';
                expect((await stat(dataHome)).mode & 0o777).toBe(0o700);
                await mkdir(join(dataHome, 'opencode'), { recursive: true });
                await writeFile(
                    join(dataHome, 'opencode', 'auth.json'),
                    JSON.stringify({
                        openai: { type: 'oauth', access: 'fixture-access' },
                        other: { type: 'api', key: 'fixture-other' },
                    })
                );
                return 0;
            },
        });
        const chatgpt = {
            ...target('e2b'),
            provider: 'openai',
            method: {
                id: 'chatgpt',
                label: 'ChatGPT subscription (headless)',
                nativeProvider: 'openai',
                nativeMethod: 'ChatGPT Pro/Plus (headless)',
                authenticationMethod: 'oauth' as const,
            },
        };

        expect(signIn.available(chatgpt)).toBeTrue();
        await expect(signIn.run(chatgpt, { HOME: '/home/user' })).resolves.toEqual({
            type: 'oauth',
            value: { type: 'oauth', access: 'fixture-access' },
        });
        expect(command).toEqual([
            '/usr/local/bin/opencode',
            'auth',
            'login',
            '--provider',
            'openai',
            '--method',
            'ChatGPT Pro/Plus (headless)',
        ]);
        await expect(stat(dataHome)).rejects.toThrow();
        expect(signIn.available({ ...chatgpt, harness: 'pi' })).toBeFalse();
    });
});

class MemoryFiles implements RuntimeCredentialFiles {
    readonly #files = new Map<string, string>();

    /** What `opencode auth list` would show: whether the provider has an entry. */
    lists(provider: string): boolean {
        const source = this.#files.get('opencode/auth.json');
        return source !== undefined && Object.hasOwn(JSON.parse(source), provider);
    }

    get(path: string): string {
        const value = this.#files.get(path);
        if (value === undefined) throw new Error(`Missing ${path}`);
        return value;
    }

    async read(path: string): Promise<string | undefined> {
        return this.#files.get(path);
    }

    async write(path: string, contents: string): Promise<void> {
        this.#files.set(path, contents);
    }
}

function target(runtime: ConnectionTarget['runtime']): ConnectionTarget {
    return {
        runtime,
        harness: 'opencode',
        provider: 'openrouter',
        method: {
            id: 'native',
            label: 'OpenRouter sign-in',
            nativeProvider: 'openrouter',
            authenticationMethod: 'native',
        },
    };
}

function chatgpt(runtime: ConnectionTarget['runtime']): ConnectionTarget {
    return {
        runtime,
        harness: 'opencode',
        provider: 'openai',
        method: {
            id: 'chatgpt',
            label: 'ChatGPT subscription (headless)',
            nativeProvider: 'openai',
            nativeMethod: 'ChatGPT Pro/Plus (headless)',
            authenticationMethod: 'oauth',
        },
    };
}

function workbench(): ConnectionWorkbench {
    return {
        workbench: {} as ResolvedWorkbench,
        reference: 'fixture',
        workspaceDirectory: '/repo',
    };
}

function runtime(files: RuntimeCredentialFiles): PreparedRuntime {
    return { name: 'docker', credentials: files } as unknown as PreparedRuntime;
}

function unusedRunner(): Parameters<Parameters<ConnectionCheck['open']>[0]>[1] {
    return {} as Parameters<Parameters<ConnectionCheck['open']>[0]>[1];
}

/** The fields of an inspection that readiness reads. */
function status(listed: boolean): RunnerAuthenticationStatus {
    const content = listed
        ? [{ provider: 'openrouter', nativeProvider: 'openrouter', nativeModel: 'x' }]
        : [];
    return {
        model: 'openai/gpt-5.6-terra',
        ready: listed,
        authenticatedProviders: listed ? ['openrouter'] : [],
        connections: content,
        routes: [],
        connectCommand: 'wb connect fixture --runtime docker',
    };
}

function presenter(lines: string[]): CliPresenter {
    return new CliPresenter({
        interactive: false,
        stdout: (value) => lines.push(value),
        stderr: (value) => lines.push(value),
    });
}

async function temporary(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function mkdirPrivate(directory: string): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
}
