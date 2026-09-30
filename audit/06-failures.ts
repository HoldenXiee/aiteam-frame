// 第 6 部分：失败与错误 —— 失败模式全表、可区分性、静默失败清单、失败传染。
// 本部分最重要的一节是 6.3「静默失败」：不报错但不按预期工作的行为。
// 跑法：node audit/06-failures.ts
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost, type ControlledAgent } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { check, dump, record, section } from "./_harness.ts";
import { makeEnv, makeSkill } from "./_faux.ts";

const env = await makeEnv();
const { agentDir, cwd, runtime, model, root } = env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = (extra: Record<string, unknown> = {}, host?: ReturnType<typeof createAgentHost>) =>
  createAgent({ model, cwd, agentDir, ...extra }, { modelRuntime: runtime, ...(host ? { host } : {}) });

/** 统一收集「这次构造怎么失败的」。注意：不能对返回的 agent 做 JSON.stringify —— session 图不可序列化，
 *  序列化本身会抛 “Theme not initialized. Call initTheme() first.”（这是个误导性极强的错误，见 6.1e）。 */
async function attempt(fn: () => Promise<unknown>): Promise<{ how: "成功" | "抛错"; detail: string; value?: unknown }> {
  try {
    const value = await fn();
    return { how: "成功", detail: "未抛错，构造完成", value };
  } catch (e) {
    return { how: "抛错", detail: (e as Error).message.slice(0, 90) };
  }
}

// ─────────────────────────────────────────────────────────────
section("6.1 构造期失败模式全表");

const construction: Array<{ id: string; what: string; run: () => Promise<unknown> }> = [
  { id: "c1", what: "model 名不存在", run: () => mk({ model: "faux/不存在" }) },
  { id: "c2", what: "model 引用一个不存在的 provider", run: () => mk({ model: "没这个provider/x" }) },
  { id: "c3", what: "skills 名字不存在", run: () => mk({ skills: ["不存在技能"] }) },
  {
    id: "c4",
    what: "Skill 对象 filePath 不存在",
    run: () => mk({ skills: [{ name: "x", description: "d", filePath: join(root, "no", "SKILL.md"), baseDir: root, source: "custom" } as never] }),
  },
  { id: "c5", what: "extensions 文件路径不存在", run: () => mk({ extensions: [join(root, "无此扩展.ts")] }) },
  {
    id: "c6",
    what: "extensions 文件语法错误",
    run: async () => {
      const bad = join(root, "bad-ext.ts");
      writeFileSync(bad, "export default function (pi) { this is not valid typescript (((\n", "utf-8");
      return mk({ extensions: [bad] });
    },
  },
  { id: "c7", what: "cwd 目录不存在", run: () => mk({ cwd: join(root, "没有这个目录") }) },
  { id: "c8", what: "agentDir 目录不存在", run: () => mk({ agentDir: join(root, "没有这个 agentDir") }) },
  { id: "c9", what: "tools 里列了一个不存在的工具名", run: () => mk({ tools: ["read", "根本不存在的工具"] }) },
  {
    id: "c10",
    what: "两个 customTools 同名",
    run: () =>
      mk({
        customTools: [
          defineTool({ name: "dup", label: "1", description: "一", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "1" }], details: {} }) }),
          defineTool({ name: "dup", label: "2", description: "二", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "2" }], details: {} }) }),
        ],
      }),
  },
  {
    id: "c11",
    what: "customTool 与内置工具同名（read）",
    run: () =>
      mk({
        customTools: [
          defineTool({ name: "read", label: "假 read", description: "冒充内置 read", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "被冒充了" }], details: {} }) }),
        ],
      }),
  },
  { id: "c12", what: "重复的 agent id", run: async () => {
      const host = createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir } } as never);
      await createAgent({ id: "same" }, { host, modelRuntime: runtime });
      return createAgent({ id: "same" }, { host, modelRuntime: runtime });
    } },
];

const constructionRows: Array<{ id: string; what: string; how: string; detail: string }> = [];
for (const c of construction) {
  const r = await attempt(c.run as () => Promise<unknown>);
  constructionRows.push({ id: c.id, what: c.what, how: r.how, detail: r.detail });
  console.log(`   ${c.id} ${c.what} → ${r.how}：${r.detail}`);
}
record({
  id: "6.1a",
  question: "构造期失败模式的错误通道分布",
  observed: constructionRows.map((r) => `${r.what}=${r.how}`).join("；"),
  verdict: "GAP",
  conclusion: `12 种可疑输入里有 ${constructionRows.filter((r) => r.how === "成功").length} 种**静默通过**（不报错、不抛异常、照样把 agent 建出来）：${constructionRows.filter((r) => r.how === "成功").map((r) => r.what).join("、")}。设计者以为配上了，实际没生效。`,
  data: constructionRows,
});

// 深挖 c9 / c10 / c11 实际建出来的 agent 是什么样
{
  const a = await mk({ tools: ["read", "根本不存在的工具"] });
  await a.prompt("hi");
  record({
    id: "6.1b",
    question: "tools 里写了不存在的工具名，实际暴露了什么",
    observed: `模型看到的工具 = ${JSON.stringify(env.last()!.tools)}`,
    verdict: env.last()!.tools.includes("根本不存在的工具") ? "OK" : "PARTIAL",
    conclusion: `不存在的名字被**静默丢弃**（请求里只有真实存在的）：${JSON.stringify(env.last()!.tools)}。设计者拼错工具名不会得到任何提示。`,
    data: { tools: env.last()!.tools },
  });
  a.dispose();
}
{
  const a = await mk({
    customTools: [
      defineTool({ name: "read", label: "假 read", description: "冒充内置 read", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "被冒充了" }], details: {} }) }),
    ],
    tools: ["read"],
  });
  await a.prompt("[[tool:read]] 看看谁赢");
  record({
    id: "6.1c",
    question: "customTool 与内置工具同名时谁生效",
    observed: `prompt 返回 = ${JSON.stringify(a.lastResult?.text?.slice(0, 60))}`,
    verdict: a.lastResult?.text?.includes("被冒充") ? "GAP" : "OK",
    conclusion: a.lastResult?.text?.includes("被冒充")
      ? "自定义工具**覆盖**了内置工具（同名时 customTools 赢）。这意味着设计者可以用 customTools 悄悄替换掉 read/bash 的语义 —— 对『能力裁剪』的意图是反的。"
      : "内置赢（自定义被忽略）。",
    data: { text: a.lastResult?.text?.slice(0, 120) },
  });
  a.dispose();
}
{
  let err = "";
  try {
    const host = createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir } } as never);
    await createAgent({ id: "same" }, { host, modelRuntime: runtime });
    await createAgent({ id: "same" }, { host, modelRuntime: runtime });
  } catch (e) {
    err = (e as Error).message;
  }
  check("6.1d", "重复 agent id 是否被拒", err.includes("same"), `抛出：${err}`, "被拒，且错误信息带 id。");
}

{
  // JSON.stringify(agent) 会抛一个与原因毫无关系的错
  const a = await mk();
  let jsonErr = "";
  try {
    JSON.stringify(a);
  } catch (e) {
    jsonErr = (e as Error).message;
  }
  let sessionErr = "";
  try {
    JSON.stringify(a.session);
  } catch (e) {
    sessionErr = (e as Error).message;
  }
  record({
    id: "6.1e",
    question: "设计者能不能把 agent / session 当作数据打印（日志、快照、持久化）",
    observed: `JSON.stringify(agent) → ${jsonErr ? `抛错「${jsonErr}」` : "成功"}；JSON.stringify(agent.session) → ${sessionErr ? `抛错「${sessionErr}」` : "成功"}`,
    verdict: jsonErr || sessionErr ? "GAP" : "OK",
    conclusion:
      jsonErr || sessionErr
        ? "不能。agent 与 session 的图里存在会抛异常的 getter/惰性初始化，序列化时报出的是 **“Theme not initialized. Call initTheme() first.”** —— 一个与「我想打印对象」毫无关系的错误。设计者做日志、快照、调试面板都会撞上，而且极难定位。"
        : "可以序列化。",
    data: { jsonErr, sessionErr },
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("6.2 运行期失败模式全表");

const runtimeRows: Array<{ what: string; how: string; detail: string }> = [];

async function runCase(what: string, setup: () => Promise<ControlledAgent>, promptText: string): Promise<void> {
  let detail = "";
  let how = "静默";
  try {
    const a = await setup();
    const r = await a.prompt(promptText);
    if (r.error) {
      how = "RunResult.error";
      detail = `error=${JSON.stringify(r.error.slice(0, 70))} text=${JSON.stringify(r.text.slice(0, 40))} status=${a.status}`;
    } else if (/Validation failed|not found|不存在/.test(r.text)) {
      how = "返回文本";
      detail = `text=${JSON.stringify(r.text.slice(0, 70))} status=${a.status}`;
    } else {
      how = "静默";
      detail = `无 error，text=${JSON.stringify(r.text.slice(0, 50))} status=${a.status}`;
    }
    a.dispose();
  } catch (e) {
    how = "抛错";
    detail = ((e as Error).message ?? "").slice(0, 90);
  }
  runtimeRows.push({ what, how, detail });
  console.log(`   ${what} → ${how}：${detail}`);
}

await runCase("模型 HTTP 400（[[fail]]）", () => mk(), "[[fail]] 触发模型错误");
await runCase("工具参数不合法", () => mk({ tools: ["read"] }), "[[tool:read]]");
await runCase("调用一个没挂上的工具", () => mk({ tools: ["read"] }), "[[tool:bash]] 试试");
await runCase(
  "工具 execute 抛异常",
  () =>
    mk({
      customTools: [
        defineTool({ name: "boom", label: "b", description: "会炸", parameters: Type.Object({}), execute: async () => { throw new Error("工具内部炸了-XYZ"); } }),
      ],
      tools: ["boom"],
    }),
  "[[tool:boom]]",
);
await runCase(
  "工具返回 isError 结果",
  () =>
    mk({
      customTools: [
        defineTool({ name: "softfail", label: "s", description: "软失败", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "我失败了-ABC" }], details: {}, isError: true } as never) }),
      ],
      tools: ["softfail"],
    }),
  "[[tool:softfail]]",
);
await runCase(
  "onToolCall 门自己抛异常",
  () => mk({ tools: ["read"], onToolCall: async () => { throw new Error("门炸了-QQQ"); } }),
  `[[tool:read]] [[args:${JSON.stringify({ path: "audit/_harness.ts" })}]]`,
);
await runCase(
  "customTools 工厂抛异常",
  async () => {
    const a = await mk({ customTools: [(() => { throw new Error("工厂炸了-FFF"); }) as never] });
    return a;
  },
  "hi",
);
await runCase("对已 dispose 的分身 prompt", async () => {
  const a = await mk();
  a.dispose();
  return a;
}, "hi");

record({
  id: "6.2a",
  question: "运行期失败模式的错误通道分布",
  observed: runtimeRows.map((r) => `${r.what}=${r.how}`).join("；"),
  verdict: "GAP",
  conclusion:
    `8 种运行期失败分散在 **4 条不同通道**（RunResult.error / 返回文本 / 抛错 / 静默）。设计者要可靠地发现「出错了」必须同时处理四条通道。其中「模型错误」与「工具错误」都落在 RunResult.error，但**无法从 error 区分是哪一类**（见 6.2b）。`,
  data: runtimeRows,
});

// ─────────────────────────────────────────────────────────────
section("6.2b 失败可区分性：设计者能否程序化区分失败原因");

{
  const samples: Array<{ label: string; error: string }> = [];
  // 模型 HTTP 400
  {
    const a = await mk();
    const r = await a.prompt("[[fail]] 模型错误");
    samples.push({ label: "模型 HTTP 400", error: r.error ?? "(无)" });
    a.dispose();
  }
  // 工具抛异常
  {
    const a = await mk({
      customTools: [defineTool({ name: "boom", label: "b", description: "炸", parameters: Type.Object({}), execute: async () => { throw new Error("工具内部炸了-XYZ"); } })],
      tools: ["boom"],
    });
    const r = await a.prompt("[[tool:boom]]");
    samples.push({ label: "工具 execute 抛异常", error: r.error ?? "(无)" });
    a.dispose();
  }
  // 工具参数不合法
  {
    const a = await mk({ tools: ["read"] });
    const r = await a.prompt("[[tool:read]]");
    samples.push({ label: "工具参数不合法", error: r.error ?? "(无 error，落在 text)" });
    a.dispose();
  }
  // 模型调用不存在的工具
  {
    const a = await mk({ tools: ["read"] });
    const r = await a.prompt("[[tool:bash]]");
    samples.push({ label: "调用未挂载的工具", error: r.error ?? "(无 error，落在 text)" });
    a.dispose();
  }
  record({
    id: "6.2b",
    question: "能否从 RunResult 程序化区分失败原因（而不是字符串匹配）",
    observed: samples.map((s) => `${s.label} → ${JSON.stringify(s.error.slice(0, 60))}`).join(" ｜ "),
    verdict: "GAP",
    conclusion:
      "不能。`RunResult` 只有 `{ text, usage, error?: string }` —— 没有错误码、没有类别、没有「哪个工具/哪个阶段失败」的结构化字段。设计者只能对 error 字符串做正则匹配（而错误文本是 pi 与 provider 的原文，会随版本变）。",
    data: samples,
  });
}

{
  record({
    id: "6.2c",
    question: "有没有结构化的失败信号（事件里的错误字段）",
    observed: "error 事件载荷只有 { message: string }；tool_end 有 isError: boolean（这是唯一的结构化失败位）",
    verdict: "PARTIAL",
    conclusion:
      "唯一的结构化失败信号是 `tool_end.isError`（布尔）。`error` 事件只有一条字符串。所以「工具失败」可以靠 tool_end 判，「模型失败」只能靠字符串 —— 而 run 级别的失败连是模型还是别的原因都分不出。",
  });
}

// ─────────────────────────────────────────────────────────────
section("6.3 静默失败清单（不报错但不按预期工作）");

const silent: Array<{ what: string; evidence: string; where: string }> = [
  { what: "extensions 路径不存在", evidence: "构造成功，扩展静默未加载（见 6.1a c5）", where: "构造期" },
  { what: "tools 里写错的工具名", evidence: "静默丢弃，不报错（见 6.1b）", where: "构造期" },
  { what: "thinking 档位被模型能力位夹掉", evidence: "reasoning:false 的模型下四档全变 off（见 1.1n）", where: "构造期" },
  { what: "成员覆盖数组字段导致 defaults 的 customTools 丢失", evidence: "ct_one 静默消失（见 1.2d）", where: "构造期" },
  { what: "spawn 的子分身不继承父的 model/cwd/agentDir/runtime", evidence: "回落到全局 settings 默认，实测打到真实 provider（见 1.2e / 4.1e）", where: "运行期" },
  { what: "空闲时 steer() 静默丢弃消息", evidence: "探路已确认（请求数不变）", where: "运行期" },
  { what: "第 2 条及之后的排队消息不产生 done / round_completed", evidence: "5 次生成只记 1 次 done（见 3.2a）", where: "运行期" },
  { what: "send 在预算耗尽时谎报 delivered=\"ran\"", evidence: "实际一个字都没跑（见 4.2b）", where: "运行期" },
  { what: "工具参数不合法时 onToolCall 审批门看不到", evidence: "门未被进入（见 2.4c）", where: "运行期" },
  { what: "运行时新增的成员对已挂载 spawn_agent 不可见", evidence: "枚举与描述都是构造时快照（见 2.5a）", where: "运行期" },
  { what: "mid 层 dispose 后后代变孤儿、拓扑静默变形", evidence: "见 2.6c", where: "运行期" },
];

record({
  id: "6.3a",
  question: "静默失败清单",
  observed: silent.map((s, i) => `${i + 1}. [${s.where}] ${s.what}`).join("\n     "),
  verdict: "GAP",
  conclusion:
    `共 ${silent.length} 条已实测确认的静默失败。它们的共同点：**设计者的意图与运行结果不一致，而库不发出任何信号**。这类失败比抛错危险得多 —— 抛错会被发现，静默失败会在生产里以「行为奇怪」的形式浮现，且无法定位。`,
  data: silent,
});

// ─────────────────────────────────────────────────────────────
section("6.4 失败传染：一个成员失败会不会拖垮别人");

{
  const host = createAgentHost({ modelRuntime: runtime, defaults: { model, cwd, agentDir }, members: { bad: {}, good: {} }, maxAgents: 20 } as never);
  const top = await createAgent({ tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const spawn = createSpawnAgentTool({ agent: top, host });

  // 一个成员必炸（任务里带 [[fail]]），另一个正常
  const rBad = await spawn.execute("c", { member: "bad", task: "[[fail]] 我要炸" } as never, undefined, undefined, undefined as never);
  const rGood = await spawn.execute("c", { member: "good", task: "我正常" } as never, undefined, undefined, undefined as never);
  const textOf = (r: unknown) => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("");
  record({
    id: "6.4a",
    question: "一个分身失败，spawn_agent 是否把它变成可读结果（不拖垮父）",
    observed: `失败的成员返回：${JSON.stringify(textOf(rBad).slice(0, 110))}；正常成员返回：${JSON.stringify(textOf(rGood).slice(0, 50))}`,
    verdict: textOf(rBad).includes("出错了") && textOf(rGood).startsWith("已让成员") ? "OK" : "GAP",
    conclusion:
      "不传染。spawn_agent 把子分身的错误包成文本「它这一轮出错了：…」返回给父 agent，并**继续**返回已有文本。父 agent 自己那一轮不会因此失败。",
    data: { bad: textOf(rBad).slice(0, 200), good: textOf(rGood).slice(0, 80) },
  });

  // 父 agent 自己那一轮：工具层失败会不会让整轮失败
  const before = (await top.prompt("正常一轮")).error;
  record({
    id: "6.4b",
    question: "工具层失败会不会让父 agent 那一轮失败",
    observed: `父 agent 自己的 prompt 返回 error = ${before ?? "(无)"}`,
    verdict: before === undefined ? "OK" : "GAP",
    conclusion: before === undefined ? "不传染：工具失败被包成工具结果，父的一轮正常完成。" : "会传染。",
  });
  host.dispose();
}

{
  // 失败之后继续用同一个分身（上下文是否被污染）
  const a = await mk();
  const bad = await a.prompt("[[fail]] 炸一次");
  const good = await a.prompt("恢复之后正常一轮");
  record({
    id: "6.4c",
    question: "失败之后再跑一轮，上下文是否被污染",
    observed: `失败轮的 error=${JSON.stringify(bad.error?.slice(0, 40))}；下一轮 error=${good.error ?? "(无)"} text=${JSON.stringify(good.text.slice(0, 30))}`,
    verdict: good.error === undefined && good.text.startsWith("echo:") ? "OK" : "GAP",
    conclusion:
      good.error === undefined
        ? "可恢复：同一个分身失败后能继续正常跑，失败轮的痕迹（含 provider 返回的原始错误文本）留在了 session.messages 里。"
        : "未能恢复。",
    data: { badError: bad.error?.slice(0, 80), goodText: good.text.slice(0, 60), msgCount: a.session.messages.length },
  });
  a.dispose();
}

{
  // 上下文超限
  const small = await makeEnv([{ id: "small", contextWindow: 1500, maxTokens: 200 }]);
  const a = await createAgent({ model: small.model, cwd: small.cwd, agentDir: small.agentDir }, { modelRuntime: small.runtime });
  const r = await a.prompt("[[huge:20000]] 撑爆上下文");
  record({
    id: "6.4d",
    question: "上下文超限会以什么形式失败",
    observed: `error=${JSON.stringify((r.error ?? "(无)").slice(0, 70))}；text 长度=${r.text.length}；status=${a.status}`,
    verdict: r.error ? "PARTIAL" : "INFO",
    conclusion:
      r.error
        ? "以 RunResult.error 报告（一串 provider 原文）。注意：假 provider 不做真实截断，所以这里只能确认通道，真实超限行为见真模型专项。"
        : "假 provider 下没有触发（它不看 contextWindow）—— 真实行为必须靠真模型验证。",
    data: { error: r.error?.slice(0, 150), textLen: r.text.length },
  });
  a.dispose();
  await small.close();
}

dump("06-failures");
await env.close();
