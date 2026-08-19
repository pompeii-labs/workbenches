import solidPlugin from '@opentui/solid/bun-plugin';

const result = await Bun.build({
    entrypoints: ['./src/cli.ts'],
    target: 'bun',
    minify: true,
    plugins: [solidPlugin],
    compile: {
        outfile: './dist/workbench',
    },
});

if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
}

await Promise.all([
    Bun.write('./dist/LICENSE', Bun.file('./LICENSE')),
    Bun.write('./dist/NOTICE', Bun.file('./NOTICE')),
]);
