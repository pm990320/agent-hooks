# Sharding

`--shard <index>/<total>` runs one share of a pipeline, so a long
`agent-hooks ci` can be split across N parallel CI jobs (a GitHub
Actions matrix) without hand-cutting it into sub-pipelines. For a given
`<total>`, every check runs in exactly one shard; none is lost and none
runs twice.

```bash
agent-hooks ci --shard 2/3          # or: AGENT_HOOKS_SHARD=2/3 agent-hooks ci
agent-hooks ci --shard-plan 3       # print all 3 shards, run nothing
```

`--shard` works on `ci`, `run <pipeline-or-step>` and the shortcuts
(`lint`, `test`, …). The env var `AGENT_HOOKS_SHARD` is the same thing
for matrices; the flag wins when both are set, and an empty value means
"not sharded". `index` is 1-based (`1/3`, `2/3`, `3/3`), like vitest's
and playwright's `--shard`.

## What gets split

The planner first applies the same filters a normal run does: pipeline
`include-tags`/`exclude-tags`, `--skip`/`--only`, `AGENT_HOOKS_SKIP`,
`AGENT_HOOKS_ONLY` and commit-message skip tags. What survives becomes
*units*, according to each step's `shard` mode:

| `shard:` | Default for | Behaviour |
|---|---|---|
| `whole` | `args`, `xargs`, `stdin`, `glob`, `project` | The step is one unit and runs in exactly one shard. |
| `targets` | `per-file`, `per-directory`, `per-marker-dir` | Each file (per-file) or directory (per-directory, per-marker-dir) is a unit. A shard runs only its own targets. When the step would make a single invocation anyway (no matching files and it runs its project variant or `fallback`, an area map sent it to project mode, no marker dirs found), it is one whole unit instead. |
| `native` | — | Not a unit: the step runs in **every** shard and the tool splits its own work, reading the shard from `{shard}` or the env vars below. |

```yaml
steps:
  unit:
    run: bunx vitest run --shard={shard}
    invocation: project
    shard: native
    weight: 180

  e2e:
    run: bunx playwright test --shard={shard}
    invocation: project
    shard: native
    weight: 340

  shellcheck:
    run: shellcheck {file}
    files: "**/*.sh"
    invocation: per-file   # shard: targets by default
```

### Passing the shard to a tool

Every step command sees the shard, sharded or not (unsharded is `1/1`,
which vitest, playwright and most splitters accept as "everything"):

| Template | Env var | Example value |
|---|---|---|
| `{shard}` | — | `2/3` |
| `{shard_index}` | `AGENT_HOOKS_SHARD_INDEX` | `2` |
| `{shard_total}` | `AGENT_HOOKS_SHARD_TOTAL` | `3` |

Recipes:

- vitest: `vitest run --shard={shard}`
- playwright: `playwright test --shard={shard}`
- bun test (no native flag): shard the files with `invocation: per-file`
  and `shard: targets`, or select files yourself from
  `$AGENT_HOOKS_SHARD_INDEX`/`$AGENT_HOOKS_SHARD_TOTAL`.
- pytest-split: `pytest --splits {shard_total} --group {shard_index}`
- a nested agent-hooks run: `agent-hooks run other --shard {shard}`.
  The CLI's own `AGENT_HOOKS_SHARD` input is removed from step env, so
  a nested `agent-hooks` call is never sharded by accident.

**Coverage thresholds.** A native split runs only part of the suite in
each shard, so a per-run coverage gate (vitest `thresholds`, bun
`coverageThreshold`) sees partial coverage and fails. Keep a suite with
a coverage gate as `whole` (it then runs in one shard and its gate
holds), or merge the shards' coverage reports in a follow-up job and
gate there.

## Balance: `weight`

Each step may set `weight:` (default `1`), a relative cost; the step's
typical duration in seconds is a good value. Assignment is
longest-processing-time greedy: heaviest unit first, onto the
least-loaded shard. A `targets` step's weight is the cost of the whole
step, shared evenly among its targets. A `native` step adds
`weight / total` to every shard's load.

The assignment depends only on the unit list, the weights and
`<total>`: ties are broken by unit name (byte order, not locale) and
then by the lowest shard index. Every shard computes the same plan
independently, with no coordination.

Weights are hints, not timings agent-hooks measures. They are plain
config, so the plan is reproducible and reviewable; refresh them when a
step's duration changes a lot.

## Seeing the plan

`--shard-plan <total>` (or `--shard-plan` together with `--shard i/n`)
prints every shard's units and exits 0 without running anything. For a
`ci` of `lint` (weight 1), `typecheck` (50), `test` (180), `build` (5),
`e2e` (340) and `knip` (3):

```
shard plan for ci: 3 shard(s), 6 unit(s), 0 native step(s) (plan 66c778f3)
shard 1/3 (load 340):
  e2e
shard 2/3 (load 180):
  test
shard 3/3 (load 59):
  lint
  typecheck
  build
  knip
```

Run it with the same scope flags CI uses (`--all`, `--changed`, …) to
check that nothing is dropped. A sharded run prints a banner naming what
runs here and where everything else went:

```
  ⧉ shard 3/3 of ci (plan 66c778f3)
    runs here: lint, typecheck, build, knip
    on other shards: test → 2, e2e → 1
```

Steps that run on another shard appear in the summary as
`⧉ e2e — elsewhere (on shard 1/3)`. The 8-character plan id is a hash
of the whole assignment: every shard of one run must print the same id.
If they differ, the shards saw different inputs (see below).

## Interaction with other features

- **Scopes (`--changed`, `--files`, `--staged`, `--all`).** Planning
  uses the resolved file list, so every shard must resolve the same
  files: same commit, same flags, and for `--changed` the same history
  (`fetch-depth: 0` in every matrix job). Different files mean a
  different plan, which the plan id makes visible.
- **Tag filters, `--skip`, `--only`, skip directives.** Applied before
  planning, so a skipped step is not a unit and every shard agrees.
- **`when-changed` gates and `--force-gates`.** Not consulted by the
  planner; the shard that owns a step evaluates its gate as usual (a
  split step's gate is evaluated in each shard that has its targets).
  `--force-gates` behaves the same as unsharded.
- **Preflight (`requires`).** Checked in the shard that runs the step,
  so that runner needs the tools. Install the same toolchain in every
  matrix job unless you pin steps to shards yourself.
- **`parallel: true` and `--jobs`.** Apply within a shard to the steps
  assigned to it.
- **Fail-fast.** A sequential pipeline still stops at its first failure
  within a shard; other shards are separate processes and carry on. Use
  matrix `fail-fast: false` if you want every shard's verdict on a
  failing commit.
- **Monorepos.** `ci` from the root plans root and workspace steps
  together; units are named `<workspace>:<step>` (`.:<step>` for the
  root). With `--workspace`, only that workspace is planned.
- **Exit codes.** A shard with nothing assigned exits 0. A malformed
  `--shard` or `AGENT_HOOKS_SHARD` exits 2.

## GitHub Actions matrix

```yaml
jobs:
  ci:
    name: ci (${{ matrix.shard }}/3)
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      # ... install toolchains ...
      - uses: pm990320/agent-hooks@v0
      - run: agent-hooks ci
        env:
          AGENT_HOOKS_SHARD: ${{ matrix.shard }}/3

  # One stable check name for branch protection.
  ci-ok:
    if: always()
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - run: test "${{ needs.ci.result }}" = success
```

Branch protection that requires a check named `ci` will not see the
matrix jobs (`ci (1/3)`, …); require an aggregate job like `ci-ok`
instead.
