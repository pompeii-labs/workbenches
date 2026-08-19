import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function workbenchHome(
    environment: Record<string, string | undefined> = process.env
): string {
    const configured = environment.WORKBENCH_HOME;
    return configured ? resolve(configured) : join(homedir(), '.workbench');
}
