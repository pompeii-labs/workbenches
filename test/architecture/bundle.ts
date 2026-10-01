import { builtinModules } from 'node:module';

/**
 * Bundles one entry point and prints the bundle. The bundle boundary test runs
 * it in a child process because `Bun.build` inside `bun test` fails to resolve
 * some `.js` specifiers to their `.ts` files.
 *
 * Every built-in module, with or without the `node:` prefix, is marked external
 * so each import stays visible in the output. Without that, Bun's browser
 * target replaces a named built-in with a polyfill, and a forbidden module could
 * hide behind it. The browser target is a build setting that keeps Node-only
 * code paths out. It does not mean the output has run in a browser.
 */
const entry = process.argv[2];
if (!entry) throw new Error('Usage: bun bundle.ts <entry>');

const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    external: ['node:*', ...builtinModules],
    minify: false,
    throw: false,
});
if (!result.success) {
    console.error(result.logs.map((log) => log.message).join('\n'));
    process.exit(1);
}
for (const output of result.outputs) process.stdout.write(await output.text());
