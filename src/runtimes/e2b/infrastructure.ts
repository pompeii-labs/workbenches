export const e2bPricingSource = 'e2b-public-pricing-2026-09-11';

const e2bCpuUsdPerSecond = 0.000014;
const e2bMemoryGiBUsdPerSecond = 0.0000045;

export function estimateE2BCost(
    durationMilliseconds: number,
    cpuCount: number,
    memoryMB: number
): number {
    const seconds = durationMilliseconds / 1_000;
    const memoryGiB = memoryMB / 1_024;
    const amount =
        seconds *
        (Math.max(0, cpuCount) * e2bCpuUsdPerSecond +
            Math.max(0, memoryGiB) * e2bMemoryGiBUsdPerSecond);
    return Number(amount.toFixed(8));
}

export function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
