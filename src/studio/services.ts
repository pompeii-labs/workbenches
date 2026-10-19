import { WorkbenchFiles } from '../files/layout.js';
import { OutcomeStore } from '../outcomes/store.js';
import type { HostCommands } from '../processes/commands.js';
import type { Services } from '../workbench/services.js';
import { StudioBoard } from './board.js';
import { BrowserOpener } from './browser.js';
import { StudioCommands } from './commands.js';
import { StudioDocker } from './docker.js';
import { StudioLifecycle } from './lifecycle.js';
import { StudioHandoff } from './openlink.js';
import { StudioServer } from './server.js';
import { StudioState } from './state.js';
import { StudioWakeSocket } from './wake.js';

/** The Studio parts of one Workbench home, wired once over its services. */
export class StudioServices {
    readonly outcomes: OutcomeStore;
    readonly board: StudioBoard;
    readonly state: StudioState;
    readonly wake: StudioWakeSocket;
    readonly lifecycle: StudioLifecycle;

    constructor(
        home: string,
        private readonly services: Pick<
            Services,
            | 'registry'
            | 'projects'
            | 'runs'
            | 'sessions'
            | 'supervision'
            | 'lifecycle'
            | 'control'
            | 'probe'
        >,
        platform: NodeJS.Platform,
        commands: Pick<HostCommands, 'run' | 'runSync' | 'launch'>,
        now: () => number
    ) {
        this.outcomes = new OutcomeStore(home);
        this.board = new StudioBoard(
            services.runs,
            services.sessions,
            services.supervision,
            this.outcomes,
            services.projects
        );
        this.state = new StudioState(new WorkbenchFiles(home).studioState);
        this.wake = new StudioWakeSocket(home);
        this.lifecycle = new StudioLifecycle(
            home,
            this.state,
            new StudioHandoff(home),
            new StudioDocker(home, platform, commands),
            this.wake,
            services.registry,
            services.probe,
            new BrowserOpener(platform, commands),
            now
        );
    }

    /**
     * The API server for a token and port, built over these parts. Command
     * results live only as long as the server it builds.
     */
    server(token: string, port: number): StudioServer {
        return new StudioServer(
            token,
            port,
            this.board,
            new StudioCommands(
                this.services.runs,
                this.services.lifecycle,
                this.services.control
            ),
            this.wake,
            this.services.runs
        );
    }
}
