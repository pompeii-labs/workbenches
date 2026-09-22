#!/usr/bin/env node
// game-export [project-directory] [output-directory]
// Imports resources, exports the project's own Web preset, creates that
// preset (single-threaded, Compatibility-safe) if the project has none yet,
// and verifies the html/wasm/pck landed. Never scaffolds a game.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';

function fail(message) {
    console.error('game-export: ' + message);
    process.exit(1);
}

if (process.argv.includes('--help')) {
    console.log(
        'game-export [project-directory] [output-directory]\n' +
            'Imports and exports the Web preset (created if missing, single-threaded).'
    );
    process.exit(0);
}

// Preflight: fail fast, one line, if the environment cannot run Godot at all.
try {
    const probe = join(tmpdir(), '.game-export-write-probe-' + process.pid);
    writeFileSync(probe, '');
    statSync(probe);
    unlinkSync(probe);
} catch {
    fail('cannot run here (temp directory is not writable). Skip this tool; do not try to repair it.');
}
try {
    statSync(join(homedir(), '.'));
} catch {
    fail('cannot run here (HOME is unwritable or missing). Skip this tool; do not try to repair it.');
}
const templatesDir = '/opt/godot/templates';
if (!existsSync(templatesDir) || statSync(templatesDir).isDirectory() === false) {
    fail('cannot run here (Godot export templates are missing from the image). Skip this tool; do not try to repair it.');
}

const project = resolve(process.argv[2] || '.');
const output = resolve(project, process.argv[3] || 'build/web');
if (!existsSync(join(project, 'project.godot'))) fail('missing project.godot in ' + project);

const within = relative(project, output);
if (!within || within.startsWith('..') || isAbsolute(within))
    fail('output directory must be a subdirectory of the project');
mkdirSync(output, { recursive: true });
if (!existsSync(join(output, '.gdignore'))) writeFileSync(join(output, '.gdignore'), '');

const presetsPath = join(project, 'export_presets.cfg');
if (!existsSync(presetsPath)) {
    console.log('No export_presets.cfg found; creating a single-threaded Web preset.');
    writeFileSync(
        presetsPath,
        [
            '[preset.0]',
            '',
            'name="Web"',
            'platform="Web"',
            'runnable=true',
            'advanced_options=false',
            'dedicated_server=false',
            'custom_features=""',
            'export_filter="all_resources"',
            'include_filter=""',
            'exclude_filter=""',
            'export_path="build/web/index.html"',
            'patches=PackedStringArray()',
            'encryption_include_filters=""',
            'encryption_exclude_filters=""',
            'encrypt_pck=false',
            'encrypt_directory=false',
            'script_export_mode=2',
            '',
            '[preset.0.options]',
            '',
            'custom_template/debug=""',
            'custom_template/release=""',
            'variant/extensions_support=false',
            'variant/thread_support=false',
            'vram_texture_compression/for_desktop=true',
            'vram_texture_compression/for_mobile=false',
            'html/export_icon=true',
            'html/custom_html_shell=""',
            'html/head_include=""',
            'html/canvas_resize_policy=2',
            'html/focus_canvas_on_start=true',
            'html/experimental_virtual_keyboard=false',
            'progressive_web_app/enabled=false',
            '',
        ].join('\n')
    );
} else {
    const cfg = readFileSync(presetsPath, 'utf8');
    if (/variant\/thread_support\s*=\s*true/.test(cfg))
        console.log(
            'Warning: export_presets.cfg has variant/thread_support=true. Ordinary ' +
                'static hosts do not send the COOP/COEP headers threaded Web exports ' +
                'need; the exported page will fail to start there.'
        );
}

for (const args of [
    ['--headless', '--path', project, '--import'],
    ['--headless', '--path', project, '--export-release', 'Web', join(output, 'index.html')],
]) {
    const result = spawnSync('godot', args, { stdio: 'inherit', timeout: 180000 });
    if (result.error) fail('cannot run here (' + result.error.message + '). Skip this tool; do not try to repair it.');
    if (result.signal === 'SIGTERM') fail('godot timed out after 180s running: ' + args.join(' '));
    if (result.status !== 0) fail('godot exited ' + result.status + ' running: ' + args.join(' '));
}
for (const ext of ['html', 'wasm', 'pck']) {
    const path = join(output, 'index.' + ext);
    if (!existsSync(path) || statSync(path).size === 0)
        fail(
            'export did not produce ' +
                path +
                ' (no Web export preset in the project, or the export failed silently)'
        );
}
console.log('Export ready: ' + output);
