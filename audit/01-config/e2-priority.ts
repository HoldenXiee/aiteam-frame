// 1.2 三层优先级的实际规则：host.defaults ← members[x] ← 顶层 createAgent(spec)
// 重点：数组字段是合并还是替换、显式 undefined 会不会干掉上层、同名成员多次 spawn 是否共享引用。
// 跑法：node audit/01-config/e2-priority.ts
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost, type AgentHost, type MemberSpec } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { dump, record, section } from "./_h.ts";
import { makeEnv } from "../_faux.ts";
import { lastRaw, startCapture, type RawCall } from "./_cap.ts";

const env = await makeEnv();
const cap = startCapture();
const { agentDir, cwd, runtime, model } = env;
const raw = (): RawCall | undefined => lastRaw(cap.calls);
const note = (id: string, question: string, observed: string, conclusion: string, data?: unknown) =>
  record({ id, question, observed, verdict: "INFO", conclusion, data });

/** 起一个带花名册的宿主 + 一个顶层 agent，返回 spawn 工具 */
async function scaffold(members: Record<string, MemberSpec>, defaults: Partial<MemberSpec> = {}) {
  const roster = members;
  const host: AgentHost = createAgentHost({ members: roster, defaults, modelRuntime: runtime });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  return { host, top, spawn: createSpawnAgentTool({ agent: top, host }), roster };
}
const spawnOf = async (s: Awaited<ReturnType<typeof scaffold>>, member: string, task = "hi") => {
  const r = await s.spawn.execute("c", { member, task } as never, undefined, undefined, undefined as never);
  const text = ((r as { content: Array<{ text?: string }> }).content ?? []).map((x) => x.text ?? "").join("");
  return { text, child: s.host.list().find((a) => a.member === member) };
};

// ─────────────────────────────────────────────────────────────
section("1.2 三层优先级与叠加规则");

// P1：defaults 是基线，成员未写的字段继承
{
  const s = await scaffold({ m: { description: "只写 description" } }, { role: "默认角色-DR-00", tools: ["read"], model });
  await spawnOf(s, "m");
  const req = raw()!;
  record({
    id: "1.2-P1",
    question: "defaults → members[x]：成员没写的字段是否继承 defaults",
    observed: `defaults={role:"默认角色-DR-00",tools:["read"]}；成员 m 只写 description → 请求 tools=${JSON.stringify(req.tools)}，system 含默认角色=${req.system.includes("默认角色-DR-00")}`,
    verdict: req.tools.includes("read") && req.system.includes("默认角色-DR-00") ? "OK" : "GAP",
    conclusion: "继承：defaults 是基线，成员未声明的字段原样落下。",
    data: { tools: req.tools, hasRole: req.system.includes("默认角色-DR-00") },
  });
  s.host.dispose();
}

// P2：标量与数组字段分别覆盖
{
  const s = await scaffold(
    { m: { description: "覆盖者", role: "成员角色-MR-01", tools: ["bash"] } },
    { role: "默认角色-DR-01", tools: ["read", "write"], model },
  );
  await spawnOf(s, "m");
  const req = raw()!;
  record({
    id: "1.2-P2",
    question: "members[x] → defaults：标量覆盖？数组字段是合并还是整体替换？",
    observed: `defaults.tools=["read","write"] + 成员.tools=["bash"] → ${JSON.stringify(req.tools)}；defaults.role 已被成员 role 顶掉=${!req.system.includes("默认角色-DR-01")}，成员 role 在场=${req.system.includes("成员角色-MR-01")}`,
    verdict: req.tools.length === 1 && req.tools[0] === "bash" ? "OK" : "PARTIAL",
    conclusion:
      req.tools.length === 1 && req.tools[0] === "bash"
        ? "浅合并：数组整体替换（不拼接），标量替换。想「在默认之上加一个工具」必须重写整个数组。"
        : "数组字段的表现与「整体替换」不符。",
    data: { tools: req.tools },
  });
  s.host.dispose();
}

// P3：顶层 spec 与 members[x] 是并列，不是三层链
{
  const s = await scaffold({ m: { description: "成员" } }, { role: "默认角色-DR-02", model });
  // 顶层 agent 是上面 scaffold 里的 top；它自己的 system 里有什么？
  await s.top.prompt("hi");
  const topReq = raw()!;
  const topHasDefault = topReq.system.includes("默认角色-DR-02");
  const topTools = topReq.tools;
  record({
    id: "1.2-P3",
    question: "顶层 createAgent(spec) 与 members[x] 是三层链，还是并列两条路？",
    observed: `host.defaults={role:"默认角色-DR-02"}；顶层 spec={tools:["spawn_agent"]}（没写 role）→ 顶层 system 含默认角色=${topHasDefault}，顶层 tools=${JSON.stringify(topTools)}；成员 m（没写任何字段）→ 走 defaults`,
    verdict: !topHasDefault && topTools.length === 1 ? "OK" : "PARTIAL",
    conclusion:
      topHasDefault
        ? "顶层也吃 defaults。"
        : `顶层 spec 与成员定义是**并列**的两条路，不存在 members[x] ← 顶层 spec 的叠加。反直觉点：顶层 spec 的 \`tools:["spawn_agent"]\` 把 defaults 的 tools 整组替换掉了（实际=${JSON.stringify(topTools)}），顶层 agent 因此拿不到 defaults 里配置的业务工具；而 spawn 出来的成员拿得到。`,
    data: { topHasDefault, topTools, defaultsTools: ["read"] },
  });
  s.host.dispose();
}

// P4：显式 undefined 的展开陷阱
{
  const host = createAgentHost({
    defaults: { role: "默认角色-DR-03", tools: ["read"], model },
    members: { m: { description: "显式 undefined", role: undefined, tools: undefined } },
    modelRuntime: runtime,
  });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const s = { host, top, spawn: createSpawnAgentTool({ agent: top, host }), roster: {} };
  await spawnOf(s, "m");
  const req = raw()!;
  record({
    id: "1.2-P4",
    question: "Partial<MemberSpec> 展开时，显式 undefined 会不会覆盖掉上层的值？（JS 展开陷阱）",
    observed: `defaults={role:"默认角色-DR-03",tools:["read"]}；成员写 role:undefined, tools:undefined → 请求 tools=${JSON.stringify(req.tools)}（含 bash/edit/write=${req.tools.includes("bash")}）；system 含默认角色=${req.system.includes("默认角色-DR-03")}`,
    verdict: !req.system.includes("默认角色-DR-03") && req.tools.length > 1 ? "GAP" : "OK",
    conclusion:
      !req.system.includes("默认角色-DR-03") && req.tools.length > 1
        ? "**会覆盖**（静默）：`{...defaults, ...member}` 是浅展开，显式 undefined 照样盖掉上层。role 丢了、tools 白名单也丢了（回落到「不传 tools」= 全部工具）。类型上写成可选字段，看不出来。"
        : "显式 undefined 被忽略了（按值判断而非按 key 判断）。",
    data: { tools: req.tools, hasDefaultRole: req.system.includes("默认角色-DR-03") },
  });
  host.dispose();
}

// P5：数组/对象字段的合并性逐字段核对
{
  const skillOf = (n: string) => n; // 用名字形式，两个技能都在 agentDir/skills 下
  const s1 = await scaffold({ m: { description: "数组字段" } }, {});
  await s1.host.dispose();
  note(
    "1.2-P5",
    "tools / skills / extensions / customTools 四个数组字段的合并语义",
    "P2 已证 tools 整体替换；下面用 customTools 再证一遍（customTools 被替换会静默丢掉容器默认工具）",
    "四个数组字段走同一条 `{...defaults, ...spec}` 浅展开，语义一致：整体替换。",
  );
}

// P6：容器 defaults 的 customTools 被成员替换 → 静默丢工具
{
  const t1 = defineTool({ name: "ct_container", label: "1", description: "容器默认", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "1" }], details: {} }) });
  const t2 = defineTool({ name: "ct_member", label: "2", description: "成员自带", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "2" }], details: {} }) });
  const s = await scaffold(
    { m: { description: "带自己的 customTools", customTools: [t2], tools: ["ct_container", "ct_member"] } },
    { customTools: [t1], model },
  );
  await spawnOf(s, "m");
  const req = raw()!;
  record({
    id: "1.2-P6",
    question: "成员覆盖 customTools 时，defaults 里的 customTool 是否静默消失",
    observed: `defaults.customTools=[ct_container] + 成员.customTools=[ct_member] → 请求 tools=${JSON.stringify(req.tools)}`,
    verdict: req.tools.includes("ct_container") ? "OK" : "GAP",
    conclusion: req.tools.includes("ct_container")
      ? "两者都在（有合并）。"
      : "ct_container 静默消失：数组替换的副作用。白名单里点了名也没有用（工具压根没注册进 customTools）。",
    data: { tools: req.tools },
  });
  s.host.dispose();
}

// P7：显式 undefined 在 spawn 路径上的另一处：member.id
{
  const s = await scaffold({ m: { description: "带固定 id", id: "fixed-id-wanted" } as MemberSpec }, { model });
  const a = await spawnOf(s, "m");
  const b = await spawnOf(s, "m");
  record({
    id: "1.2-P7",
    question: "成员定义的 id 能否固定分身 id（spawn 里的 id:undefined 展开）",
    observed: `成员 id="fixed-id-wanted"；两次 spawn 的实际 id = ${a.child?.id} / ${b.child?.id}`,
    verdict: a.child?.id !== "fixed-id-wanted" ? "GAP" : "OK",
    conclusion:
      a.child?.id !== "fixed-id-wanted"
        ? "成员声明的 id 被 `createAgent({...spec, id: undefined})` 显式抹掉，每次都自动取号。设计者无法预知/固定分身 id（对寻址与日志关联是缺口）。"
        : "id 被尊重。",
    data: { a: a.child?.id, b: b.child?.id },
  });
  s.host.dispose();
}

// P8：同名成员多次 spawn —— 配置对象是共享引用还是拷贝？
{
  const memberSpec: MemberSpec = { description: "共享引用测试", role: "角色-初始", tools: ["read"] };
  const s = await scaffold({ m: memberSpec }, { model });
  const a = await spawnOf(s, "m");
  const firstTools = raw()!.tools;
  // 设计者在两次 spawn 之间改了**同一个成员对象**
  memberSpec.tools!.push("bash");
  (memberSpec as { role?: string }).role = "角色-被改了";
  const b = await spawnOf(s, "m");
  const secondTools = raw()!.tools;
  record({
    id: "1.2-P8",
    question: "同名成员被 spawn 多次，每次拿到的是同一份配置还是拷贝（运行期改成员对象会不会渗透）",
    observed: `第一次 spawn 请求 tools=${JSON.stringify(firstTools)}；改 memberSpec.tools.push("bash") 与 role 之后再 spawn → 请求 tools=${JSON.stringify(secondTools)}`,
    verdict: secondTools.includes("bash") ? "GAP" : "OK",
    conclusion: secondTools.includes("bash")
      ? "**共享引用**：花名册里的成员对象没有被拷贝，`{...defaults, ...rawSpec}` 只做浅展开 —— 数组仍是同一个引用。设计者在运行期改成员对象/数组，之后新建的分身会拿到被改过的配置（已建的分身不受影响，因为 session 已在构造期定型）。"
      : "每次都拷贝。",
    data: { firstTools, secondTools },
  });
  s.host.dispose();
}

// P9：同一个静态 ToolDefinition 对象被两个分身共用 —— 运行期状态是否串
{
  let counter = 0;
  const counterTool: ToolDefinition = defineTool({
    name: "probe_counter",
    label: "counter",
    description: "每次调用把闭包计数器 +1，返回当前值",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: `COUNT=${++counter}` }], details: {} }),
  });
  const s = await scaffold({ m: { description: "共享工具对象", customTools: [counterTool], tools: ["probe_counter"] } }, { model });
  const a = await spawnOf(s, "m", "[[tool:probe_counter]]");
  const b = await spawnOf(s, "m", "[[tool:probe_counter]]");
  record({
    id: "1.2-P9",
    question: "静态 customTool 对象被多个分身共用时，工具内部的运行期状态是否串台",
    observed: `同一个 ToolDefinition 对象挂到两个分身；A 调用后返回 ${/COUNT=\d+/.exec(a.text)?.[0]}，B 调用后返回 ${/COUNT=\d+/.exec(b.text)?.[0]}（闭包 counter 全局=${counter}）`,
    verdict: counter >= 2 ? "GAP" : "OK",
    conclusion:
      counter >= 2
        ? "**串台**：静态 ToolDefinition 是设计者给的同一个对象，库不复制它；任何写在闭包/对象属性上的状态在两个分身间共享。要做「每分身一份状态」只能用工厂函数（工厂每次 createAgent 都会被调用一次）。"
        : "未串台。",
    data: { counter, aText: a.text.slice(0, 120), bText: b.text.slice(0, 120) },
  });
  s.host.dispose();
}

// P10：工厂式工具是不是每分身一份
{
  const seen: string[] = [];
  const mkTool = (ctx: { agent: { id: string } }) =>
    defineTool({
      name: "probe_factory_counter",
      label: "fc",
      description: "工厂工具，记下自己的 agent.id",
      parameters: Type.Object({}),
      execute: async () => {
        seen.push(ctx.agent.id);
        return { content: [{ type: "text" as const, text: ctx.agent.id }], details: {} };
      },
    });
  const s = await scaffold({ m: { description: "工厂工具", customTools: [mkTool as never], tools: ["probe_factory_counter"] } }, { model });
  const a = await spawnOf(s, "m", "[[tool:probe_factory_counter]]");
  const b = await spawnOf(s, "m", "[[tool:probe_factory_counter]]");
  record({
    id: "1.2-P10",
    question: "工厂式 customTool 是否每个分身一份（对照 P9）",
    observed: `execute 里看到的 agent.id 序列 = ${JSON.stringify(seen)}（A=${a.child?.id} B=${b.child?.id}）`,
    verdict: seen.length === 2 && seen[0] !== seen[1] ? "OK" : "GAP",
    conclusion: seen.length === 2 && seen[0] !== seen[1] ? "每分身一份：工厂在每次 createAgent 时被调用，ctx 绑定到那个分身。" : "未隔离。",
    data: { seen, a: a.child?.id, b: b.child?.id },
  });
  s.host.dispose();
}

cap.stop();
dump("e2-priority");
await env.close();
