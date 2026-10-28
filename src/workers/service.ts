import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

export interface WorkerServiceSpec {
    /** The daemon command line. */
    command: string[];
    /** Non-secret variables the daemon starts with, such as `PATH`. */
    environment: Record<string, string>;
    /** Where the service manager writes the daemon's own output. */
    outputPath: string;
}

export interface WorkerServiceCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface WorkerServiceDependencies {
    run?: (
        command: string[],
        env?: Record<string, string | undefined>
    ) => Promise<WorkerServiceCommandResult>;
    userHome?: string;
    uid?: number;
    user?: string;
    environment?: Record<string, string | undefined>;
    wait?: (milliseconds: number) => Promise<void>;
}

/**
 * The background service that keeps the worker daemon running without a
 * desktop session: a launchd agent in the user's background domain on macOS
 * and a systemd user service with lingering on Linux.
 */
export interface WorkerService {
    readonly kind: string;
    /** Writes the service definition and starts it, replacing an earlier one. */
    install(spec: WorkerServiceSpec): Promise<void>;
    /** Stops the service and keeps it from starting again at boot. */
    stop(): Promise<void>;
    running(): Promise<boolean>;
    /** Stops the service and removes its definition. */
    uninstall(): Promise<void>;
}

const WORKER_SERVICE_LABEL = 'dev.workbenches.worker';
const WORKER_SERVICE_UNIT = 'workbench-worker.service';

export function workerService(
    platform: NodeJS.Platform = process.platform,
    dependencies: WorkerServiceDependencies = {}
): WorkerService {
    if (platform === 'darwin') return new LaunchdWorkerService(dependencies);
    if (platform === 'linux') return new SystemdWorkerService(dependencies);
    if (platform === 'win32')
        throw new Error(
            'wb worker is not supported on Windows yet. Use macOS or Linux'
        );
    throw new Error(`wb worker is not supported on ${platform}`);
}

abstract class HostWorkerService {
    protected readonly runCommand: NonNullable<WorkerServiceDependencies['run']>;
    protected readonly userHome: string;
    protected readonly uid: number;
    protected readonly user: string;
    protected readonly environment: Record<string, string | undefined>;
    protected readonly wait: (milliseconds: number) => Promise<void>;

    constructor(dependencies: WorkerServiceDependencies) {
        this.runCommand = dependencies.run ?? runCommand;
        this.userHome = dependencies.userHome ?? homedir();
        this.uid = dependencies.uid ?? process.getuid?.() ?? 0;
        this.user = dependencies.user ?? userInfo().username;
        this.environment = dependencies.environment ?? process.env;
        this.wait = dependencies.wait ?? ((milliseconds) => Bun.sleep(milliseconds));
    }

    protected async require(command: string[], failure: string): Promise<string> {
        return this.check(
            await this.runCommand(command, this.commandEnvironment()),
            failure
        );
    }

    protected check(result: WorkerServiceCommandResult, failure: string): string {
        if (result.code !== 0) {
            const detail = (result.stderr || result.stdout).trim().split('\n').at(-1);
            throw new Error(detail ? `${failure}: ${detail}` : failure);
        }
        return result.stdout;
    }

    protected commandEnvironment(): Record<string, string | undefined> {
        return this.environment;
    }

    protected async writeDefinition(path: string, content: string): Promise<void> {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, { mode: 0o644 });
    }
}

export class LaunchdWorkerService extends HostWorkerService implements WorkerService {
    readonly kind = 'launchd';

    get path(): string {
        return join(
            this.userHome,
            'Library',
            'LaunchAgents',
            `${WORKER_SERVICE_LABEL}.plist`
        );
    }

    private get domain(): string {
        return `user/${this.uid}`;
    }

    private get target(): string {
        return `${this.domain}/${WORKER_SERVICE_LABEL}`;
    }

    async install(spec: WorkerServiceSpec): Promise<void> {
        await this.writeDefinition(this.path, launchdPlist(spec));
        await this.runCommand(['launchctl', 'bootout', this.target]);
        // `stop` disables the label, and launchd refuses to bootstrap a disabled label.
        await this.require(
            ['launchctl', 'enable', this.target],
            'launchd could not enable the worker service'
        );
        const bootstrap = ['launchctl', 'bootstrap', this.domain, this.path];
        let result = await this.runCommand(bootstrap, this.commandEnvironment());
        // bootout returns before launchd has finished removing the old job, and a
        // bootstrap meanwhile fails with error 5 (EIO). It succeeds once it is gone.
        if (result.code !== 0 && inputOutputError(result)) {
            await this.wait(1000);
            result = await this.runCommand(bootstrap, this.commandEnvironment());
        }
        this.check(result, 'launchd could not load the worker service');
        await this.require(
            ['launchctl', 'kickstart', this.target],
            'launchd could not start the worker service'
        );
    }

    async stop(): Promise<void> {
        await this.runCommand(['launchctl', 'bootout', this.target]);
        await this.runCommand(['launchctl', 'disable', this.target]);
    }

    async running(): Promise<boolean> {
        const result = await this.runCommand(['launchctl', 'print', this.target]);
        return result.code === 0 && /\bstate = running\b/.test(result.stdout);
    }

    async uninstall(): Promise<void> {
        await this.stop();
        await rm(this.path, { force: true });
    }
}

export class SystemdWorkerService extends HostWorkerService implements WorkerService {
    readonly kind = 'systemd';

    get path(): string {
        const config =
            this.environment.XDG_CONFIG_HOME || join(this.userHome, '.config');
        return join(config, 'systemd', 'user', WORKER_SERVICE_UNIT);
    }

    async install(spec: WorkerServiceSpec): Promise<void> {
        await this.writeDefinition(this.path, systemdUnit(spec));
        // Lingering keeps the user's services running after the SSH session ends.
        await this.require(
            ['loginctl', 'enable-linger', this.user],
            `Could not enable lingering for ${this.user}. Run sudo loginctl enable-linger ${this.user} and try again`
        );
        await this.require(
            ['systemctl', '--user', 'daemon-reload'],
            'systemd could not load the worker service'
        );
        await this.require(
            ['systemctl', '--user', 'enable', WORKER_SERVICE_UNIT],
            'systemd could not enable the worker service'
        );
        await this.require(
            ['systemctl', '--user', 'restart', WORKER_SERVICE_UNIT],
            'systemd could not start the worker service'
        );
    }

    async stop(): Promise<void> {
        await this.runCommand(
            ['systemctl', '--user', 'disable', '--now', WORKER_SERVICE_UNIT],
            this.commandEnvironment()
        );
    }

    async running(): Promise<boolean> {
        const result = await this.runCommand(
            ['systemctl', '--user', 'is-active', WORKER_SERVICE_UNIT],
            this.commandEnvironment()
        );
        return result.stdout.trim() === 'active';
    }

    async uninstall(): Promise<void> {
        await this.stop();
        await rm(this.path, { force: true });
        await this.runCommand(
            ['systemctl', '--user', 'daemon-reload'],
            this.commandEnvironment()
        );
    }

    /** Over SSH without a login session, `systemctl --user` needs the runtime directory. */
    protected override commandEnvironment(): Record<string, string | undefined> {
        return {
            ...this.environment,
            XDG_RUNTIME_DIR:
                this.environment.XDG_RUNTIME_DIR || `/run/user/${this.uid}`,
        };
    }
}

function launchdPlist(spec: WorkerServiceSpec): string {
    const string = (value: string) => `<string>${xml(value)}</string>`;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `    <key>Label</key>${string(WORKER_SERVICE_LABEL)}`,
        '    <key>ProgramArguments</key>',
        '    <array>',
        ...spec.command.map((argument) => `        ${string(argument)}`),
        '    </array>',
        '    <key>EnvironmentVariables</key>',
        '    <dict>',
        ...Object.entries(spec.environment).map(
            ([name, value]) => `        <key>${xml(name)}</key>${string(value)}`
        ),
        '    </dict>',
        '    <key>RunAtLoad</key><true/>',
        // Restart after a crash, not after the daemon stops on purpose.
        '    <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
        '    <key>ThrottleInterval</key><integer>10</integer>',
        '    <key>LimitLoadToSessionType</key><string>Background</string>',
        '    <key>ProcessType</key><string>Background</string>',
        // Runs are detached sessions in their own process groups and outlive the daemon.
        '    <key>AbandonProcessGroup</key><true/>',
        `    <key>StandardOutPath</key>${string(spec.outputPath)}`,
        `    <key>StandardErrorPath</key>${string(spec.outputPath)}`,
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}

function systemdUnit(spec: WorkerServiceSpec): string {
    return [
        '[Unit]',
        'Description=Workbench worker',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${spec.command.map(systemdQuote).join(' ')}`,
        ...Object.entries(spec.environment).map(
            ([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`
        ),
        // Restart after a crash, not after the daemon stops on purpose.
        'Restart=on-failure',
        'RestartSec=10',
        // Runs are detached sessions and must outlive a daemon stop or restart.
        'KillMode=process',
        `StandardOutput=append:${spec.outputPath}`,
        `StandardError=append:${spec.outputPath}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
}

/** launchctl's "Bootstrap failed: 5: Input/output error", reported as exit code 5. */
function inputOutputError(result: WorkerServiceCommandResult): boolean {
    return result.code === 5 || /\b5: Input\/output error\b/.test(result.stderr);
}

function systemdQuote(value: string): string {
    return `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/%/g, '%%')
        .replace(/\$/g, '$$$$')}"`;
}

function xml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function runCommand(
    command: string[],
    env?: Record<string, string | undefined>
): Promise<WorkerServiceCommandResult> {
    try {
        const child = Bun.spawn(command, {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
            ...(env ? { env } : {}),
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { code, stdout, stderr };
    } catch (error) {
        return {
            code: 127,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
        };
    }
}
