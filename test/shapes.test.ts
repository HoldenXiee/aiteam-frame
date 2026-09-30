// 规格 §10 的集群形态清单：除形态 1（单 agent，各任务已覆盖）与形态 11（属阶段 2）外，
// 每种形态都在假 provider 下脚本化跑一遍。做不到的形态 = L1 的接缝漏了。
//
// 假服务脚本约定的一个限制：`[[args:{...}]]` / `[[call:NAME {...}]]` 里的 JSON 只做 lazy 正则，
// 所以 **参数里不要再嵌 `[[...]]` 标记**（任务文本里要带标记时，写在 call 外面）。
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgent,
  createAgentHost,
  type AgentHost,
  type ControlledAgent,
  type HostOptions,
  type MemberSpec,
} from "../src/index.ts";
import { FAUX_MODEL_REF } from "./faux-models.ts";
import { faux, runTool, textOf } from "./helpers.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const spawnArgs = (member: string, task: string) => JSON.stringify({ member, task });
const sendArgs = (agentId: string, message: string) => JSON.stringify({ agentId, message });

/** 顶层主持人：能挑人、能投递 */
async function team(members: Record<string, MemberSpec>, opts: HostOptions = {}) {
  const host = createAgentHost({ members, ...opts });
  const lead = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent", "send_message"] }, { host });
  return { host, lead };
}

function find(host: AgentHost, member: string): ControlledAgent {
  const agent = host.list().find((a) => a.member === member);
  assert.ok(agent, `宿主里应当有成员 ${member} 的分身`);
  return agent!;
}

async function runSpawn(
  host: AgentHost,
  caller: ControlledAgent,
  member: string,
  task: string,
): Promise<{ text: string; agentId: string }> {
  const out = await runTool("spawn_agent", { member, task }, { host, agent: caller });
  return { text: textOf(out), agentId: (out.details as any).agentId as string };
}

async function runSend(host: AgentHost, caller: ControlledAgent, agentId: string, message: string): Promise<string> {
  return textOf(await runTool("send_message", { agentId, message }, { host, agent: caller }));
}

// ─────────────── 形态 2：并行扇出 ───────────────

test("形态 2 并行扇出：一条消息里多个 spawn_agent 并发执行", async () => {
  const { host, lead } = await team({ worker: {} });
  await lead.prompt("热个身"); // 首次 prompt 含大量懒加载，不能拿来比时间

  const one = `[[call:spawn_agent {"member":"worker","task":"[[sleep:400]] T"}]]`;
  let t0 = Date.now();
  for (let i = 0; i < 3; i++) await lead.prompt(one);
  const serialMs = Date.now() - t0;

  const three = [0, 1, 2]
    .map((i) => `[[call:spawn_agent {"member":"worker","task":"[[sleep:400]] P${i}"}]]`)
    .join(" ");
  t0 = Date.now();
  await lead.prompt(three);
  const parallelMs = Date.now() - t0;

  assert.equal(host.list().length, 1 + 3 + 3, "六个分身都该建起来");
  assert.ok(parallelMs < serialMs * 0.7, `并发应当明显快于串行：并发 ${parallelMs}ms vs 串行 ${serialMs}ms`);
});

// ─────────────── 形态 3：流水线 ───────────────

test("形态 3 流水线：A 的输出喂给 B", async () => {
  const a = await createAgent({ model: FAUX_MODEL_REF });
  const b = await createAgent({ model: FAUX_MODEL_REF });

  const first = await a.prompt("第一棒");
  const second = await b.prompt(first.text);

  assert.match(first.text, /echo:第一棒/);
  assert.match(second.text, /echo:echo:第一棒/, "B 拿到的是 A 的原样输出");
});

// ─────────────── 形态 4：监督者 + 工人池 ───────────────

test("形态 4 监督者 + 工人池：manager 派活、分身复用", async () => {
  const { host, lead: manager } = await team({ worker: { description: "工人" } });

  await manager.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("worker", "活 1")}]]`);
  const worker = find(host, "worker");

  for (let round = 2; round <= 3; round++) {
    await manager.prompt(`[[tool:send_message]] [[args:${sendArgs(worker.id, `活 ${round}`)}]]`);
    await worker.waitForIdle();
  }

  assert.equal(host.list().length, 2, "分身数不随轮次增长");
  assert.equal(host.list().filter((a) => a.member === "worker").length, 1);
  assert.match(worker.lastResult!.text, /活 3/, "复用的工人确实做了最后一轮");
});

// ─────────────── 形态 5：团队探讨直到收敛 ───────────────

test("形态 5 团队内部探讨：多轮 + 分身复用", async () => {
  const { host, lead: moderator } = await team({ alice: { description: "乐观派" }, bob: { description: "悲观派" } });

  // 一条消息里并行起两个分身，各自给出观点
  await moderator.prompt(
    `[[call:spawn_agent {"member":"alice","task":"说说你的观点"}]] [[call:spawn_agent {"member":"bob","task":"说说你的观点"}]]`,
  );
  const alice = find(host, "alice");
  const bob = find(host, "bob");
  // 主持人看得到成员观点（spawn 的返回文本进了它的上下文）
  assert.match(JSON.stringify(moderator.session.messages), /echo:说说你的观点/);

  const before = faux.calls.length;
  // 把对方的观点转发给每个人，再来一轮
  await moderator.prompt(
    `[[call:send_message {"agentId":"${alice.id}","message":"bob 认为先解决性能"}]] ` +
      `[[call:send_message {"agentId":"${bob.id}","message":"alice 认为先解决可读性"}]]`,
  );
  await Promise.all([alice.waitForIdle(), bob.waitForIdle()]);

  assert.match(alice.lastResult!.text, /bob 认为先解决性能/, "alice 收到了 bob 的观点");
  assert.match(bob.lastResult!.text, /alice 认为先解决可读性/, "bob 收到了 alice 的观点");
  assert.equal(host.list().length, 3, "全程只有三个分身（成员被复用）");
  assert.ok(faux.calls.length - before >= 2, "转发真的触发了新一轮请求");
});

// ─────────────── 形态 6：两团队争辩 + 裁决 ───────────────

test("形态 6 两团队争辩：子树嵌套 + 跨团队只能由主持人转发 + judge 裁决", async () => {
  const { host, lead: top } = await team({
    leadA: { description: "正方队长", tools: ["spawn_agent"] },
    leadB: { description: "反方队长", tools: ["spawn_agent"] },
    memberA: { description: "正方队员" },
    memberB: { description: "反方队员" },
    judge: { description: "裁判" },
  });

  await top.prompt(
    `[[call:spawn_agent {"member":"leadA","task":"组队"}]] [[call:spawn_agent {"member":"leadB","task":"组队"}]]`,
  );
  const leadA = find(host, "leadA");
  const leadB = find(host, "leadB");
  assert.equal(leadA.parentId, top.id);
  assert.equal(leadB.parentId, top.id);

  // 队长各自组队（深度 1 → 2，正好卡在默认 maxDepth=2 之内，护栏不该误触发）
  await leadA.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("memberA", "正方论据")}]]`);
  await leadB.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("memberB", "反方论据")}]]`);
  const memberA = find(host, "memberA");
  const memberB = find(host, "memberB");
  assert.equal(memberA.parentId, leadA.id);
  assert.equal(memberB.parentId, leadB.id);
  assert.equal(host.list().length, 5, "两队队员都在，护栏没误伤");

  // 队员之间不能直接对话（跨团队投递被拒）—— 只能由顶层主持人在两队之间转发
  assert.match(await runSend(host, leadA, memberB.id, "偷偷递话"), /后代/, "跨团队投递必须被拒");

  // 花名册同时是能力边界：成员定义里没开 spawn_agent 的成员，连挑人都做不到
  await memberA.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("m1", "自己招人")}]]`);
  assert.match(memberA.lastResult!.text, /not found|不存在/, "未被授权的成员发不起 spawn");
  assert.equal(host.list().filter((a) => a.member === "m1").length, 0);

  await top.prompt(
    `[[call:send_message {"agentId":"${leadA.id}","message":"反方说成本更高"}]] ` +
      `[[call:send_message {"agentId":"${leadB.id}","message":"正方说可读性更差"}]]`,
  );
  await Promise.all([leadA.waitForIdle(), leadB.waitForIdle()]);
  assert.match(leadA.lastResult!.text, /反方说成本更高/, "顶层把反方观点转给了正方");

  const verdict = await runSpawn(host, top, "judge", "裁决谁更有理");
  assert.match(verdict.text, /裁决谁更有理/, "裁判的结论里能看到它被交办的事");
  assert.match(verdict.text, new RegExp(verdict.agentId));
});

// ─────────────── 形态 7：共享黑板 ───────────────

test("形态 7 共享黑板：全队同一 cwd，成员读写同一个文件", async () => {
  const shared = mkdtempSync(join(tmpdir(), "aiteam-board-"));
  const boardFile = join(shared, "board.md");
  const NOTE = "黑板内容-XYZ";

  const writeNote = defineTool({
    name: "write_note",
    label: "写黑板",
    description: "往共享黑板追加内容",
    parameters: Type.Object({}),
    execute: async () => {
      appendFileSync(boardFile, `${NOTE}\n`, "utf-8");
      return ok("已写入黑板");
    },
  });
  const readNote = defineTool({
    name: "read_note",
    label: "读黑板",
    description: "读共享黑板的内容",
    parameters: Type.Object({}),
    execute: async () => ok(readFileSync(boardFile, "utf-8")),
  });

  const host = createAgentHost({
    members: {
      alice: { cwd: shared, customTools: [writeNote] },
      bob: { cwd: shared, customTools: [readNote] },
    },
  });
  const top = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });

  await top.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("alice", "[[tool:write_note]]")}]]`);
  const alice = find(host, "alice");
  assert.match(readFileSync(boardFile, "utf-8"), new RegExp(NOTE), "alice 真的写进了共享文件");

  await top.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("bob", "[[tool:read_note]]")}]]`);
  const bob = find(host, "bob");
  assert.match(bob.lastResult!.text, new RegExp(NOTE), "bob 读到了 alice 写的同一份文件");

  assert.equal(alice.session.sessionManager.getCwd(), shared);
  assert.equal(bob.session.sessionManager.getCwd(), shared);
});

// ─────────────── 形态 8：竞标 / 择优 ───────────────

test("形态 8 竞标择优：同一任务扇出给多个成员再选优", async () => {
  const { host, lead: buyer } = await team({
    bidderA: { description: "报价啰嗦" },
    bidderB: { description: "报价简短" },
    bidderC: { description: "报价居中" },
    judge: { description: "裁判" },
  });

  await buyer.prompt(
    `[[call:spawn_agent {"member":"bidderA","task":"报价：A 方案细节很多很多很多"}]] ` +
      `[[call:spawn_agent {"member":"bidderB","task":"报价：B"}]] ` +
      `[[call:spawn_agent {"member":"bidderC","task":"报价：C 方案"}]]`,
  );
  const bids = host.list().filter((a) => a.member?.startsWith("bidder"));
  assert.equal(bids.length, 3, "三家都交标了");

  // 设计者自己的择优规则（这里按文本长度取最长），再让 judge 确认
  const best = bids.reduce((x, y) => (y.lastResult!.text.length > x.lastResult!.text.length ? y : x));
  assert.equal(best.member, "bidderA");

  const verdict = await runSpawn(host, buyer, "judge", `确认中标方案：${best.lastResult!.text}`);
  assert.match(verdict.text, /A 方案/, "judge 的裁决里能看到中标的标书");
});

// ─────────────── 形态 9：反思-修订循环 ───────────────

test("形态 9 反思-修订循环：写手与审阅者全程复用同一对分身", async () => {
  const { host, lead: director } = await team({ writer: { description: "写手" }, reviewer: { description: "审阅者" } });

  const writerId = (await runSpawn(host, director, "writer", "初稿")).agentId;
  const reviewerId = (await runSpawn(host, director, "reviewer", "请审阅初稿")).agentId;

  let rounds = 0;
  let revisionRounds = 0;
  while (rounds < 3) {
    rounds += 1;
    const ask = rounds === 1 ? `第 ${rounds} 版审阅：先指出问题` : `第 ${rounds} 版审阅：通过`;
    await director.prompt(`[[tool:send_message]] [[args:${sendArgs(reviewerId, ask)}]]`);
    const reviewer = host.get(reviewerId)!;
    await reviewer.waitForIdle();
    if (reviewer.lastResult!.text.includes("通过")) break; // 审阅者说通过 → 收敛

    await director.prompt(`[[tool:send_message]] [[args:${sendArgs(writerId, `按意见改第 ${rounds} 版`)}]]`);
    const writer = host.get(writerId)!;
    await writer.waitForIdle();
    revisionRounds += 1;
  }

  assert.equal(rounds, 2, "第一轮没通过、第二轮通过");
  assert.equal(revisionRounds, 1, "中间改了一版");
  assert.equal(host.list().length, 3, "全程只有这一对分身");
  assert.equal(host.get(writerId)!.id, writerId);
  assert.equal(host.get(reviewerId)!.id, reviewerId);
});

// ─────────────── 形态 10：层级汇报 ───────────────

test("形态 10 层级汇报：每个主持人先汇总队员结论再上报", async () => {
  const { host, lead: top } = await team({
    leadA: { description: "组长 A", tools: ["spawn_agent"] },
    leadB: { description: "组长 B", tools: ["spawn_agent"] },
    m1: { description: "组员 1" },
    m2: { description: "组员 2" },
    m3: { description: "组员 3" },
  });

  await top.prompt(
    `[[call:spawn_agent {"member":"leadA","task":"带两个人"}]] [[call:spawn_agent {"member":"leadB","task":"带一个人"}]]`,
  );
  const leadA = find(host, "leadA");
  const leadB = find(host, "leadB");

  await leadA.prompt(
    `[[call:spawn_agent {"member":"m1","task":"结论 m1"}]] [[call:spawn_agent {"member":"m2","task":"结论 m2"}]]`,
  );
  await leadB.prompt(`[[tool:spawn_agent]] [[args:${spawnArgs("m3", "结论 m3")}]]`);

  // 第一步：每个主持人先汇总自己队员的结论（同步的 spawn 返回值天然支持）
  const summaryA = leadA.lastResult!.text;
  const summaryB = leadB.lastResult!.text;
  assert.match(summaryA, /结论 m1/, "A 组长的汇总里有组员 1 的结论");
  assert.match(summaryA, /结论 m2/, "A 组长的汇总里有组员 2 的结论");
  assert.match(summaryB, /结论 m3/);

  // 第二步：逐层上报 —— 顶层把两份汇总收上来再汇总
  const report = await top.prompt(`汇总上报：\n${summaryA}\n${summaryB}`);
  assert.match(report.text, /结论 m1/, "顶层拿到的汇总里有 A 组的结论");
  assert.match(report.text, /结论 m3/, "顶层拿到的汇总里有 B 组的结论");
  assert.equal(host.list().length, 6, "五个成员分身 + 顶层");
});
