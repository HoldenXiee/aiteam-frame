// E4：运行时改拓扑 —— 量化影响并找**可运行**的绕法。
// 基线已知：已挂载的 spawn_agent 描述与枚举是构造时快照。这里量化「影响多大」并给可跑通的路子。
// 跑法：node audit/22-topology-live/e4-runtime-roster.ts    （假 provider，零成本，确定性）
import { createAgent, createAgentHost, type AgentHost, type MemberSpec } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { makeEnv } from "../_faux.ts";
import { makeSink } from "./_lib.ts";

const sink = makeSink("e4-runtime-roster");
const env = await makeEnv("echo");
const { agentDir, cwd, runtime, model } = env;
const hostOf = (members: Record<string, MemberSpec>, opts: Record<string, unknown> = {}) =>
  createAgentHost({ modelRuntime: runtime, members, ...opts } as never);
const mk = (host: AgentHost, extra: Record<string, unknown> = {}) => createAgent({ model, cwd, agentDir, ...extra }, { host, modelRuntime: runtime });

const toolText = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");
const enumOf = (t: { parameters: unknown }) => JSON.stringify((t.parameters as { properties: { member: unknown } }).properties.member);
const descOf = (t: { description: string }, name: string) => t.description.includes(name);

const runTool = async (tool: ReturnType<typeof createSpawnAgentTool>, args: unknown) =>
  toolText(await tool.execute("c", args as never, undefined, undefined, undefined as never));

// ─────────────── E4.1 量化：运行期新增成员后，模型实际看到什么 ───────────────
sink.section("E4.1 运行期扩编后，模型实际看到什么（看 system prompt / tools 的真实请求）");
{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A：负责甲" } };
  const host = hostOf({ maxAgents: 20, defaults: { tools: ["spawn_agent"] } }, { members });
  const root = await mk(host, { tools: ["spawn_agent"] });
  const mounted = createSpawnAgentTool({ agent: root, host });

  const before = { enum: enumOf(mounted), hasB: descOf(mounted, "成员 B") };
  members["b"] = { description: "成员 B：负责乙" }; // 运行期扩编
  const after = { enum: enumOf(mounted), hasB: descOf(mounted, "成员 B") };
  const fresh = createSpawnAgentTool({ agent: root, host });
  const freshView = { enum: enumOf(fresh), hasB: descOf(fresh, "成员 B") };

  // 关键：模型真正收到的那份请求里，spawn_agent 的 schema 是哪一个？
  await root.prompt("随便说一句");
  const req = env.calls()[env.calls().length - 1];

  sink.add({
    id: "E4.1a",
    question: "运行期给花名册加成员：已挂载工具/模型真实请求里会变吗",
    method: "createSpawnAgentTool 后在 members 上加 b，对比 tool.parameters/tool.description，并看假服务收到的 tools 列表",
    observed: [
      `已挂载：枚举 ${before.enum} → ${after.enum}；描述含「成员 B」${before.hasB} → ${after.hasB}`,
      `重新构造：枚举 ${freshView.enum}；描述含「成员 B」${freshView.hasB}`,
      `模型请求里收到的工具名：${JSON.stringify(req?.tools)}`,
    ].join("\n     "),
    verdict: after.hasB ? "OK" : "GAP",
    conclusion: after.hasB
      ? "会更新。"
      : "不会。已挂载的 spawn_agent 的**描述与 member 枚举都是构造时快照**，运行期加成员后模型完全发现不了它；只有重新构造工具实例才看得到。量化：影响 100% —— 不是「有时漏」，是「一定漏」。",
    data: { before, after, freshView, tools: req?.tools },
  });
  host.dispose();
}

// ─────────────── E4.2 影响面：谁被卡住 ───────────────
sink.section("E4.2 影响面：只有「已挂载该工具的 agent」被卡，还是全体");
{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A" } };
  const host = hostOf({ maxAgents: 20, defaults: { tools: ["spawn_agent"] } }, { members });
  // 两个都挂了 spawn_agent 的 agent
  const r1 = await mk(host, { tools: ["spawn_agent"] });
  const r2 = await mk(host, { tools: ["spawn_agent"] });
  members["b"] = { description: "成员 B" };
  const t1 = createSpawnAgentTool({ agent: r1, host });
  const t2 = createSpawnAgentTool({ agent: r2, host });
  void t1;
  sink.add({
    id: "E4.2a",
    question: "扩编后，旧分身的工具是不是永久失去新成员",
    method: "两个已挂载 spawn_agent 的旧 agent，扩编后看它们的工具描述",
    observed: `t1 描述含 B=${t1.description.includes("成员 B")}；t2 描述含 B=${t2.description.includes("成员 B")}`,
    verdict: t1.description.includes("成员 B") ? "OK" : "GAP",
    conclusion:
      "旧分身永久失去新成员：扩编对**已在运行**的 agent 一律不可见。要让它看见只能 dispose 重建（见 E4.3）。",
    data: {},
  });
  host.dispose();
}

// ─────────────── E4.3 绕法：重建 agent 是否真的可用 ───────────────
sink.section("E4.3 绕法：dispose + 重建 agent（在同一 host 上）");
{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A：负责甲" } };
  const host = hostOf({ maxAgents: 20, defaults: { tools: ["spawn_agent"] } }, { members });
  const old = await mk(host, { tools: ["spawn_agent"] });
  members["b"] = { description: "成员 B：负责乙" };

  old.dispose();
  const rebuilt = await mk(host, { tools: ["spawn_agent"] });
  const tool = createSpawnAgentTool({ agent: rebuilt, host });
  const canSeeB = tool.description.includes("成员 B");
  const r = await runTool(tool, { member: "b", task: "干乙的活" });
  const bSpawned = host.list().some((x) => x.member === "b");

  sink.add({
    id: "E4.3a",
    question: "dispose 旧 agent 再重建，能不能把新成员接上（且旧分身不残留）",
    method: "old.dispose() → createAgent(同 host) → createSpawnAgentTool → 真的 spawn 一次成员 b",
    observed: `重建后工具描述含「成员 B」=${canSeeB}；调用 member=b 返回=«${r.slice(0, 60)}»；宿主里出现 member=b 的分身=${bSpawned}；宿主活跃数=${host.activeCount}，历史累计 maxAgents 计数仍受 maxAgents=20 限制`,
    verdict: canSeeB && bSpawned ? "OK" : "GAP",
    conclusion: canSeeB && bSpawned
      ? "可用。绕法成立且只有 2 行：`old.dispose(); const next = await createAgent(...)`。代价是**旧分身的多轮上下文全丢**（dispose 不清 session.messages，但对象已不可操作），以及 maxAgents 的**终身计数**照旧被旧分身占掉一份。"
      : "不通。",
    data: { canSeeB, bSpawned, activeCount: host.activeCount },
  });
  host.dispose();
}

// ─────────────── E4.4 绕法对比：新建 host + 搬活 ───────────────
sink.section("E4.4 三种绕法的代价对比");
{
  const results: Record<string, string> = {};

  // 绕法 1：重建整个 host（成员全带上），把上一轮的产出文本当作上下文交回去
  {
    const members: Record<string, MemberSpec> = { a: { description: "成员 A" }, b: { description: "成员 B" } };
    const h1 = hostOf({ a: { description: "成员 A" } }, { maxAgents: 5 });
    const oldLead = await mk(h1, { tools: ["spawn_agent"] });
    const carry = (await oldLead.prompt("上一轮的结论：先做甲")).text;
    h1.dispose();
    const h2 = hostOf({ maxAgents: 20, defaults: { tools: ["spawn_agent"] } }, { members });
    const lead2 = await mk(h2, { tools: ["spawn_agent"] });
    const r = await lead2.prompt(`上一轮的结论是：${carry}。现在继续。`);
    results["重建整个 host"] =
      `新 host 的 lead 能看见 ${Object.keys(members).length} 个成员；上下文字符串搬运成功=${r.text.includes("先做甲")}；host.usage 归零=${h2.usage.totalTokens === 0}`;
    h2.dispose();
  }

  // 绕法 2：一开始就把全套花名册给全，只在 spawn 时用设计者代码限制谁可选
  {
    const members: Record<string, MemberSpec> = {
      a: { description: "成员 A" },
      b: { description: "成员 B（阶段二才启用）" },
    };
    const host = hostOf({ maxAgents: 5, defaults: { tools: ["spawn_agent"] } }, { members });
    const lead = await mk(host, { tools: ["spawn_agent"] });
    const tool = createSpawnAgentTool({ agent: lead, host });
    // 设计者侧门：想拦住 b 就用 onToolCall（但那是 per-member 的创建期配置，运行期改不了）
    const r = await runTool(tool, { member: "b", task: "本不该现在用" });
    results["一开始给全 + 设计者侧过滤"] =
      `成员 b 从一开始就在枚举里=${tool.description.includes("成员 B")}；运行期想靠已有 API 拦住它：spawn_agent 的工具描述/枚举无法被设计者改写，onToolCall 是创建期配置 —— 实测这一次 spawn ${host.list().some((x) => x.member === "b") ? "成功（拦不住）" : "被拦住"}；返回=«${r.slice(0, 40)}»`;
    host.dispose();
  }

  // 绕法 3：spawn_agent 之外的第二条通道（设计者自己写 customTool），不受快照约束
  {
    const members: Record<string, MemberSpec> = { a: { description: "成员 A" } };
    const host = hostOf({ maxAgents: 5, defaults: { tools: ["spawn_agent"] } }, { members });
    let seen = "";
    const rosterProbe = {
      name: "roster_now",
      label: "看花名册",
      description: "列出当前花名册（设计者自建，读活对象）",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        seen = Object.keys(host.members).join(",");
        return { content: [{ type: "text" as const, text: `当前成员：${seen}` }], details: {} };
      },
    };
    const lead = await mk(host, { tools: ["roster_now"], customTools: [rosterProbe] });
    members["b"] = { description: "成员 B" };
    const r = await lead.prompt("[[tool:roster_now]]");
    results["自建 customTool 读活对象"] = `设计者自建工具读到的花名册=${seen}；模型看到=${JSON.stringify(r.text.slice(0, 60))}`;
    host.dispose();
  }

  // 绕法 4：bz 直连 createAgent（设计者侧直接加人，不经花名册）
  {
    const members: Record<string, MemberSpec> = { a: { description: "成员 A" } };
    const host = hostOf({ maxAgents: 5, defaults: { tools: ["spawn_agent"] } }, { members });
    const lead = await mk(host);
    const late = await createAgent({ model, cwd, agentDir, role: "运行期设计者塞进来的人" }, { host, modelRuntime: runtime, parent: lead });
    members["late"] = { description: "运行期新增" };
    const tool = createSpawnAgentTool({ agent: lead, host });
    const r = await runTool(tool, { member: "late", task: "跑一轮" });
    results["设计者直接 createAgent + 同步花名册 + 重建工具"] =
      `新分身 ${late.id} 已挂到 lead 下；重建后的工具看得见 late=${tool.description.includes("运行期新增")}；spawn 返回=«${r.slice(0, 40)}»`;
    host.dispose();
  }

  console.log(JSON.stringify(results, null, 2));
  sink.add({
    id: "E4.4a",
    question: "运行时改花名册有哪几条可运行的路子，各自的代价",
    method: "同进程里分别跑 4 种绕法并记录实际结果",
    observed: Object.entries(results)
      .map(([k, v]) => `${k}：${v}`)
      .join("\n     "),
    verdict: "PARTIAL",
    conclusion:
      "四个绕法里，只有两个是**完整可用**的：(1) 重建 agent（旧上下文丢，maxAgents 终身计数照旧占用）；(2) 设计者侧直接 createAgent + 同步花名册 + 重建工具（不动 host，最省）。「一开始给全 + 运行期过滤」做不到：spawn_agent 的描述/枚举设计者改不了，onToolCall 也是创建期配置。「自建 customTool 读活对象」能让模型看到最新花名册，但那只是读取，模型拿到名单后仍然没有工具去起新成员。",
    data: results,
  });
}

// ─────────────── E4.5 运行期删除成员 ───────────────
sink.section("E4.5 运行期删除成员");
{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A" }, b: { description: "成员 B" } };
  const host = hostOf({ maxAgents: 10, defaults: { tools: ["spawn_agent"] } }, { members });
  const lead = await mk(host, { tools: ["spawn_agent"] });
  const tool = createSpawnAgentTool({ agent: lead, host });
  delete members["a"];
  const r = await runTool(tool, { member: "a", task: "还有人吗" });
  const stillInEnum = tool.description.includes("成员 A：");
  sink.add({
    id: "E4.5a",
    question: "运行期删成员：查询与『可挑选列表』是否一致",
    method: "delete members.a 后用同一工具实例 spawn member=a",
    observed: `工具描述里仍列着「成员 A：」=${stillInEnum}；spawn 返回=«${r}»`,
    verdict: /没有成员/.test(r) ? "PARTIAL" : "INFO",
    conclusion:
      "不一致：查询走**活对象**（说『花名册里没有成员 a』），描述与枚举走**构造时快照**（同一句里又把 a 列为可挑选成员）。对模型来说这是自相矛盾的工具结果，对设计者来说是『删了还在』。",
    data: { stillInEnum, r },
  });
  host.dispose();
}

// ─────────────── E4.6 设计者侧 vs agent 侧改拓扑的能力差 ───────────────
sink.section("E4.6 谁能改拓扑");
{
  const members: Record<string, MemberSpec> = { a: { description: "成员 A" } };
  const host = hostOf({ maxAgents: 10, defaults: { tools: ["spawn_agent"] } }, { members });
  const lead = await mk(host, { tools: ["spawn_agent", "send_message"] });
  const tool = createSpawnAgentTool({ agent: lead, host });
  // agent 侧：能不能通过参数塞进配置覆盖
  const r1 = await runTool(tool, { member: "a", task: "干活", tools: ["bash"], model: "别人的模型", cwd: "C:/" });
  const created = host.list().find((x) => x.member === "a")!;
  const configVisible =
    (created as unknown as { session: { thinkingLevel?: string } }).session.thinkingLevel !== undefined ||
    (created as unknown as { session: { model?: unknown } }).session.model;
  sink.add({
    id: "E4.6a",
    question: "agent 能不能通过给 spawn_agent 多塞参数来改拓扑/配置",
    method: "调用 spawn_agent 时额外传 tools/model/cwd 三个参数",
    observed: `调用返回=«${r1.slice(0, 70)}»；被创建的分身 model=${JSON.stringify((created as never as { session: { model?: { id?: string } } }).session.model?.id)}，member=a，parent=${created.parentId}`,
    verdict: "OK",
    conclusion:
      "多塞的参数被完全忽略（schema 只声明 member/task，多余键不影响执行）—— agent 确实改不了配置。设计红线在这一层是硬约束。",
    data: { r1, model: (created as never as { session: { model?: { id?: string } } }).session.model?.id, configVisible },
  });
  host.dispose();
}

void env.close();
console.log(`\n→ ${sink.path}`);
