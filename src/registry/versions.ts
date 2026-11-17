export interface RegistryStoredVersion {
    id: string;
    version: string;
    prerelease: boolean;
    withdrawn: boolean;
}

/** A semantic version, prerelease and build metadata included. */
export const semverPattern =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A Workbench's stored versions, as members see them, and the release to publish. */
export class RegistryStoredVersions {
    private constructor(readonly versions: readonly RegistryStoredVersion[]) {}

    static parse(value: unknown): RegistryStoredVersions {
        const malformed = () =>
            new Error('The registry returned a malformed version listing');
        if (
            typeof value !== 'object' ||
            value === null ||
            !('versions' in value) ||
            !Array.isArray(value.versions)
        ) {
            throw malformed();
        }
        const versions = value.versions.map((entry: unknown) => {
            if (
                typeof entry !== 'object' ||
                entry === null ||
                !('id' in entry) ||
                typeof entry.id !== 'string' ||
                !entry.id ||
                !('version' in entry) ||
                typeof entry.version !== 'string' ||
                !semverPattern.test(entry.version) ||
                !('prerelease' in entry) ||
                typeof entry.prerelease !== 'boolean' ||
                !('withdrawn' in entry) ||
                typeof entry.withdrawn !== 'boolean'
            )
                throw malformed();
            return {
                id: entry.id,
                version: entry.version,
                prerelease: entry.prerelease,
                withdrawn: entry.withdrawn,
            };
        });
        // Deletion acts on the id found by version, so either repeating is ambiguous.
        if (
            new Set(versions.map((entry) => entry.id)).size !== versions.length ||
            new Set(versions.map((entry) => entry.version)).size !== versions.length
        )
            throw malformed();
        return new RegistryStoredVersions(versions);
    }

    /** The requested release, or the newest one by semver when none is named. */
    release(requested?: string): RegistryStoredVersion {
        if (requested !== undefined) {
            const selected = this.versions.find((entry) => entry.version === requested);
            if (!selected)
                throw new Error(
                    `Version ${requested} is not stored. Push the package with wb push first.`
                );
            if (RegistryStoredVersions.prerelease(selected))
                throw new Error(
                    `Version ${requested} is a prerelease and cannot be published.`
                );
            if (selected.withdrawn)
                throw new Error(
                    `Version ${requested} is withdrawn and cannot be published.`
                );
            return selected;
        }
        const selected = this.versions
            .filter(
                (entry) => !RegistryStoredVersions.prerelease(entry) && !entry.withdrawn
            )
            .sort((left, right) => Bun.semver.order(right.version, left.version))[0];
        if (!selected)
            throw new Error(
                'No stored release is available to publish. Push a release with wb push first.'
            );
        return selected;
    }

    private static prerelease(entry: RegistryStoredVersion): boolean {
        return entry.prerelease || !!entry.version.split('+')[0]?.includes('-');
    }
}
