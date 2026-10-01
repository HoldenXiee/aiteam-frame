// demo/tour.ts —— 全操控面导览：一个脚本走完这个库所有能被设计者代码操控的面。
// 跑法：npm run demo:tour     （会花真钱，默认用便宜的 opencode-go 模型；TOUR_MODEL 可覆盖）
//
// 章节顺序 = 建议的上手顺序：环境 → 单 agent → 工具/插件 → 审批门 → 事件 → 输入流向 →
// 生命周期 → 花名册与多 agent → 护栏 → 用量对账 → 收尾。
// 运行产物（不清理）：demo/run-output/  下面有 tour.log / report.json / 各 agent 写的文件。
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgent,
  createAgentHost,
  defineAgentTool,
  inspectEnv,
  type Usage,
} from "../src/index.ts";

// ─────────────── 运行产物与日志 ───────────────
const OUT = join(dirname(fileURLToPath(import.meta.url)), "run-output");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "tour.log");
writeFileSync(LOG, "");
const step = { n: 0, fail: 0, note: 0 };

function say(line = ""): void {
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
}
function section(title: string): void {
  step.n += 1;
  say(`\n${"─".repeat(72)}\n${step.n}. ${title}\n${"─".repeat(72)}`);
}
function check(label: string, ok: boolean, detail?: unknown): void {
  if (!ok) step.fail += 1;
  say(`  ${ok ? "✔" : "✘"} ${label}${detail === undefined ? "" : `  →  ${oneLine(detail)}`}`);
}
/** 依赖模型配合的检查：不通过只记一笔，不算失败（模型有自由意志） */
function note(label: string, detail?: unknown): void {
  step.note += 1;
  say(`  · ${label}${detail === undefined ? "" : `  →  ${oneLine(detail)}`}`);
}
const oneLine = (v: unknown, n = 200): string => String(v).replace(/\s+/g, " ").slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 全程花费统计：每个分身每跑完一轮就把 done 事件的用量记下来 */
const spent = { tokens: 0, cost: 0 };
function track<T extends { on: (e: "done", fn: (p: { usage: Usage }) => void) => unknown }>(agent: T): T {
  agent.on("done", ({ usage }) => {
    spent.tokens += usage.totalTokens;
    spent.cost += usage.cost.total;
  });
  return agent;
}
/** 建 agent + 记账：导览里推荐的写法就是「拿到 agent 后立刻挂上你的观测」 */
const makeAgent: typeof createAgent = async (spec, deps) => track(await createAgent(spec, deps));

/** 路径归一：审批门和沙箱式判断必须比绝对路径，否则模型的相对路径会全被误判 */
const normPath = (p: string, base: string): string =>
  (p.startsWith("/") || /^[A-Za-z]:/.test(p) ? p : join(base, p)).replace(/\\/g, "/").toLowerCase();

// ─────────────── 自建环境（不用本机 pi 的设置）───────────────
// 一个目录只放：auth.json（凭证）+ skills/；models.json 都可以不要（opencode-go 是内置 provider）。
const MODEL = process.env.TOUR_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const CHEAP = process.env.TOUR_MODEL_CHEAP ?? "opencode-go/qwen3.8-flash";
const envDir = process.env.TOUR_ENV_DIR ?? join(homedir(), ".aiteam-tour-env");
mkdirSync(join(envDir, "skills"), { recursive: true });
const authPath = join(envDir, "auth.json");
if (!existsSync(authPath)) {
  const from = join(getAgentDir(), "auth.json");
  if (!existsSync(from)) throw new Error(`本机没有 ${from}，无法为自建环境准备凭证`);
  copyFileSync(from, authPath);
}
const skillDir = join(envDir, "skills", "tour-skill");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: tour-skill\ndescription: 被问到技能时回一句：技能生效\n---\n\n被问到时回答「技能生效」。\n`,
  "utf-8",
);

const ENV = { agentDir: envDir, cwd: OUT, modelNetwork: true, skills: ["tour-skill"] };

say(`全操控面导览 —— 模型 ${MODEL} / ${CHEAP}`);
say(`自建环境 ${envDir}（本机 pi 目录 ${getAgentDir()} 不参与）`);

// ═══════════════ 1. 环境：先看清楚再建 agent ═══════════════
section("环境自检 inspectEnv —— 建 agent 之前先看这套环境里实际生效了什么");
{
  const env = await inspectEnv(ENV);
  say(`  agentDir=${env.agentDir}`);
  say(`  cwd=${env.cwd}`);
  say(`  技能：${env.skills.map((s) => `${s.name}(${s.scope})`).join("、") || "(无)"}`);
  say(`  插件：${env.extensions.map((e) => `${e.path}[tools=${e.tools.join(",")}]`).join("、") || "(无)"}`);
  say(`  上下文文件：${env.contextFiles.join("、") || "(无)"}`);
  const go = env.models.find((m) => m.provider === "opencode-go");
  say(`  可用模型：${go ? `${go.available.length}/${go.total}（opencode-go）` : "(无)"}`);
  say(`  警告：${env.warnings.join(" | ") || "(无)"}`);

  check("技能来自自建环境", env.skills.some((s) => s.name === "tour-skill" && s.filePath.startsWith(envDir)));
  check("没有本机 pi 的技能混进来", !env.skills.some((s) => !s.filePath.startsWith(envDir)));
  check("目标模型可用", !!go?.available.includes(MODEL.split("/")[1]));
  note("上下文文件跟着 cwd 走（库不管这一项）：" + (env.contextFiles.join("、") || "(无)"));
}

// ═══════════════ 2. 最小 agent：prompt → RunResult ═══════════════
section("最小 agent —— prompt 一个任务，拿回 RunResult { text, usage }");
const factsPath = join(OUT, "facts.txt");
writeFileSync(factsPath, "库的名字叫 aiteam\n", "utf-8");
{
  const agent = await makeAgent({
    ...ENV,
    id: "minimal",
    model: MODEL,
    role: "你是执行者，回答尽量短。",
    tools: ["read"],
  });
  const result = await agent.prompt(`用 read 读 ${factsPath}，然后只回一行：文件内容 + 「」+ 你技能要求你说的话。`);
  say(`  回复：${oneLine(result.text)}`);
  say(`  本轮 usage=${result.usage.totalTokens} tokens, $${result.usage.cost.total.toFixed(6)}`);
  check("拿到了文本", result.text.length > 0);
  check("本次用量已回传", result.usage.totalTokens > 0);
  check("没有静默错误", result.error === undefined, result.error);
  check("lastResult 与本次结果一致", agent.lastResult?.text === result.text);
  agent.dispose();
}

// ═══════════════ 3. 工具与插件：customTools（工厂式）+ 内联扩展 ═══════════════
section("工具与插件 —— defineAgentTool 拿得到 ctx.agent / ctx.host；插件可以是内联工厂");
{
  // 工厂式工具：execute 里能看见「是谁在调用我」以及「宿主里都有谁」
  const reportSelf = defineAgentTool({
    name: "report_self",
    label: "Report Self",
    description: "上报调用者的身份：id / member / 状态 / 累计用量 / 宿主里存活的分身",
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      const text = JSON.stringify({
        id: ctx.agent.id,
        member: ctx.agent.member ?? "(顶层)",
        status: ctx.agent.status,
        tokens: ctx.agent.usage.totalTokens,
        alive: ctx.host?.list().map((a) => a.id) ?? [],
      });
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // 插件（内联扩展）：注册一个工具 + 一个 tool_call 钩子，不需要落盘成文件
  const hooks: string[] = [];
  const inlinePlugin = (pi: any) => {
    pi.registerTool({
      name: "utc_now",
      label: "UTC Now",
      description: "返回当前 UTC 时间",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text" as const, text: new Date().toISOString() }], details: {} }),
    });
    pi.on("tool_call", (event: any) => {
      hooks.push(event.toolName);
    });
  };

  const host = createAgentHost({ members: {} });

  const agent = await makeAgent(
    {
      ...ENV,
      id: "toolsmith",
      model: MODEL,
      role: "你按指令调用工具，不要解释。",
      tools: ["report_self", "utc_now"],
      customTools: [reportSelf],
      extensions: [inlinePlugin],
    },
    { host },
  );
  const result = await agent.prompt("先调用 report_self，再调用 utc_now，然后把两个结果原样写在一行里。");
  say(`  回复：${oneLine(result.text)}`);
  check("工厂式工具被调用到了", hooks.includes("report_self"), hooks);
  check("插件注册的工具被调用到了", hooks.includes("utc_now"), hooks);
  check("插件钩子也生效了", hooks.length >= 2);
  agent.dispose();
  host.dispose();
}

// ═══════════════ 4. 审批门 + 事件订阅 ═══════════════
section("审批门 onToolCall + 事件订阅 —— 拦截、放行、以及 7 个归一化事件");
{
  const decisions: Array<{ tool: string; input: unknown; block: boolean; reason?: string }> = [];
  const events = new Map<string, number>();
  const samples: string[] = [];

  const agent = await makeAgent({
    ...ENV,
    id: "gated",
    model: MODEL,
    role: "你按指令干活，回答尽量短。",
    tools: ["write", "read"],
    // 审批门：拦住 OUT 目录之外的写。注意路径要归一化再比 —— 模型经常给相对路径
    onToolCall: async ({ name, input }) => {
      const raw = String((input as { path?: string }).path ?? "");
      const outside = name === "write" && raw !== "" && !normPath(raw, OUT).startsWith(normPath(OUT, OUT));
      decisions.push({
        tool: name,
        input,
        block: outside,
        ...(outside ? { reason: "只允许写 demo/run-output/" } : {}),
      });
      return outside ? { block: true, reason: "只允许写 demo/run-output/ 目录内的文件" } : undefined;
    },
  });

  for (const type of ["text", "thinking", "tool_start", "tool_end", "turn", "error", "done"] as const) {
    events.set(type, 0);
  }
  agent.on("text", ({ delta }) => events.set("text", (events.get("text") ?? 0) + delta.length));
  for (const type of ["thinking", "tool_start", "tool_end", "turn", "error", "done"] as const) {
    agent.on(type, (payload: any) => {
      events.set(type, (events.get(type) ?? 0) + 1);
      if (samples.length < 4 && type !== "thinking") samples.push(`${type}: ${oneLine(JSON.stringify(payload), 90)}`);
    });
  }

  const result = await agent.prompt(
    `分两步做，不要跳步：\n` +
      `1) 用 write 把 "越界" 写到 C:/windows-temp-outside.txt（允许被拒，拒绝后不要重试）\n` +
      `2) 用 write 把 "合规" 写到 ${join(OUT, "gated.txt")}\n` +
      `最后只回一行：两次的结果。`,
  );
  say(`  回复：${oneLine(result.text)}`);
  say(`  审批门收到的输入：${decisions.map((d) => oneLine(JSON.stringify(d.input), 70)).join(" | ") || "(无)"}`);
  say(`  审批门决策：${decisions.map((d) => `${d.tool}${d.block ? "(拦截)" : "(放行)"}`).join("、") || "(无工具调用)"}`);
  say(`  事件计数：${[...events].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  say(`  事件样本：\n    ${samples.join("\n    ")}`);

  check("审批门记录了决策", decisions.length > 0, decisions.length);
  check("至少拦过一次越界写", decisions.some((d) => d.block));
  check("tool_start / tool_end 成对出现", events.get("tool_start") === events.get("tool_end"));
  check("turn / done 各至少一次", (events.get("turn") ?? 0) > 0 && (events.get("done") ?? 0) > 0);
  check("合规文件写出来了", existsSync(join(OUT, "gated.txt")) && readFileSync(join(OUT, "gated.txt"), "utf-8").includes("合规"));
  agent.dispose();
}

// ═══════════════ 5. 输入流向：send / steer / waitForIdle ═══════════════
section("输入流向 —— send 忙时排队永不抛错；steer 立刻改向；waitForIdle 等它静下来");
{
  const agent = await makeAgent({ ...ENV, id: "flow", model: MODEL, role: "回答尽量短。", tools: [] });

  const r1 = await agent.prompt("只回两个字：收到");
  say(`  第一次 prompt：${oneLine(r1.text)}`);

  // 空闲时 send = 直接跑，但**不 await**（await 了就把 send 变成同步 ask，会引死锁）
  const a = await agent.send("只回两个字：甲");
  const b = await agent.send("只回两个字：乙");
  say(`  send 返回：${a.delivered} / ${b.delivered}`);
  check("空闲时 send 报 ran", a.delivered === "ran");
  check("紧接着的第二次 send 报 queued（目标正忙）", b.delivered === "queued");
  await agent.waitForIdle();
  say(`  waitForIdle 后 lastResult：${oneLine(agent.lastResult?.text)}`);

  // steer：跑一个长活，中途插话改变方向
  const long = agent.prompt("从 1 数到 300，每行一个数字，中间不要停。");
  await sleep(1500);
  await agent.steer("停，不要数了，只回一行：已打断");
  const steered = await long;
  note("steer 是否真的打断了这一轮（取决于模型速度，不算失败）", oneLine(steered.text, 60));
  if (steered.text.includes("已打断")) say("  （这一轮被成功改向）");
  agent.dispose();
}

// ═══════════════ 6. 生命周期：abort 与恢复 ═══════════════
section("生命周期 —— abort 一轮，再确认这个分身还能继续用");
{
  const agent = await makeAgent({ ...ENV, id: "abortable", model: MODEL, role: "回答尽量短。", tools: [] });
  const running = agent.prompt("把《静夜思》逐字拆开，每个字一行，写 200 行。");
  await sleep(1200);
  await agent.abort();
  const aborted = await running;
  say(`  abort 后 status=${agent.status}，本轮文本长度=${aborted.text.length}`);
  check("abort 后 status 是 aborted", agent.status === "aborted");

  const after = await agent.prompt("只回两个字：还在");
  say(`  中止之后再 prompt：${oneLine(after.text)}`);
  check("被 abort 的分身还能继续用", after.text.length > 0);
  agent.dispose();
}

// ═══════════════ 7. 花名册与多 agent：spawn_agent / send_message / 共享黑板 ═══════════════
section("花名册与多 agent —— agent 只能从花名册挑人，不能自己设计 agent");
{
  const rounds = new Map<string, number>();
  const created: string[] = [];

  const host = createAgentHost({
    // defaults 是所有成员的基线，被成员覆盖（优先级 defaults ← members[x] ← 顶层 spec）
    defaults: { ...ENV, model: CHEAP },
    members: {
      scout: {
        description: "侦察员：把要点写进黑板文件，工具是 read/write",
        role: "你只写文件，回复一行确认。",
        model: MODEL,
        tools: ["read", "write"],
      },
      checker: {
        description: "核对员：读黑板文件，回复一行结论",
        role: "你只读文件并回一行结论。",
        tools: ["read"],
      },
    },
    maxAgents: 8,
    maxDepth: 2,
    budgetTokens: 300_000,
  });

  host.on("agent_created", ({ agent, member }) => {
    created.push(`${member ?? "顶层"}:${agent.id}`);
    say(`  · 分身就位 ${member ?? "顶层"} ${agent.id}`);
  });
  host.on("round_completed", ({ agent, result }) => {
    rounds.set(agent.id, (rounds.get(agent.id) ?? 0) + 1);
    say(`  · ${agent.member ?? "顶层"}(${agent.id}) 跑完一轮 +${result.usage.totalTokens} tokens`);
  });
  host.on("agent_disposed", ({ agent }) => say(`  · 分身回收 ${agent.id}`));

  const lead = await makeAgent(
    {
      ...ENV,
      id: "lead",
      model: MODEL,
      role: "你是主持人：用 spawn_agent 挑成员派活，用 send_message 追加消息。派活时把绝对路径写清楚，每轮最多调用一次 spawn_agent。",
      tools: ["spawn_agent", "send_message"],
    },
    { host, member: "lead" },
  );

  const board = join(OUT, "blackboard.md");
  await lead.prompt(
    `用 spawn_agent 让 scout 把三条要点写进 ${board}（每条一行，以 - 开头）。`,
  );
  const scout = host.list().find((a) => a.member === "scout");
  check("spawn_agent 真的起了 scout 分身", !!scout, created.join(" "));
  check("黑板文件已写出", existsSync(board), existsSync(board) ? readFileSync(board, "utf-8").split("\n").length + " 行" : "缺");

  await lead.prompt(`用 spawn_agent 让 checker 读 ${board}，回一行结论。`);
  const checker = host.list().find((a) => a.member === "checker");
  check("spawn_agent 能起第二种成员", !!checker);

  // send_message：只准投给自己的后代。id 由设计者给出（agent 自己也知道，spawn 返回值里带着）
  if (scout) {
    const before = rounds.get(scout.id) ?? 0;
    await lead.prompt(`用 send_message 给 ${scout.id} 追加一句：在 ${board} 末尾补一行「- 追加：由 send_message 触发」。`);
    await scout.waitForIdle();
    const after = rounds.get(scout.id) ?? 0;
    check("send_message 追加的那一轮确实跑了（分身被复用，不是新建的）", after > before, `${before} → ${after}`);
    note("scout 最后一轮回复", oneLine(scout.lastResult?.text, 80));
  }

  // 跨分支投递是禁止的：checker 想给 scout 发消息，工具里根本没有这条通路（send_message 只认自己的后代）
  check("分身与成员归属可读", host.list().every((a) => a.member !== undefined || a.id === "lead"));
  check("宿主统计：存活分身数", host.activeCount >= 3, host.activeCount);

  host.dispose();
  check("host.dispose() 级联回收", host.activeCount === 0);
}

// ═══════════════ 8. 护栏：三道全在，触发时给文本而不是崩 ═══════════════
section("护栏 —— maxAgents / maxDepth / budgetTokens（这里直接踩，不花模型钱）");
{
  // budgetTokens：预算已耗尽时 createAgent 就直接拒绝
  const noBudget = createAgentHost({ budgetTokens: 0 });
  let budgetMsg = "";
  try {
    await createAgent({ ...ENV, model: MODEL }, { host: noBudget });
  } catch (err) {
    budgetMsg = String(err instanceof Error ? err.message : err);
  }
  check("预算耗尽在创建时就被拦住", /预算/.test(budgetMsg), budgetMsg);

  // maxAgents：终身累计，回收也不减
  const tiny = createAgentHost({ maxAgents: 1 });
  const first = await createAgent({ ...ENV, model: MODEL }, { host: tiny });
  let agentMsg = "";
  try {
    await createAgent({ ...ENV, model: MODEL }, { host: tiny });
  } catch (err) {
    agentMsg = String(err instanceof Error ? err.message : err);
  }
  check("超过 maxAgents 被拦住", /maxAgents/.test(agentMsg), agentMsg);

  // maxDepth：深度由 parent 链推出，不作为参数传入（可伪造的参数等于没有护栏）
  const shallow = createAgentHost({ maxDepth: 0 });
  const root = await createAgent({ ...ENV, model: MODEL }, { host: shallow });
  let depthMsg = "";
  try {
    await createAgent({ ...ENV, model: MODEL }, { host: shallow, parent: root });
  } catch (err) {
    depthMsg = String(err instanceof Error ? err.message : err);
  }
  check("超过 maxDepth 被拦住", /深度/.test(depthMsg), depthMsg);

  // 同一个护栏在 agent 手里是「返回文本」，不是异常 —— agent 有机会换策略
  const spawned = await createAgent(
    { ...ENV, model: MODEL, role: "把指令原样交给工具，不要解释。", tools: ["spawn_agent"] },
    { host: createAgentHost({ maxDepth: 0, members: { any: { description: "随便一个成员" } } }) },
  );
  const res = await spawned.prompt("用 spawn_agent 挑成员 any 做点事。");
  note("agent 侧收到的是文本而不是异常", oneLine(res.text, 120));
  spawned.dispose();
  noBudget.dispose();
  tiny.dispose();
  shallow.dispose();
}

// ═══════════════ 9. 用量与归属 ═══════════════
section("用量对账与归属 —— agent.usage 累计 / RunResult.usage 本次 / host.usage 全宿主");
{
  const host = createAgentHost({ members: { tiny: { description: "小工", model: CHEAP, tools: [] } } });
  let hostRounds = 0;
  host.on("round_completed", () => (hostRounds += 1));

  const a = await makeAgent(
    { ...ENV, id: "acc-a", model: MODEL, role: "回答尽量短。", tools: ["spawn_agent"] },
    { host },
  );
  const r1 = await a.prompt("只回两个字：甲");
  const r2 = await a.prompt("只回两个字：乙");
  const r3 = await a.prompt("用 spawn_agent 挑成员 tiny，只回两个字：丙");

  say(`  r1=${r1.usage.totalTokens} r2=${r2.usage.totalTokens} r3=${r3.usage.totalTokens}｜agent.usage=${a.usage.totalTokens}`);
  check(
    "agent.usage = 它自己各次 RunResult 之和（不含子分身）",
    a.usage.totalTokens === r1.usage.totalTokens + r2.usage.totalTokens + r3.usage.totalTokens,
  );
  check("host.usage 把这棵树上所有分身的用量加在一起", host.usage.totalTokens > a.usage.totalTokens, `宿主 ${host.usage.totalTokens} vs 顶层 ${a.usage.totalTokens}`);
  check("每个分身都能报出自己的归属", a.parentId === undefined && a.member === undefined);
  say(`  宿主累计 ${host.usage.totalTokens} tokens，$${host.usage.cost.total.toFixed(6)}，共 ${hostRounds} 轮`);
  host.dispose();
}

// ═══════════════ 10. 收尾：产物落盘 ═══════════════
section("收尾 —— 产物落盘，日志与报告留在 demo/run-output/");
{
  const report = {
    model: MODEL,
    cheapModel: CHEAP,
    envDir,
    outDir: OUT,
    spent: { tokens: spent.tokens, usd: Number(spent.cost.toFixed(6)) },
    checks: { total: step.n, failed: step.fail, softNotes: step.note },
    files: ["tour.log", "report.json", "facts.txt", "gated.txt", "blackboard.md"],
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2), "utf-8");
  say(`  报告：${join(OUT, "report.json")}`);
  say(`  日志：${LOG}`);
  say(`  全程花费：${spent.tokens} tokens，$${spent.cost.toFixed(6)}`);
  say(`\n结果：${step.fail === 0 ? "全部硬检查通过" : `${step.fail} 项硬检查失败`}（另有 ${step.note} 项软提示需人工看一眼）`);
  process.exit(step.fail === 0 ? 0 : 1);
}
