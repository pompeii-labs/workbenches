import type { RuntimeCommandResult } from './contracts.js';

export type RuntimeOperatingSystem = 'linux' | 'macos' | 'windows' | string;

export class SubprocessEnvironmentScrubbing {
    async check(
        capability:
            | {
                  macos: boolean;
                  linuxProbe: string[];
              }
            | undefined,
        operatingSystem: RuntimeOperatingSystem,
        execute: (command: string[]) => Promise<Pick<RuntimeCommandResult, 'code'>>
    ): Promise<boolean | undefined> {
        if (!capability) return undefined;
        if (operatingSystem === 'macos') return capability.macos;
        if (operatingSystem !== 'linux') return false;
        try {
            return (await execute(capability.linuxProbe)).code === 0;
        } catch {
            return false;
        }
    }
}
