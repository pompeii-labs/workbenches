import { RegistryCredentialFile } from './credentials.js';

/**
 * Chooses which held organization key, if any, to attach to a registry read.
 * Reads are best effort: an unreadable credential file means anonymous access,
 * never a failed public lookup.
 */
export class RegistryKeyring {
    readonly #file: RegistryCredentialFile;

    constructor(
        home: string,
        readonly apiUrl: string
    ) {
        this.#file = new RegistryCredentialFile(home);
    }

    /**
     * The key of the organization matching `publisher`, else the default
     * organization's key, else nothing. Expired keys are never sent.
     */
    async select(publisher?: string): Promise<string | undefined> {
        const { defaultSlug, keys } = await this.held();
        const now = new Date();
        const usable = keys.filter((key) => new Date(key.expiresAt) > now);
        const match = publisher
            ? usable.find((key) => key.slug === publisher)
            : undefined;
        return (match ?? usable.find((key) => key.slug === defaultSlug))?.token;
    }

    /** Whether any organization with this slug is held, even if expired. */
    async holds(slug: string): Promise<boolean> {
        return (await this.held()).keys.some((key) => key.slug === slug);
    }

    private async held() {
        try {
            const { registries } = await this.#file.read();
            const entry = registries.find((candidate) => candidate.url === this.apiUrl);
            return {
                defaultSlug: entry?.defaultSlug,
                keys: entry?.organizations ?? [],
            };
        } catch {
            return { defaultSlug: undefined, keys: [] };
        }
    }
}
