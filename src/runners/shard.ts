import { createHash } from "node:crypto";
import type { Step } from "../config/schema.ts";

/**
 * Sharding: split one pipeline run across N machines (e.g. a GitHub
 * Actions matrix) so every unit of work runs in exactly one shard.
 *
 * A *unit* is either a whole step, or one invocation target (a file or
 * directory) of a `per-file` / `per-directory` / `per-marker-dir` step.
 * Steps with `shard: native` are not units: they run in every shard and
 * receive the shard through `{shard}` / `AGENT_HOOKS_SHARD` so the tool
 * (vitest, playwright, …) splits its own work.
 *
 * Assignment is a pure function of the unit list, each unit's weight,
 * and N: longest-processing-time greedy (heaviest unit first onto the
 * least-loaded shard), with ties broken by unit key and then by the
 * lowest shard index. Keys are compared by code unit, never by locale,
 * so the plan is identical on every machine that sees the same config,
 * file selection, and filters.
 */

// --- Shard spec ----------------------------------------------------------

export interface ShardSpec {
  /** 1-based shard index. */
  readonly index: number;
  readonly total: number;
}

/** The unsharded run: one shard holding everything. */
export const NO_SHARD: ShardSpec = { index: 1, total: 1 };

export class ShardSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShardSpecError";
  }
}

/**
 * Parse `i/n` (1-based, as vitest and playwright take it). Throws
 * ShardSpecError with a message suitable for the CLI on bad input.
 */
export function parseShardSpec(raw: string, source = "--shard"): ShardSpec {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  if (!match) {
    throw new ShardSpecError(
      `${source} must look like <index>/<total> (e.g. 2/4), got "${raw}"`,
    );
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1) {
    throw new ShardSpecError(`${source}: total must be at least 1, got "${raw}"`);
  }
  if (index < 1 || index > total) {
    throw new ShardSpecError(
      `${source}: index must be between 1 and ${String(total)}, got "${raw}"`,
    );
  }
  return { index, total };
}

/** Parse a bare shard count (for `--shard-plan <n>`). */
export function parseShardTotal(raw: string, source = "--shard-plan"): number {
  if (!/^\s*\d+\s*$/.test(raw) || Number(raw) < 1) {
    throw new ShardSpecError(
      `${source} must be a positive whole number of shards, got "${raw}"`,
    );
  }
  return Number(raw);
}

export function formatShard(spec: ShardSpec): string {
  return `${String(spec.index)}/${String(spec.total)}`;
}

/** The env var a CI matrix sets instead of passing `--shard`. */
export const SHARD_ENV_VAR = "AGENT_HOOKS_SHARD";

/** Env vars every step command sees, sharded or not. */
export function shardEnv(spec: ShardSpec): Record<string, string> {
  return {
    AGENT_HOOKS_SHARD_INDEX: String(spec.index),
    AGENT_HOOKS_SHARD_TOTAL: String(spec.total),
  };
}

/**
 * Drop the CLI's own `AGENT_HOOKS_SHARD` input from a step's inherited
 * env. Otherwise a step that runs `agent-hooks run <other>` would shard
 * that nested run again and silently drop most of its work. A step that
 * wants a nested sharded run passes `--shard {shard}` explicitly.
 */
export function withoutShardInput(
  env: Record<string, string>,
): Record<string, string> {
  if (!(SHARD_ENV_VAR in env)) return env;
  const copy = { ...env };
  delete copy[SHARD_ENV_VAR];
  return copy;
}

// --- Step policy ---------------------------------------------------------

export type ShardMode = "whole" | "targets" | "native";

/**
 * A step's effective sharding mode. Fan-out invocation modes split their
 * targets by default; everything else runs whole in one shard.
 */
export function stepShardMode(step: Step): ShardMode {
  if (step.shard) return step.shard;
  if (
    step.invocation === "per-file" ||
    step.invocation === "per-directory" ||
    step.invocation === "per-marker-dir"
  ) {
    return "targets";
  }
  return "whole";
}

export function stepWeight(step: Step): number {
  return step.weight ?? 1;
}

// --- Units and planning --------------------------------------------------

/**
 * One step of one pipeline context, as the planner sees it. `group`
 * distinguishes contexts in a monorepo run (the workspace path, or "."
 * for the root); it is "" for a single-config repo.
 */
export interface PlannedStep {
  readonly group: string;
  readonly step: string;
  readonly mode: ShardMode;
  readonly weight: number;
  /**
   * Target keys for a `targets` step. `null` when the step resolved to a
   * single invocation (project variant, fallback, no files), in which
   * case it is planned as a whole step.
   */
  readonly targets: readonly string[] | null;
}

export interface ShardUnit {
  readonly key: string;
  readonly group: string;
  readonly step: string;
  readonly target?: string;
  readonly weight: number;
}

export interface ShardPlan {
  readonly total: number;
  /** Units in plan order (by group, then step order, then target). */
  readonly units: readonly ShardUnit[];
  /** Unit key → 1-based shard index. */
  readonly assignment: ReadonlyMap<string, number>;
  /** Steps that run in every shard (`shard: native`). */
  readonly native: readonly PlannedStep[];
  /** Estimated load per shard (index 0 = shard 1). */
  readonly loads: readonly number[];
  /** Short hash of the assignment, printed by every shard. */
  readonly fingerprint: string;
}

export function unitKey(group: string, step: string, target?: string): string {
  const base = group.length > 0 ? `${group}:${step}` : step;
  return target === undefined ? base : `${base}[${target}]`;
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function buildShardPlan(
  steps: readonly PlannedStep[],
  total: number,
): ShardPlan {
  const units: ShardUnit[] = [];
  const native: PlannedStep[] = [];
  for (const planned of steps) {
    if (planned.mode === "native") {
      native.push(planned);
      continue;
    }
    if (
      planned.mode === "targets" &&
      planned.targets !== null &&
      planned.targets.length > 0
    ) {
      // The step's weight is its total cost; each target carries a share.
      const share = planned.weight / planned.targets.length;
      for (const target of planned.targets) {
        units.push({
          key: unitKey(planned.group, planned.step, target),
          group: planned.group,
          step: planned.step,
          target,
          weight: share,
        });
      }
      continue;
    }
    units.push({
      key: unitKey(planned.group, planned.step),
      group: planned.group,
      step: planned.step,
      weight: planned.weight,
    });
  }

  // Native steps cost every shard an equal slice of their weight.
  const nativeLoad = native.reduce(
    (sum, planned) => sum + planned.weight / total,
    0,
  );
  const loads = Array.from({ length: total }, () => nativeLoad);
  const order = [...units].sort(
    (left, right) =>
      right.weight - left.weight || compareKeys(left.key, right.key),
  );
  const assignment = new Map<string, number>();
  for (const unit of order) {
    let best = 0;
    for (let index = 1; index < total; index += 1) {
      if ((loads[index] ?? 0) < (loads[best] ?? 0)) best = index;
    }
    loads[best] = (loads[best] ?? 0) + unit.weight;
    assignment.set(unit.key, best + 1);
  }

  const hash = createHash("sha256");
  hash.update(`total=${String(total)}\n`);
  for (const unit of [...units].sort((left, right) => compareKeys(left.key, right.key))) {
    hash.update(`${unit.key}=${String(assignment.get(unit.key))}\n`);
  }
  for (const planned of native) {
    hash.update(`${unitKey(planned.group, planned.step)}=*\n`);
  }

  return {
    total,
    units,
    assignment,
    native,
    loads,
    fingerprint: hash.digest("hex").slice(0, 8),
  };
}

// --- Per-context view ----------------------------------------------------

/**
 * What one shard does with one step of one context:
 *
 * - `run`: the whole step runs here (whole step assigned here, or native).
 * - `targets`: only `targets` of a split step run here.
 * - `elsewhere`: nothing runs here; `shards` lists where it runs.
 */
export type StepShardDecision =
  | { readonly kind: "run"; readonly native: boolean }
  | { readonly kind: "targets"; readonly targets: ReadonlySet<string>; readonly of: number }
  | { readonly kind: "elsewhere"; readonly shards: readonly number[]; readonly of: number };

export interface ShardAssignment {
  readonly spec: ShardSpec;
  readonly fingerprint: string;
  readonly steps: ReadonlyMap<string, StepShardDecision>;
}

export function assignmentFor(
  plan: ShardPlan,
  group: string,
  spec: ShardSpec,
): ShardAssignment {
  const perStep = new Map<string, ShardUnit[]>();
  for (const unit of plan.units) {
    if (unit.group !== group) continue;
    const list = perStep.get(unit.step);
    if (list) list.push(unit);
    else perStep.set(unit.step, [unit]);
  }

  const steps = new Map<string, StepShardDecision>();
  for (const planned of plan.native) {
    if (planned.group === group) {
      steps.set(planned.step, { kind: "run", native: true });
    }
  }
  for (const [step, units] of perStep) {
    const here = units.filter(
      (unit) => plan.assignment.get(unit.key) === spec.index,
    );
    const isSplit = units.some((unit) => unit.target !== undefined);
    if (here.length === 0) {
      const shards = [
        ...new Set(units.map((unit) => plan.assignment.get(unit.key) ?? 0)),
      ].sort((left, right) => left - right);
      steps.set(step, { kind: "elsewhere", shards, of: units.length });
      continue;
    }
    if (!isSplit) {
      steps.set(step, { kind: "run", native: false });
      continue;
    }
    steps.set(step, {
      kind: "targets",
      targets: new Set(here.map((unit) => unit.target ?? "")),
      of: units.length,
    });
  }
  return { spec, fingerprint: plan.fingerprint, steps };
}

// --- Rendering -----------------------------------------------------------

function formatLoad(load: number): string {
  return Number.isInteger(load) ? String(load) : load.toFixed(1);
}

function groupLabel(group: string): string {
  return group.length > 0 ? `${group}:` : "";
}

/**
 * Human-readable plan for every shard. Lists each unit under the shard
 * it runs in, so a reader can check that nothing is missing or doubled.
 */
export function renderShardPlan(plan: ShardPlan, pipeline: string): string {
  const lines: string[] = [];
  lines.push(
    `shard plan for ${pipeline}: ${String(plan.total)} shard(s), ${String(plan.units.length)} unit(s), ${String(plan.native.length)} native step(s) (plan ${plan.fingerprint})`,
  );
  for (let index = 1; index <= plan.total; index += 1) {
    const here = plan.units.filter(
      (unit) => plan.assignment.get(unit.key) === index,
    );
    lines.push(
      `shard ${String(index)}/${String(plan.total)} (load ${formatLoad(plan.loads[index - 1] ?? 0)}):`,
    );
    for (const planned of plan.native) {
      lines.push(
        `  ${groupLabel(planned.group)}${planned.step} (native: --shard=${String(index)}/${String(plan.total)})`,
      );
    }
    for (const unit of here) {
      lines.push(
        unit.target === undefined
          ? `  ${groupLabel(unit.group)}${unit.step}`
          : `  ${groupLabel(unit.group)}${unit.step} [${unit.target}]`,
      );
    }
    if (here.length === 0 && plan.native.length === 0) {
      lines.push("  (nothing)");
    }
  }
  return `${lines.join("\n")}\n`;
}

function describeDecision(step: string, decision: StepShardDecision): string {
  if (decision.kind === "targets") {
    return `${step} (${String(decision.targets.size)}/${String(decision.of)} targets)`;
  }
  if (decision.kind === "run" && decision.native) return `${step} (native)`;
  return step;
}

/**
 * One-line banner a shard prints before it runs: what runs here and
 * where everything else went.
 */
export function renderShardBanner(
  assignment: ShardAssignment,
  pipeline: string,
  stepOrder: readonly string[],
  group: string,
): string {
  const here: string[] = [];
  const elsewhere: string[] = [];
  for (const step of stepOrder) {
    const decision = assignment.steps.get(step);
    if (!decision) continue;
    if (decision.kind === "elsewhere") {
      elsewhere.push(`${step} → ${decision.shards.join(",")}`);
    } else {
      here.push(describeDecision(step, decision));
    }
  }
  const where = group.length > 0 ? ` [${group}]` : "";
  const runs = here.length > 0 ? here.join(", ") : "(nothing)";
  const other = elsewhere.length > 0 ? elsewhere.join(", ") : "(none)";
  return (
    `  ⧉ shard ${formatShard(assignment.spec)} of ${pipeline}${where} (plan ${assignment.fingerprint})\n` +
    `    runs here: ${runs}\n` +
    `    on other shards: ${other}\n`
  );
}
