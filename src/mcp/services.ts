import { RegistryPublisher } from '../registry/index.js';
import { WorkbenchInspector } from '../workbench/index.js';
import type { Services } from '../workbench/services.js';
import { McpRunLauncher } from './run.js';
import { WorkbenchMcpServer } from './server.js';
import { McpSupervision } from './supervision.js';
import { McpWorkbenchOperations } from './workbenches.js';

/** The MCP tool operations of one home and working directory, wired once. */
export class McpServices {
    readonly workbenches: McpWorkbenchOperations;
    readonly launcher: McpRunLauncher;
    readonly supervision: McpSupervision;
    readonly server: WorkbenchMcpServer;

    constructor(home: string, cwd: string, services: Services) {
        this.workbenches = new McpWorkbenchOperations(
            home,
            cwd,
            services.catalog,
            services.accounts,
            new WorkbenchInspector(home),
            new RegistryPublisher(services.accounts)
        );
        this.launcher = new McpRunLauncher(cwd, services.launcher);
        this.supervision = new McpSupervision(
            services.sessionSupervision,
            services.control,
            services.lifecycle,
            services.runs,
            services.supervision,
            services.projects
        );
        this.server = new WorkbenchMcpServer(
            this.workbenches,
            this.launcher,
            this.supervision,
            services.projects,
            services.studio.board
        );
    }
}
