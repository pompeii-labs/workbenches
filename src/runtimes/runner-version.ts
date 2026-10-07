import type { RuntimeCommandResult } from './contracts.js';

export function checkedRunnerVersion(
    command: string,
    minimum: string,
    result: RuntimeCommandResult
): string {
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const version = output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (result.code !== 0 || !version) {
        throw new Error(`Could not read ${command} version from ${command} --version`);
    }
    if (compareVersions(version, minimum) < 0) {
        throw new Error(
            `${command} ${version} is too old; Workbench requires ${command} ${minimum} or newer`
        );
    }
    return version;
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (
        let index = 0;
        index < Math.max(leftParts.length, rightParts.length);
        index++
    ) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}
