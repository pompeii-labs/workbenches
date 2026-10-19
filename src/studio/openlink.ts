import { createHmac, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OPEN_KEY_MESSAGE = 'wb studio open v1';
const OPEN_CODE_SECONDS = 300;
const HANDOFF_DIRECTORY = 'studio';
const HANDOFF_FILE = /^studio-open-[a-f0-9]{32}\.html$/;

// The open link only proves the browser is the one `wb studio` opened.
export class StudioOpenLink {
    readonly #key: Buffer;

    constructor(
        token: string,
        private readonly now: () => number
    ) {
        this.#key = createHmac('sha256', Buffer.from(token, 'utf8'))
            .update(OPEN_KEY_MESSAGE)
            .digest();
    }

    code(): string {
        const expiry = Math.floor(this.now() / 1_000) + OPEN_CODE_SECONDS;
        const payload = `v1.${expiry}.${randomBytes(16).toString('base64url')}`;
        const signature = createHmac('sha256', this.#key)
            .update(payload)
            .digest('base64url');
        return `${payload}.${signature}`;
    }

    url(uiPort: number): string {
        return `http://127.0.0.1:${uiPort}/open?code=${this.code()}`;
    }
}

// Other local users can read process arguments, so the browser receives the
// open link through a page only this user can read.
export class StudioHandoff {
    readonly #directory: string;

    constructor(home: string) {
        this.#directory = join(home, HANDOFF_DIRECTORY);
    }

    async write(url: string): Promise<string> {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        const details = await lstat(this.#directory);
        if (!details.isDirectory() || details.isSymbolicLink())
            throw new Error(
                `Studio open link must use a real directory: ${this.#directory}`
            );
        await chmod(this.#directory, 0o700);
        const path = join(
            this.#directory,
            `studio-open-${randomBytes(16).toString('hex')}.html`
        );
        await writeFile(path, handoffPage(url), { mode: 0o600, flag: 'wx' });
        return path;
    }

    async clear(): Promise<void> {
        const details = await lstat(this.#directory).catch(() => undefined);
        if (!details?.isDirectory()) return;
        for (const name of await readdir(this.#directory)) {
            if (HANDOFF_FILE.test(name))
                await rm(join(this.#directory, name), { force: true });
        }
    }
}

function handoffPage(url: string): string {
    const href = url
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Workbench Studio</title>
</head>
<body><a href="${href}">Open Workbench Studio</a></body>
</html>
`;
}
