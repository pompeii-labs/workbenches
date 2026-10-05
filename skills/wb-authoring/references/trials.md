# Trials

Validation and smoke say a package runs. Only trials say it is worth running.

## Before spending anything

Trials make model and sandbox requests that cost money. State the plan (tasks, arms, attempts, model, runtime) and an estimated cost, and get the owner's approval and a budget first. Cap every attempt's spend or duration.

## Design

- **Tasks**: three to eight representative tasks from the class of work, written the way a real user would ask. Include at least one new build and one narrow edit if the package claims both.
- **Arms**: the package, and the same model with no package. Same runner, same runtime, same task text.
- **Attempts**: at least three per task per arm. Single runs mislead.
- **Grading**: blind to the arm. Prefer a separate grader (a second Workbench or a script) with hard pass or fail checks derived from the failure list: launches, first run is honest, data persists, delete exists, the gate's own checks. Add rubric scores for taste where it matters.

## Accounting

- **Worked**: an attempt passes every hard check.
- **Cost per working result**: total spend of the arm divided by worked attempts. A package that costs five times more per run but works five times as often costs the same per working result and is strictly better.
- Take each run's spend from `usage_total.cost_usd` in its terminal `wait --json` result. Do not sum the per-wait `usage` deltas across runs or waits.
- Separate infrastructure failures (network, quota, runner faults) from work failures. Fix or rerun them; do not count them against the package.

## Iterating

For every failed attempt, read the transcript until you can name the cause, then classify it:

- a missing or wrong rule in the instructions,
- a procedure or reference that belongs in a skill,
- a gate gap that let bad work pass or good work fail,
- a missing template the model rebuilt badly,
- an undeclared tool, binding, or runtime requirement,
- a model that cannot do the work, which is the only finding that justifies changing the model.

Make the smallest general fix that would prevent the class of failure, never one that encodes the task, its wording, or its answer. Increment the version, validate, smoke, and rerun the affected tasks. Keep a short ledger of version, change, and result so each rule in the package traces to evidence.

## Report

Per arm: attempts, worked, total spend, cost per working result, and the top failure causes. Then the changes made and what still fails.
