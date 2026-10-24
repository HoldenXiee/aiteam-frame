// ★★★ 生长测试 —— 守「框架固定、里面能长」这件事不退化
//
// 设计者（逐字）：
//   「框架不能变（规则就属于框架的一部分），变的只能是**在框架里面长东西**，
//     比如启动 agent 等等（生长出符合框架的、**看似复杂但逻辑清晰的拓扑结构**）」
//   「长出来的席位**只在内存里，本轮有效**」
//
// ★★ 这里守的是**框架的硬约束**，不是"生长好不好用"：
//   ① 只用现有团队（不许新开团队）
//   ② 只读（长出来的东西不能反过来改框架）
//   ③ 不能再长（不许递归成树）
//   ④ 上限（不许一轮长出十个）
//   ⑤ 收尾态不长

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Agent } from "../../src/index.ts";
import { grownSeatRole, makeSpawnSeat, type SpawnSeatDeps } from "../../research/clusters/forge/tools/spawn-seat.ts";

/** ★ 假 agent（零成本 —— 不需要真模型）*/
const fakeAgent = () => ({ io: {} }) as unknown as Agent;

/** ★ `closingNow` 而不是 `closing` —— 避免把 deps.closing 函数覆盖成布尔（我在第一版就犯了）*/
type MkOpts = { closingNow?: boolean; maxSeats?: number };

function mk(over: MkOpts = {}) {
  const created: string[] = [];
  const grown: string[] = [];
  const deps: SpawnSeatDeps = {
    teams: () => ["theory", "practice", "landing"],
    takenKeys: () => ["theory/a", "practice/b", "landing/c"],
    create: async (s) => {
      created.push(s.key);
      return fakeAgent();
    },
    onGrown: (s) => grown.push(s.key),
    closing: () => over.closingNow ?? false,
    maxSeats: over.maxSeats,
  };
  return { tool: makeSpawnSeat(deps), created, grown };
}

/** ★ 跑一次工具（defineTool 的 execute 签名是 (id, params)）*/
async function run(tool: ReturnType<typeof makeSpawnSeat>, p: Record<string, string>) {
  const fn = (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details: { ok?: boolean; key?: string } }> }).execute;
  return fn("t", p);
}

describe("★★★ 框架约束：能长，但长不出框架之外", () => {
  it("★ 长出合法座位 ⇒ ok，且 onGrown 被调用（可记账）", async () => {
    const { tool, created, grown } = mk();
    const r = await run(tool, { team: "practice", duty: "核对单位", why: "没人核单位，且每份产物都要" });
    assert.equal(r.details.ok, true);
    assert.deepEqual(created, ["practice/核对单位"]);
    assert.deepEqual(grown, ["practice/核对单位"], "onGrown 没调用 ⇒ 长出来了但没人记账");
    assert.match(r.content[0]!.text, /本轮有效/);
  });

  it("★★★ 团队名必须是现有的（不许新开团队）", async () => {
    const { tool, created } = mk();
    const r = await run(tool, { team: "marketing", duty: "拉人", why: "想试" });
    assert.equal(r.details.ok, false);
    assert.equal(created.length, 0, "团队不存在却还是建了 agent");
    assert.match(r.content[0]!.text, /没有这个团队/);
  });

  it("★★ 重名 ⇒ 拒绝（已经在做的活不该再长一个）", async () => {
    const { tool, created } = mk();
    const r = await run(tool, { team: "theory", duty: "a", why: "重复" });
    assert.equal(r.details.ok, false);
    assert.equal(created.length, 0);
    assert.match(r.content[0]!.text, /已经有/);
  });

  it("★★ 同一次运行内重名也拒绝（takenKeys 查不到刚长的）", async () => {
    const { tool, created } = mk();
    await run(tool, { team: "theory", duty: "看单位", why: "x" });
    const r = await run(tool, { team: "theory", duty: "看单位", why: "x" });
    assert.equal(r.details.ok, false);
    assert.equal(created.length, 1, "长出了两个同 key 的座位");
  });

  it("★★★ 上限：长出 maxSeats 个后拒绝", async () => {
    const { tool, created } = mk({ maxSeats: 2 });
    assert.equal((await run(tool, { team: "theory", duty: "a1", why: "x" })).details.ok, true);
    assert.equal((await run(tool, { team: "theory", duty: "a2", why: "x" })).details.ok, true);
    const r = await run(tool, { team: "theory", duty: "a3", why: "x" });
    assert.equal(r.details.ok, false);
    assert.equal(created.length, 2, "超过上限还在长");
    assert.match(r.content[0]!.text, /上限/);
  });

  it("★ 收尾态 ⇒ 不长", async () => {
    const { tool, created } = mk({ closingNow: true });
    const r = await run(tool, { team: "theory", duty: "晚到的", why: "x" });
    assert.equal(r.details.ok, false);
    assert.equal(created.length, 0);
  });
});

describe("★★★ 长出来的座位的角色定义", () => {
  const role = grownSeatRole({ key: "practice/units", team: "practice", duty: "核对单位", why: "没人核单位" });

  it("★ 说了它是被长出来的（不是一开始就有）", () => {
    assert.match(role, /不是一开始就有的/);
    assert.match(role, /没人核单位/);
  });

  it("★★ 说了它只读（框架约束①）", () => {
    assert.match(role, /只读/);
    assert.match(role, /写不了任何文件/);
  });

  it("★★ 说了它不能再长（框架约束②）", () => {
    assert.match(role, /不能再长座位/);
  });

  it("★ 要求它表态（沉默和没看分不开）", () => {
    assert.match(role, /我看过了，没问题/);
  });
});
