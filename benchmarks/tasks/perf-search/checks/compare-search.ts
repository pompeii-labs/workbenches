// Compares a baseline /search response against a submission /search response
// for the content gate. Both are the DEFAULT response: /search?q=<term> with
// no limit, page, or cursor params.
//
// Contract:
//   - Both responses must be JSON objects with a `results` array.
//   - Let B = baseline results (every match, fully sorted), S = submission
//     results. S may be shorter than B (the submission may paginate), but
//     never longer, and must hold at least min(20, B.length) items, so an
//     empty or tiny page cannot pass by vacuous comparison.
//   - For i in 0..S.length-1, S[i] must equal B[i] on `id`, `name` and
//     `priceCents` (what a product listing needs). `description`, `category`
//     and `timesOrdered` must also match wherever the submission still
//     returns them. The submission may drop those three, and may add fields
//     to items or to the envelope (total, page, nextCursor, and so on).
import { readFileSync } from 'node:fs';

const [, , baselinePath, submissionPath] = process.argv;
if (!baselinePath || !submissionPath) {
    console.error('usage: bun run compare-search.ts <baseline.json> <submission.json>');
    process.exit(2);
}

function load(path: string, label: string): any[] {
    let parsed: any;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        console.log(`  FAIL: ${label} response is missing or not JSON`);
        process.exit(1);
    }
    if (!parsed || !Array.isArray(parsed.results)) {
        console.log(`  FAIL: ${label} response has no results array`);
        process.exit(1);
    }
    return parsed.results;
}

const bResults = load(baselinePath, 'baseline');
const sResults = load(submissionPath, 'submission');

let fail = false;
const minDefault = Math.min(20, bResults.length);
console.log(`  baseline matches: ${bResults.length}, submission default page: ${sResults.length} (need ${minDefault}..${bResults.length})`);
if (sResults.length < minDefault) {
    console.log(`  FAIL: submission returned ${sResults.length} results by default, need at least ${minDefault}`);
    fail = true;
}
if (sResults.length > bResults.length) {
    console.log(`  FAIL: submission returned ${sResults.length} results, more than the ${bResults.length} that match`);
    fail = true;
}

const REQUIRED_FIELDS = ['id', 'name', 'priceCents'];
const OPTIONAL_FIELDS = ['description', 'category', 'timesOrdered'];

const prefixLen = Math.min(bResults.length, sResults.length);
let reported = 0;
for (let i = 0; i < prefixLen; i++) {
    const b = bResults[i];
    const s = sResults[i] ?? {};
    const fields = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS.filter((f) => f in s)];
    for (const field of fields) {
        if (b[field] !== s[field]) {
            fail = true;
            if (reported++ < 5) {
                console.log(
                    `  FAIL: item ${i} field '${field}': baseline=${JSON.stringify(b[field])} submission=${JSON.stringify(s[field])}`
                );
            }
        }
    }
}

if (fail) process.exit(1);
console.log(`  ok: first ${prefixLen} result(s) match baseline in order`);
