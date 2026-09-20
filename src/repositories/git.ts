import { RepositoryCredentials } from './credentials.js';

/** Only engine-generated Git metadata is used by authenticated host commands. */
export class RepositoryGit {
    constructor(private readonly environment: Record<string, string | undefined>) {}

    async execute(directory: string, args: string[], token?: string): Promise<string> {
        const child = Bun.spawn(
            [
                'git',
                '-c',
                'core.hooksPath=/dev/null',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'credential.helper=',
                '-c',
                'http.followRedirects=false',
                ...args,
            ],
            {
                cwd: directory,
                env: {
                    ...new RepositoryCredentials(this.environment).controlEnvironment(),
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_LFS_SKIP_SMUDGE: '1',
                    GIT_ALLOW_PROTOCOL: 'https',
                    ...(token
                        ? {
                              GIT_CONFIG_COUNT: '1',
                              GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
                              GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
                          }
                        : {}),
                },
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'ignore',
            }
        );
        const timeout = setTimeout(() => child.kill(), 120_000);
        try {
            const output = await new Response(child.stdout).text();
            if ((await child.exited) !== 0)
                throw new Error(
                    `Repository Git operation failed: ${args[0]}. Check repository access and Git availability.`
                );
            return output.trim();
        } finally {
            clearTimeout(timeout);
        }
    }
}
