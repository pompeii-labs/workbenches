import { dirname, posix } from 'node:path';
import ts from 'typescript';

export type ImportGraph = Map<string, string[]>;

export function valueImports(sources: Map<string, string>): ImportGraph {
    const graph: ImportGraph = new Map();
    for (const [file, source] of sources) {
        const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const edges: string[] = [];
        for (const statement of syntax.statements) {
            if (
                !(
                    ts.isImportDeclaration(statement) ||
                    ts.isExportDeclaration(statement)
                ) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                isTypeOnly(statement)
            )
                continue;
            const specifier = statement.moduleSpecifier.text;
            if (!specifier.startsWith('.')) continue;
            const base = posix.normalize(posix.join(dirname(file), specifier));
            const target = [
                base.replace(/\.js$/, '.ts'),
                base.replace(/\.js$/, '.tsx'),
                base,
            ].find((candidate) => sources.has(candidate));
            if (target) edges.push(target);
        }
        graph.set(file, edges);
    }
    return graph;
}

/** Package and built-in specifiers each file imports at run time. */
export function externalValueImports(sources: Map<string, string>): ImportGraph {
    const graph: ImportGraph = new Map();
    for (const [file, source] of sources) {
        const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        const specifiers: string[] = [];
        for (const statement of syntax.statements) {
            if (
                !(
                    ts.isImportDeclaration(statement) ||
                    ts.isExportDeclaration(statement)
                ) ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier) ||
                isTypeOnly(statement) ||
                statement.moduleSpecifier.text.startsWith('.')
            )
                continue;
            specifiers.push(statement.moduleSpecifier.text);
        }
        graph.set(file, specifiers);
    }
    return graph;
}

/** Every file reachable from `roots` through run-time relative imports. */
export function reachable(graph: ImportGraph, roots: string[]): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    const queue = roots.map((root) => [root] as string[]);
    while (queue.length) {
        const path = queue.shift() as string[];
        const file = path.at(-1) as string;
        if (paths.has(file)) continue;
        paths.set(file, path);
        for (const target of graph.get(file) ?? []) queue.push([...path, target]);
    }
    return paths;
}

export function importCycles(graph: ImportGraph): string[][] {
    let next = 0;
    const nodes = new Map<string, { index: number; low: number }>();
    const stack: string[] = [];
    const active = new Set<string>();
    const cycles: string[][] = [];
    function visit(file: string): { index: number; low: number } {
        const node = { index: next, low: next++ };
        nodes.set(file, node);
        stack.push(file);
        active.add(file);
        for (const target of graph.get(file) ?? []) {
            const visited = nodes.get(target);
            if (!visited) {
                node.low = Math.min(node.low, visit(target).low);
            } else if (active.has(target)) {
                node.low = Math.min(node.low, visited.index);
            }
        }
        if (node.low !== node.index) return node;
        const group: string[] = [];
        while (stack.length) {
            const target = stack.pop();
            if (target === undefined) break;
            active.delete(target);
            group.push(target);
            if (target === file) break;
        }
        if (group.length > 1 || graph.get(file)?.includes(file))
            cycles.push(group.sort());
        return node;
    }
    for (const file of graph.keys()) if (!nodes.has(file)) visit(file);
    return cycles.sort((left, right) => (left[0] ?? '').localeCompare(right[0] ?? ''));
}

function isTypeOnly(statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
    if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) return true;
        return (
            !!clause?.namedBindings &&
            !clause.name &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)
        );
    }
    if (statement.isTypeOnly) return true;
    return (
        !!statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((element) => element.isTypeOnly)
    );
}
