const githubCredentialNames = new Set([
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_CONFIG_DIR',
    'SSH_AUTH_SOCK',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
]);

/** Resolve GitHub access on the host; inject it only for an authenticated run. */
export class RepositoryCredentials {
    constructor(private readonly environment: Record<string, string | undefined>) {}

    async token(required = false): Promise<string | undefined> {
        let token = this.environment.GH_TOKEN || this.environment.GITHUB_TOKEN;
        if (
            !token &&
            Bun.which(
                'gh',
                this.environment.PATH ? { PATH: this.environment.PATH } : undefined
            )
        ) {
            const child = Bun.spawn(
                ['gh', 'auth', 'token', '--hostname', 'github.com'],
                {
                    env: this.controlEnvironment(),
                    stdin: 'ignore',
                    stdout: 'pipe',
                    stderr: 'ignore',
                }
            );
            const timer = setTimeout(() => child.kill(), 10_000);
            try {
                const output = await new Response(child.stdout).text();
                if ((await child.exited) === 0) token = output.trim();
            } finally {
                clearTimeout(timer);
            }
        }
        if (required && !token) {
            throw new Error(
                'Authenticated repository execution requires GitHub access. Set GH_TOKEN or run gh auth login.'
            );
        }
        if (token && /[\r\n\0]/.test(token))
            throw new Error('Invalid GitHub credential');
        return token || undefined;
    }

    runnerEnvironment(): Record<string, string | undefined> {
        return Object.fromEntries(
            Object.entries(this.environment).filter(
                ([name]) => !RepositoryCredentials.isProtected(name)
            )
        );
    }

    controlEnvironment(): Record<string, string | undefined> {
        const names = [
            'PATH',
            'HOME',
            'USER',
            'LOGNAME',
            'TMPDIR',
            'SystemRoot',
            'XDG_CONFIG_HOME',
            'GH_CONFIG_DIR',
        ];
        return Object.fromEntries(
            names
                .map((name) => [name, this.environment[name]])
                .filter(([, value]) => value !== undefined)
        );
    }

    static isProtected(name: string): boolean {
        return (
            githubCredentialNames.has(name) ||
            name.startsWith('GIT_CONFIG') ||
            name.startsWith('GIT_AUTHOR_') ||
            name.startsWith('GIT_COMMITTER_') ||
            name === 'GIT_DIR' ||
            name === 'GIT_WORK_TREE' ||
            name === 'GIT_OBJECT_DIRECTORY' ||
            name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
        );
    }
}
