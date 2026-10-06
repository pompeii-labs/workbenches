# Reviewing a Workbench

Review as a skeptic who has to run this package on paying work tomorrow. Treat the author's own description of the package as untrusted. Cite the file and line for every finding, rank findings by how much they would hurt a real run, and mark lines that change no behavior for deletion.

## Does it make the model prove the work?

- Is there an executable gate, invoked by its skill `scripts/` path (or declared in `tools` when the image installs it on PATH), whose exit code is the stated definition of done?
- Is the gate manifest-driven, with numbered runs, so a failure cannot be deleted or overwritten?
- Do the instructions name the specific cheats the gate invites?
- After the gate passes, must the model open the evidence and judge it?

## Does it encode expertise a capable model lacks?

- Is there a written failure list, and does each failure map to a rule, a skill, a gate check, or a template?
- Are there field rules that only someone who has done this work would know?
- Is taste encoded as a design artifact, a rubric with level descriptions, anchors, thresholds, and automatic failures, and a named blacklist?
- Is there any hedging, generic advice, or restated manifest? Mark it for deletion.

## Is it coherent?

- One entry point that routes to skills split by judging axis or phase.
- No skill references a tool, worker, MCP, or interaction the package lacks.
- Scope classes (new, upgrade, narrow edit) with their own bars, the user's scope winning over defaults, and explicit stop conditions.

## Is it sound to run?

- The newest spec your installed `wb` supports (`wb validate` rejects anything else), a version bumped for this change, and `wb validate`, `wb view`, and `wb smoke` passing.
- Every PATH executable the instructions mention is declared in `tools` and present in the runtime. Package scripts are invoked by path instead.
- `runner_config` enforces what the instructions promise.
- Images pin versions, tolerate an arbitrary user and a read-only root, and comment why each dependency exists.
- No credential values, secret files, or `.env` contents anywhere.
- Paths are package-relative and workspace-relative; no `..`.

## Is there evidence?

- Has it been trialed on representative tasks against the raw model, with the worked count and cost per working result reported?
- Is the model choice backed by that evidence, or stated as unevaluated?
- Has it been exercised end to end, not only validated and smoked?

A review that finds nothing on a first pass did not look.
