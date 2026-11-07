import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ClaudeCodeConfigStaging } from '@pompeii-labs/workbench/runners/claude-code/config';
import { PLATFORM_OPENROUTER_ACCESS } from '@pompeii-labs/workbench/runners/claude-code/openrouter';
import { ClaudeCodeRunner } from '@pompeii-labs/workbench/runners/claude-code/runner';
import { RunnerContextStaging } from '@pompeii-labs/workbench/runners/context';
import { MemoryRunnerFiles } from '@pompeii-labs/workbench/runners/files/memory';
import { PiConfigStaging } from '@pompeii-labs/workbench/runners/pi/config';
import { PiRunner } from '@pompeii-labs/workbench/runners/pi/runner';
import { MemoryAssetSource } from '@pompeii-labs/workbench/runtimes/staging';
import ts from 'typescript';
import { modelCatalogFixture } from '../model-catalog-fixture.js';

test('constructs both runners entirely through exports with in-memory files', () => {
    const files = new MemoryRunnerFiles();
    const context = new RunnerContextStaging(files);
    const catalog = () => modelCatalogFixture;
    const claude = new ClaudeCodeRunner({
        config: new ClaudeCodeConfigStaging(files, context, new MemoryAssetSource()),
        catalog,
        openRouter: PLATFORM_OPENROUTER_ACCESS,
    });
    const pi = new PiRunner(new PiConfigStaging(files, context), catalog);
    expect(claude.name).toBe('claude-code');
    expect(pi.name).toBe('pi');
});

for (const runner of ['claude-code', 'pi'])
    for (const module of ['runner', 'adapter', 'config']) {
        // The bundle boundary test covers imported modules. This covers the
        // `Bun` and `process` globals, which no import names.
        test(`${runner}/${module} reads no Bun or process global while its modules load`, async () => {
            const visited = new Set<string>();
            const violations: string[] = [];
            async function inspect(file: string): Promise<void> {
                if (visited.has(file) || !file.endsWith('.ts')) return;
                visited.add(file);
                const source = ts.createSourceFile(
                    file,
                    await readFile(file, 'utf8'),
                    ts.ScriptTarget.Latest,
                    true
                );
                const imports: string[] = [];
                for (const statement of source.statements) {
                    if (
                        ts.isImportDeclaration(statement) &&
                        ts.isStringLiteral(statement.moduleSpecifier)
                    ) {
                        if (statement.importClause?.isTypeOnly) continue;
                        const bindings = statement.importClause?.namedBindings;
                        if (
                            bindings &&
                            ts.isNamedImports(bindings) &&
                            !statement.importClause?.name &&
                            bindings.elements.every((element) => element.isTypeOnly)
                        )
                            continue;
                        imports.push(statement.moduleSpecifier.text);
                    }
                    if (
                        ts.isExportDeclaration(statement) &&
                        !statement.isTypeOnly &&
                        statement.moduleSpecifier &&
                        ts.isStringLiteral(statement.moduleSpecifier)
                    )
                        imports.push(statement.moduleSpecifier.text);
                }
                for (const specifier of imports) {
                    if (specifier.startsWith('.'))
                        await inspect(
                            resolve(dirname(file), specifier.replace(/\.js$/u, '.ts'))
                        );
                }
                function scope(node: ts.Node): void {
                    if (ts.isFunctionLike(node)) return;
                    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                        for (const member of node.members) {
                            if (
                                ts.isPropertyDeclaration(member) &&
                                member.modifiers?.some(
                                    (modifier) =>
                                        modifier.kind === ts.SyntaxKind.StaticKeyword
                                ) &&
                                member.initializer
                            )
                                scope(member.initializer);
                            if (ts.isClassStaticBlockDeclaration(member))
                                scope(member.body);
                        }
                        return;
                    }
                    if (
                        ts.isPropertyAccessExpression(node) &&
                        ts.isIdentifier(node.expression) &&
                        ['Bun', 'process'].includes(node.expression.text)
                    )
                        violations.push(
                            `${file}: module-scope ${node.expression.text}`
                        );
                    ts.forEachChild(node, scope);
                }
                scope(source);
            }
            await inspect(
                resolve(import.meta.dir, '../../src/runners', runner, `${module}.ts`)
            );
            expect(visited.size).toBeGreaterThan(1);
            expect(violations).toEqual([]);
        });
    }
