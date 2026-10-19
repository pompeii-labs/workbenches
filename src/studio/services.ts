import { OutcomeStore } from '../outcomes/store.js';
import type { HostCommands } from '../processes/commands.js';
import { CloudProjectClient } from '../projects/cloud.js';
import type { Services } from '../workbench/services.js';
import { StudioBoard } from './board.js';
import { BrowserOpener } from './browser.js';
import { StudioCloudRuns } from './cloud.js';
import { StudioCommands } from './commands.js';
import { StudioDocker } from './docker.js';
import { StudioLifecycle } from './lifecycle.js';
import { StudioHandoff } from './openlink.js';
import { StudioServer } from './server.js';
import { StudioWakeSocket } from './wake.js';

/** The Studio parts of one Workbench home, wired once over its services. */
export class StudioServices {
    readonly outcomes: OutcomeStore;
    readonly cloud: StudioCloudRuns;
    readonly board: StudioBoard;
    readonly commands: StudioCommands;
    readonly wake: StudioWakeSocket;
    readonly lifecycle: StudioLifecycle;

    constructor(
        home: string,
        private readonly services: Pick<
            Services,
            | 'cloud'
            | 'accounts'
            | 'registry'
            | 'cloudSessions'
            | 'projects'
            | 'runs'
            | 'sessions'
            | 'supervision'
            | 'studioCommands'
            | 'lifecycle'
            | 'control'
            | 'studioState'
            | 'probe'
        >,
        platform: NodeJS.Platform,
        commands: Pick<HostCommands, 'run' | 'runSync' | 'launch'>,
        now: () => number
    ) {
        this.outcomes = new OutcomeStore(home);
        this.cloud = new StudioCloudRuns(
            services.cloud,
            services.accounts,
            new CloudProjectClient(services.registry),
            services.cloudSessions,
            services.projects
        );
        this.board = new StudioBoard(
            services.runs,
            services.sessions,
            services.supervision,
            this.outcomes,
            services.projects,
            this.cloud
        );
        this.commands = new StudioCommands(
            services.runs,
            services.studioCommands,
            services.cloud,
            services.lifecycle,
            services.control
        );
        this.wake = new StudioWakeSocket(home);
        this.lifecycle = new StudioLifecycle(
            home,
            services.studioState,
            new StudioHandoff(home),
            new StudioDocker(home, platform, commands),
            this.wake,
            services.registry,
            services.probe,
            new BrowserOpener(platform, commands),
            now
        );
    }

    /** The API server for a token and port, built over these parts. */
    server(token: string, port: number): StudioServer {
        return new StudioServer(
            token,
            port,
            this.board,
            this.cloud,
            this.commands,
            this.wake,
            this.services.runs,
            this.services.cloudSessions
        );
    }
}
