// Use Bun's CLI compiler so Windows executables run the bundled entrypoint.
const child = Bun.spawn(
    [
        process.execPath,
        'build',
        '--compile',
        '--minify',
        '--no-compile-autoload-bunfig',
        '--no-compile-autoload-dotenv',
        '--outfile',
        process.platform === 'win32' ? './dist/workbench.exe' : './dist/workbench',
        './src/cli.ts',
    ],
    { stdout: 'inherit', stderr: 'inherit' }
);
const code = await child.exited;
if (code !== 0) process.exit(code);

await Promise.all([
    Bun.write('./dist/LICENSE', Bun.file('./LICENSE')),
    Bun.write('./dist/NOTICE', Bun.file('./NOTICE')),
]);
