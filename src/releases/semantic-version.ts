export class SemanticVersion {
    private constructor(
        readonly major: number,
        readonly minor: number,
        readonly patch: number,
        readonly prerelease?: readonly string[]
    ) {}

    static parse(value: string): SemanticVersion | undefined {
        const match = value.match(
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
        );
        if (!match?.[1] || !match[2] || !match[3]) return undefined;
        return new SemanticVersion(
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            match[4]?.split('.')
        );
    }

    static compare(left: string, right: string): number {
        const leftVersion = SemanticVersion.parse(left);
        const rightVersion = SemanticVersion.parse(right);
        if (!leftVersion || !rightVersion) {
            throw new Error(`Cannot compare CLI versions: ${left}, ${right}`);
        }
        return leftVersion.compare(rightVersion);
    }

    compare(other: SemanticVersion): number {
        for (const key of ['major', 'minor', 'patch'] as const) {
            if (this[key] !== other[key]) return this[key] > other[key] ? 1 : -1;
        }
        if (!this.prerelease && !other.prerelease) return 0;
        if (!this.prerelease) return 1;
        if (!other.prerelease) return -1;
        return this.comparePrerelease(other.prerelease);
    }

    private comparePrerelease(other: readonly string[]): number {
        const length = Math.max(this.prerelease?.length ?? 0, other.length);
        for (let index = 0; index < length; index += 1) {
            const left = this.prerelease?.[index];
            const right = other[index];
            if (left === undefined) return -1;
            if (right === undefined) return 1;
            if (left === right) continue;
            const leftNumeric = /^\d+$/.test(left);
            const rightNumeric = /^\d+$/.test(right);
            if (leftNumeric && rightNumeric)
                return Number(left) > Number(right) ? 1 : -1;
            if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
            return left > right ? 1 : -1;
        }
        return 0;
    }
}

export class ReleaseTarget {
    private constructor(readonly name: string) {}

    static from(platform: string, architecture: string): ReleaseTarget {
        if (platform !== 'darwin' && platform !== 'linux') {
            throw new Error(`Unsupported release operating system: ${platform}`);
        }
        const normalizedArchitecture =
            architecture === 'arm64' || architecture === 'aarch64'
                ? 'arm64'
                : architecture === 'x64' || architecture === 'x86_64'
                  ? 'x64'
                  : undefined;
        if (!normalizedArchitecture) {
            throw new Error(`Unsupported release architecture: ${architecture}`);
        }
        return new ReleaseTarget(`workbench-${platform}-${normalizedArchitecture}`);
    }
}
