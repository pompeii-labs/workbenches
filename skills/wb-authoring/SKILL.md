---
name: wb-authoring
description: Author, improve, and review Workbench packages that make an AI do expert work in a domain. Use when creating or editing anything under `.workbenches/`, writing a Workbench's instructions, skills, gate scripts, or rubrics, choosing its runner, model, provider routes, runtimes, requirements, or Dockerfile, setting runner permissions, validating or smoking a package, trialing it against real tasks, or reviewing whether a Workbench is actually good.
license: Apache-2.0
---

# Workbench authoring

A Workbench is an expert package, not a prompt. The great ones share one property: the package decides what "done" means and makes the model prove it. Prose that only describes good work is the weakest part of any package. Build the parts that check the work first, then write the prose around them.

Write the newest spec your installed `wb` supports: `wb init` scaffolds it and `wb validate` rejects anything else. As of `wb` 1.0 that is spec 1. Reference material, loaded when needed:

- [references/manifest.md](references/manifest.md): manifest fields, skills layout, and what each `wb` command proves.
- [references/runtimes.md](references/runtimes.md): `local`, `docker`, `e2b`, `daytona`, `requirements`, and exactly what a runtime image must contain.
- [references/models.md](references/models.md): choosing the model and provider routes so consumers are not stuck without one particular key.
- [references/permissions.md](references/permissions.md): runner permission config that keeps headless runs from stalling.
- [references/spec.md](references/spec.md) and [references/workbench.schema.json](references/workbench.schema.json): the spec 1 text bundled with this skill. If `wb --version` is newer than 1.x, prefer `wb init`'s output and the repository's current SPEC.md.

If `wb` is not installed, use the wb-cli skill first.

## The method

Work through these in order. Each step produces something a later step depends on. If your environment can spawn subagents, hand step 1 to a scout, the build to a drafter, the review in step 8 to an independent critic, and step 9 to a trialist, using the briefs in [references/subagents/](references/subagents/) (`scout.md`, `drafter.md`, `critic.md`, `trialist.md`). Otherwise do those passes yourself, and treat your own draft as untrusted while you do.

### 1. Find the failure

Before designing anything, establish what a capable model gets wrong in this domain without the package. Read the repository's code, tests, docs, and agent guidance. If you can run the model on a representative task without any package, do it and read the transcript. Write the failure list down in concrete terms: "fakes first-run data", "never adds delete", "loses data on relaunch", "ships a static mockup", "stops after scaffolding", "judges the result without looking at it". The whole package exists to remove these failures. A package built without this list optimizes for the wrong thing.

### 2. Choose the boundary and the judging axes

Pick one coherent class of work where the same instructions, skills, tools, model, and runtime apply. Name it for the expertise (`ios`, `migrations`, `threejs-game`), never a generic role (`coder`, `reviewer`).

Then name the three to five axes the result is judged on, in words a skeptical expert would use. For an app: it looks designed, it feels alive, it works under real conditions. These axes organize the skills, the rubric, and the report.

### 3. Build the gate before the prose

Write the script that decides whether the work is done. Ship it in a skill's `scripts/` directory and invoke it by its path under the runner's config directory (a package script is not on PATH; the exact variable is in [references/gates.md](references/gates.md)), or install it on PATH in the image and declare it in `tools`. It builds the result, runs it, captures evidence (test results, screenshots, metrics, logs), checks that evidence against what the work planned, writes a JSON summary, and exits non-zero on any failure. Exit 0 becomes the only definition of done in the instructions.

The gate must not be fakeable. Drive it from a manifest the work declares up front, so a failing item cannot quietly disappear. Number its runs so history cannot be edited. Then name the cheats explicitly in the instructions: "never drop a failing capture", "do not delete a planned state to pass the gate", "test hooks implement real states, never fake an acknowledgment".

Machine checks are the floor, not the verdict. Pair the gate with a required look: open the screenshots or outputs it wrote and judge them against the rubric. "A pass with an ugly or wrong result is a defect." Patterns and a skeleton are in [references/gates.md](references/gates.md).

### 4. Write the instructions

Use this structure. Full guidance and examples are in [references/instructions.md](references/instructions.md).

1. **Role and environment**: one paragraph. What the work is, how it is judged, and the facts of the runtime ("no display and no GPU").
2. **Tools**: every packaged command with its exact behavior and exit codes.
3. **Method**: the order of work, and which skill to load first.
4. **Precedence**: what wins when guidance conflicts. The user's stated scope beats every skill default.
5. **Invariants**: the rules that hold on every run.
6. **Field rules**: terse, specific failure knowledge, grouped by area.
7. **Done means**: a checklist a reviewer could tick from evidence.
8. **Report**: what was built, what the gate reported, what the evidence shows, and what could not be verified, failures first.

Every line must change behavior or name a failure that has happened. Write as the expert: commit to one way of working and state it plainly. Cut "consider", "if appropriate", "best practices", and anything a capable model already does.

### 5. Split skills by judging axis or phase

Give the work one entry point: a workflow skill, or a short method section in the instructions, that routes to the rest. Then one skill per judging axis or phase (`look`, `feel`, `work`, `proof`), each loaded when its `description` says it applies. Two competing entry skills is a defect.

Each skill holds the decisions to make before building, the standard to meet, the failures to avoid, and its templates and scripts. Ship templates for anything the model would otherwise hand-write badly: project scaffolds, test harnesses, config. Adapt borrowed skills to this runtime instead of vendoring them verbatim; a skill that mentions tools or delegation the package does not have teaches the model to fail. Record the provenance of borrowed material in the package's NOTICE.

### 6. Encode taste as rubrics and blacklists

Adjectives do not move a model. Replace "make it beautiful" with:

- **A design artifact written before code**, with required decisions (concept, palette, type, signature element, states), checked by the gate.
- **A rubric** with a scale, a concrete description of each level per category, calibration anchors (reference images or examples), numeric thresholds, and an "automatic failures" list.
- **A blacklist of the model's default taste**, named exactly. Generated work converges on recognizable templates. Say which ones, so the model can see itself doing it.

Anatomy and an example are in [references/rubrics.md](references/rubrics.md).

### 7. Scope, stop, and spend

Classify the task (new work, upgrade, narrow edit) and give each class its own bar. Existing code sets the conventions; house defaults apply to new work only. Give explicit stop conditions: a pass budget ("two proof passes"), and "do not polish past what the task asked for". Tell the model to work lean, read a file once, and prefer contact sheets or summaries over opening every artifact. The person pays for every step.

### 8. Fit the runtime, then verify mechanically

Declare every runtime the work can honestly run in, default first, with `requirements` for what it truly needs (OS, CPU, memory, GPU). Write the Dockerfile for `docker`, `e2b`, and `daytona` to the image contract in [references/runtimes.md](references/runtimes.md): the runner and every declared tool inside, any numeric user, a read-only root, writable state only under the temporary home, versions pinned, and a comment on why each dependency exists. Daytona needs a published image.

Choose the model and routes per [references/models.md](references/models.md). Leave `routes` out unless a provider genuinely must be excluded, so consumers can use whichever provider key they hold.

State the runtime's constraints in the instructions and enforce what you can in `runner_config` per [references/permissions.md](references/permissions.md): allow exactly the paths, tools, and skills the work needs so headless runs never stall on a prompt, deny destructive commands and secret files, and deny sub-agent delegation when the work must stay in one context. Never run a server in the foreground; ship a backgrounding tool. Use workspace-relative paths.

A package must live at `.workbenches/<name>/` in a repository; the engine refuses one anywhere else ("Workbench must live beneath a .workbenches directory"), including for `validate` and `smoke`. Scaffold with `wb init <name>` from the repository root. Then run `wb validate .#<name>`, `wb view .#<name>`, and `wb smoke .#<name>` (or pass the path `.workbenches/<name>`) for each declared runtime, and read [references/manifest.md](references/manifest.md) for what each proves. A clean smoke proves the tools exist. It proves nothing about quality. Smoke on `e2b` and `daytona` creates a billable sandbox; say so before running it. Finally run one tiny real task without approving any permission prompt: a stall means the permission config is incomplete.

Review the package against [references/review.md](references/review.md) before calling it a draft. A review that finds nothing on a first pass did not look.

### 9. Trial it against the raw model

Register the package once with `wb add ./.workbenches/<name> --as <alias>`. A local registration is live: every new run reads the current files, so edit and rerun without re-adding (no `-f`). Run the same representative tasks with the package and without it, on the same model, several attempts each. Grade blind against hard pass or fail checks, ideally with a separate grader. Report how many worked and the cost per working result, not cost per run. Read the transcripts of every failure, trace each to a reusable cause in the package, fix the contract, increment the version, and rerun. Never encode a benchmark task, one user's wording, or a known answer into the package. Trials spend money: get the owner's approval and a budget first. Method and accounting are in [references/trials.md](references/trials.md).

## Anti-patterns

- A package that validates and smokes cleanly and contains only generic prose.
- Benchmark-shaped rules: "ship the smallest thing", "skip the check if it errors". The gate is mandatory.
- Rules written around one known test instead of the class of work.
- Vendored skills that reference absent tools, workers, or user questions.
- Two entry points that compete, patched over with precedence rules.
- A model choice presented as best without trial evidence for this work.
- Credential values, `.env` contents, or secret files anywhere in the package.
- Em dashes in any user-facing text.

## Report

When you finish, state the boundary you chose and why, the failure list it targets, what the gate checks, the results of `validate`, `view`, and `smoke`, which trials ran and their worked count and cost per working result, and what remains unverified. Failures first.
