import { describe, expect, test } from "bun:test";
import { StepSchema } from "../../src/config/schema.ts";
import {
  assignmentFor,
  buildShardPlan,
  formatShard,
  NO_SHARD,
  parseShardSpec,
  parseShardTotal,
  renderShardBanner,
  renderShardPlan,
  shardEnv,
  ShardSpecError,
  stepShardMode,
  stepWeight,
  unitKey,
  withoutShardInput,
  type PlannedStep,
} from "../../src/runners/shard.ts";

function whole(step: string, weight = 1, group = ""): PlannedStep {
  return { group, step, mode: "whole", weight, targets: null };
}

function split(
  step: string,
  targets: readonly string[],
  weight = 1,
  group = "",
): PlannedStep {
  return { group, step, mode: "targets", weight, targets };
}

function native(step: string, weight = 1, group = ""): PlannedStep {
  return { group, step, mode: "native", weight, targets: null };
}

describe("parseShardSpec", () => {
  test("parses 1-based index/total", () => {
    expect(parseShardSpec("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShardSpec(" 1 / 1 ")).toEqual({ index: 1, total: 1 });
  });

  test("rejects malformed specs", () => {
    expect(() => parseShardSpec("2")).toThrow(ShardSpecError);
    expect(() => parseShardSpec("a/b")).toThrow("<index>/<total>");
    expect(() => parseShardSpec("-1/2")).toThrow(ShardSpecError);
  });

  test("rejects out-of-range values and names the source", () => {
    expect(() => parseShardSpec("0/0")).toThrow("total must be at least 1");
    expect(() => parseShardSpec("0/3")).toThrow("between 1 and 3");
    expect(() => parseShardSpec("4/3", "AGENT_HOOKS_SHARD")).toThrow(
      "AGENT_HOOKS_SHARD: index must be between 1 and 3",
    );
  });
});

describe("parseShardTotal", () => {
  test("accepts positive whole numbers", () => {
    expect(parseShardTotal("3")).toBe(3);
  });

  test("rejects zero and junk", () => {
    expect(() => parseShardTotal("0")).toThrow(ShardSpecError);
    expect(() => parseShardTotal("2/3")).toThrow("--shard-plan must be");
  });
});

describe("shard env helpers", () => {
  test("formatShard and shardEnv", () => {
    expect(formatShard({ index: 2, total: 5 })).toBe("2/5");
    expect(shardEnv(NO_SHARD)).toEqual({
      AGENT_HOOKS_SHARD_INDEX: "1",
      AGENT_HOOKS_SHARD_TOTAL: "1",
    });
  });

  test("withoutShardInput drops only the CLI input var", () => {
    const env = { AGENT_HOOKS_SHARD: "1/2", PATH: "/bin" };
    expect(withoutShardInput(env)).toEqual({ PATH: "/bin" });
    expect(env.AGENT_HOOKS_SHARD).toBe("1/2");
    const plain = { PATH: "/bin" };
    expect(withoutShardInput(plain)).toBe(plain);
  });
});

describe("stepShardMode / stepWeight", () => {
  test("fan-out modes split targets by default, others run whole", () => {
    expect(
      stepShardMode(StepSchema.parse({ run: "x {file}", invocation: "per-file" })),
    ).toBe("targets");
    expect(
      stepShardMode(
        StepSchema.parse({
          run: "x {dir}",
          invocation: "per-directory",
          "dir-from": "parent",
        }),
      ),
    ).toBe("targets");
    expect(
      stepShardMode(
        StepSchema.parse({
          run: "x {dir}",
          invocation: "per-marker-dir",
          marker: "go.mod",
        }),
      ),
    ).toBe("targets");
    expect(stepShardMode(StepSchema.parse({ run: "x" }))).toBe("whole");
  });

  test("an explicit shard mode wins", () => {
    expect(
      stepShardMode(
        StepSchema.parse({ run: "x {file}", invocation: "per-file", shard: "whole" }),
      ),
    ).toBe("whole");
    expect(stepShardMode(StepSchema.parse({ run: "x", shard: "native" }))).toBe(
      "native",
    );
  });

  test("weight defaults to 1", () => {
    expect(stepWeight(StepSchema.parse({ run: "x" }))).toBe(1);
    expect(stepWeight(StepSchema.parse({ run: "x", weight: 120 }))).toBe(120);
  });
});

describe("unitKey", () => {
  test("prefixes the group and suffixes the target", () => {
    expect(unitKey("", "lint")).toBe("lint");
    expect(unitKey("services/a", "lint")).toBe("services/a:lint");
    expect(unitKey("", "sh", "a.sh")).toBe("sh[a.sh]");
  });
});

describe("buildShardPlan", () => {
  const steps = [
    whole("lint"),
    whole("typecheck", 50),
    whole("test", 180),
    whole("build", 4),
    whole("e2e", 340),
    whole("knip", 3),
  ];

  test("every unit lands in exactly one shard, for every shard count", () => {
    for (let total = 1; total <= 8; total += 1) {
      const plan = buildShardPlan(steps, total);
      expect(plan.units.map((unit) => unit.key)).toEqual([
        "lint",
        "typecheck",
        "test",
        "build",
        "e2e",
        "knip",
      ]);
      for (const unit of plan.units) {
        const shard = plan.assignment.get(unit.key) ?? 0;
        expect(shard).toBeGreaterThanOrEqual(1);
        expect(shard).toBeLessThanOrEqual(total);
      }
      expect(plan.assignment.size).toBe(plan.units.length);
    }
  });

  test("balances by weight (heaviest first onto the lightest shard)", () => {
    const plan = buildShardPlan(steps, 3);
    expect(plan.assignment.get("e2e")).toBe(1);
    expect(plan.assignment.get("test")).toBe(2);
    expect(plan.assignment.get("typecheck")).toBe(3);
    expect(plan.loads).toEqual([340, 180, 58]);
  });

  test("is independent of input order and stable across calls", () => {
    const forward = buildShardPlan(steps, 3);
    const reversed = buildShardPlan([...steps].reverse(), 3);
    expect([...reversed.assignment].sort()).toEqual([...forward.assignment].sort());
    expect(reversed.fingerprint).toBe(forward.fingerprint);
    expect(forward.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(buildShardPlan(steps, 2).fingerprint).not.toBe(forward.fingerprint);
  });

  test("equal weights spread round-robin by key", () => {
    const plan = buildShardPlan([whole("c"), whole("a"), whole("b")], 2);
    expect(plan.assignment.get("a")).toBe(1);
    expect(plan.assignment.get("b")).toBe(2);
    expect(plan.assignment.get("c")).toBe(1);
  });

  test("split steps contribute one unit per target, sharing the weight", () => {
    const plan = buildShardPlan(
      [split("shellcheck", ["a.sh", "b.sh", "c.sh", "d.sh"], 8)],
      2,
    );
    expect(plan.units).toHaveLength(4);
    expect(plan.units[0]?.weight).toBe(2);
    expect(plan.loads).toEqual([4, 4]);
  });

  test("a targets step with no resolved targets is one whole unit", () => {
    const plan = buildShardPlan([split("tf", [], 1), { ...split("x", []), targets: null }], 2);
    expect(plan.units.map((unit) => unit.key)).toEqual(["tf", "x"]);
  });

  test("a step listed twice in a pipeline plans to one shard", () => {
    const plan = buildShardPlan([whole("lint"), whole("lint"), whole("x")], 2);
    const lint = assignmentFor(plan, "", { index: plan.assignment.get("lint") ?? 0, total: 2 });
    expect(lint.steps.get("lint")).toEqual({ kind: "run", native: false });
  });

  test("native steps add an equal share to every shard and are not units", () => {
    const plan = buildShardPlan([native("vitest", 90), whole("lint", 10)], 3);
    expect(plan.units).toHaveLength(1);
    expect(plan.native).toHaveLength(1);
    expect(plan.loads).toEqual([40, 30, 30]);
  });

  test("groups keep monorepo workspaces apart", () => {
    const plan = buildShardPlan(
      [whole("lint", 1, "."), whole("lint", 1, "services/a")],
      2,
    );
    expect(plan.units.map((unit) => unit.key)).toEqual([".:lint", "services/a:lint"]);
    expect(new Set(plan.assignment.values()).size).toBe(2);
  });
});

describe("assignmentFor", () => {
  const plan = buildShardPlan(
    [
      whole("e2e", 100),
      whole("lint", 1),
      split("sh", ["a.sh", "b.sh", "c.sh"], 3),
      native("unit", 6),
      whole("other", 1, "ws"),
    ],
    2,
  );

  test("whole steps run in their shard and are elsewhere in others", () => {
    const one = assignmentFor(plan, "", { index: 1, total: 2 });
    const two = assignmentFor(plan, "", { index: 2, total: 2 });
    expect(one.steps.get("e2e")).toEqual({ kind: "run", native: false });
    expect(two.steps.get("e2e")).toEqual({
      kind: "elsewhere",
      shards: [1],
      of: 1,
    });
    expect(one.fingerprint).toBe(plan.fingerprint);
  });

  test("native steps run everywhere", () => {
    for (const index of [1, 2]) {
      expect(
        assignmentFor(plan, "", { index, total: 2 }).steps.get("unit"),
      ).toEqual({ kind: "run", native: true });
    }
  });

  test("split targets partition across shards", () => {
    const one = assignmentFor(plan, "", { index: 1, total: 2 }).steps.get("sh");
    const two = assignmentFor(plan, "", { index: 2, total: 2 }).steps.get("sh");
    const owned = [one, two].flatMap((decision) =>
      decision?.kind === "targets" ? [...decision.targets] : [],
    );
    expect(owned.sort()).toEqual(["a.sh", "b.sh", "c.sh"]);
  });

  test("a split step with no targets on this shard is elsewhere", () => {
    const small = buildShardPlan([split("sh", ["a.sh"], 1), whole("x", 5)], 2);
    expect(
      assignmentFor(small, "", { index: 1, total: 2 }).steps.get("sh"),
    ).toEqual({ kind: "elsewhere", shards: [2], of: 1 });
    const spread = buildShardPlan([split("sh", ["a.sh", "b.sh"], 2)], 3);
    expect(
      assignmentFor(spread, "", { index: 3, total: 3 }).steps.get("sh"),
    ).toEqual({ kind: "elsewhere", shards: [1, 2], of: 2 });
  });

  test("only the requested group's steps are included", () => {
    const ws = assignmentFor(plan, "ws", { index: 1, total: 2 });
    expect([...ws.steps.keys()]).toEqual(["other"]);
  });
});

describe("renderShardPlan / renderShardBanner", () => {
  test("plan lists each unit under its shard", () => {
    const plan = buildShardPlan(
      [
        whole("e2e", 10),
        whole("lint", 1, "services/a"),
        split("sh", ["a.sh", "b.sh"], 1),
        native("unit", 3),
      ],
      2,
    );
    const text = renderShardPlan(plan, "ci");
    expect(text).toContain(
      `shard plan for ci: 2 shard(s), 4 unit(s), 1 native step(s) (plan ${plan.fingerprint})`,
    );
    expect(text).toContain("shard 1/2 (load 11.5):\n  unit (native: --shard=1/2)\n  e2e\n");
    expect(text).toContain("unit (native: --shard=2/2)");
    expect(text).toContain("  services/a:lint\n");
    expect(text).toContain("  sh [a.sh]\n");
  });

  test("an empty shard says so", () => {
    const text = renderShardPlan(buildShardPlan([whole("lint")], 2), "ci");
    expect(text).toContain("shard 2/2 (load 0):\n  (nothing)\n");
  });

  test("banner names what runs here and where the rest went", () => {
    const plan = buildShardPlan(
      [whole("e2e", 10), whole("lint"), split("sh", ["a", "b", "c"], 3), native("unit")],
      2,
    );
    const spec = { index: 2, total: 2 };
    const banner = renderShardBanner(
      assignmentFor(plan, "", spec),
      "ci",
      ["e2e", "lint", "sh", "unit", "unplanned"],
      "",
    );
    expect(banner).toContain(`⧉ shard 2/2 of ci (plan ${plan.fingerprint})`);
    expect(banner).toContain("runs here: lint, sh (3/3 targets), unit (native)");
    expect(banner).toContain("on other shards: e2e → 1");
  });

  test("banner for a group with nothing on either side", () => {
    const plan = buildShardPlan([whole("lint")], 1);
    const banner = renderShardBanner(
      assignmentFor(plan, "services/a", { index: 1, total: 1 }),
      "ci",
      ["lint"],
      "services/a",
    );
    expect(banner).toContain("of ci [services/a]");
    expect(banner).toContain("runs here: (nothing)");
    expect(banner).toContain("on other shards: (none)");
  });
});
