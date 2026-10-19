import { defineCommand } from 'citty';

import { Connection } from '../database/connection.js';
import { McpServices } from '../mcp/index.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';

export const mcpCommand = defineCommand({
    meta: { name: 'mcp', description: 'Serve local Workbench tools over MCP stdio.' },
    async run() {
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const services = new Services(home, connection);
            await new McpServices(home, process.cwd(), services).server.serve();
        } finally {
            connection.close();
        }
    },
});
