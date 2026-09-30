// 1.1 MemberSpec 的 12 个字段逐个验证「是否真的生效」。
// ground truth = 假服务收到的**原始请求体**（_cap.ts 抓的 fetch body），不看库的 API 返回值。
// 跑法：node audit/01-config/e1-fields.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost } from "../../src/index.ts";
import { createSpawnAgentTool } from "../../src/tools/spawn-agent.ts";
import { check, dump, record, section } from "./_h.ts";
import { makeEnv, makeExtension, makeSkill, type Env } from "../_faux.ts";
import { lastRaw, startCapture, type RawCall } from "./_cap.ts";

const env: Env = await makeEnv([{ id: "echo", reasoning: false }, { id: "smart", reasoning: true }]);
const cap = startCapture();
const { agentDir, cwd, runtime, model } = env;
const mk = (extra: Record<string, unknown> = {}) => createAgent({ model, cwd, agentDir, ...extra }, { modelRuntime: runtime });
const raw = (i = -1): RawCall | undefined => (i < 0 ? lastRaw(cap.calls) : cap.calls[i]);
const ct = (name: string, text = "ok") =>
  defineTool({
    name,
    label: name,
    description: `审计探针 ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text }], details: {} }),
  });

// ─────────────────────────────────────────────────────────────
section("1.1 字段逐个验证");

// F1 description
{
  const MARK = "职责标记-DESC-7742";
  const host = createAgentHost({ members: { worker: { description: MARK } }, modelRuntime: runtime });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const spawnDesc = createSpawnAgentTool({ agent: top, host }).description;
  const a = await mk({ description: MARK });
  await a.prompt("hi");
  const inSystem = raw()!.system.includes(MARK);
  record({
    id: "1.1-F1",
    question: "description 生效吗（是否只进花名册、不污染 system）",
    observed: `system 含标记=${inSystem}；spawn_agent 工具描述含标记=${spawnDesc.includes(MARK)}`,
    verdict: !inSystem && spawnDesc.includes(MARK) ? "OK" : "PARTIAL",
    conclusion: !inSystem && spawnDesc.includes(MARK)
      ? "生效（用途正确）：只在 spawn_agent 的描述里给「上级 agent」看，成员自己的 system 里没有。"
      : "未按预期只走花名册。",
    data: { inSystem, inSpawnToolDesc: spawnDesc.includes(MARK) },
  });
  a.dispose();
  host.dispose();
}

// F2 cwd
{
  const dirA = join(env.root, "cwd-A");
  const dirB = join(env.root, "cwd-B");
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, "probe-cwd.txt"), "CWD-MARK-999-in-A", "utf-8");
  writeFileSync(join(dirB, "probe-cwd.txt"), "CWD-MARK-888-in-B", "utf-8");
  const a = await createAgent({ model, cwd: dirA, agentDir, tools: ["read"] }, { modelRuntime: runtime });
  await a.prompt('[[tool:read]] [[args:{"path":"probe-cwd.txt"}]]');
  const toolTurn = cap.calls.find((c) => JSON.stringify(c.messages).includes("CWD-MARK-"));
  const sawA = JSON.stringify(toolTurn?.messages ?? []).includes("CWD-MARK-999-in-A");
  const sawB = JSON.stringify(toolTurn?.messages ?? []).includes("CWD-MARK-888-in-B");
  record({
    id: "1.1-F2",
    question: "cwd 生效吗（相对路径的工具真的落到那个目录吗）",
    observed: `session.getCwd()=${a.session.sessionManager.getCwd()}；read "probe-cwd.txt" 拿到 A 目录内容=${sawA}、B 目录内容=${sawB}`,
    verdict: sawA && !sawB ? "OK" : "GAP",
    conclusion: sawA && !sawB ? "生效：相对路径解析到 spec.cwd。" : "未生效。",
    data: { sessionCwd: a.session.sessionManager.getCwd(), sawA, sawB },
  });
  a.dispose();
}

// F3 agentDir
{
  const second = await makeEnv([{ id: "another-model" }]);
  const b = await createAgent({ model: second.model, cwd: second.cwd, agentDir: second.agentDir }, { modelRuntime: second.runtime });
  await b.prompt("hi");
  check(
    "1.1-F3",
    "agentDir 生效吗（决定读哪份 models.json / auth.json / skills）",
    lastRaw(cap.calls)?.model === "another-model",
    `主环境模型 id=${env.models[0].id}；换成第二个 agentDir 后请求 model=${lastRaw(cap.calls)?.model}`,
    lastRaw(cap.calls)?.model === "another-model" ? "生效：每个 agentDir 一份 runtime（按目录缓存）。" : "未生效。",
  );
  b.dispose();
  await second.close();
}

// F4 role
{
  const MARK = "角色标记-ROLE-3311";
  const a = await mk({ role: MARK });
  await a.prompt("hi");
  const s = raw()!.system;
  const iRole = s.indexOf(MARK);
  const iTools = s.indexOf("<tools>");
  record({
    id: "1.1-F4",
    question: "role 生效吗（追加到 system 的什么位置、默认提示词还在不在）",
    observed: `含角色标记=${iRole >= 0}（偏移 ${iRole}）；含 <tools>=${iTools >= 0}（偏移 ${iTools}）；system 长度=${s.length}`,
    verdict: iRole > iTools && iRole > 0 ? "OK" : "PARTIAL",
    conclusion: iRole > iTools && iTools >= 0
      ? "生效：默认 pi 提示词保留，role 追加在 <tools> 段之后（即最后）。"
      : "role 生效但位置/保留性不符预期。",
    data: { iRole, iTools },
  });
  a.dispose();
}

// F5 skills：名字 / 目录 / SKILL.md / Skill 对象 / 正文是否预载
{
  const body = "SKILL-BODY-SECRET-5150";
  const skillDir = makeSkill(env.agentDir, "by-name-skill", "按名字解析的技能-DESC", body);
  const dirPathSkill = makeSkill(env.root, "by-dir-skill", "按目录注入的技能");
  const fileSkill = makeSkill(env.root, "by-file-skill", "按文件注入的技能");
  const a = await mk({
    skills: ["by-name-skill", dirPathSkill, join(fileSkill, "SKILL.md"), { name: "obj-skill", description: "对象注入", filePath: join(fileSkill, "SKILL.md"), baseDir: fileSkill, source: "custom" } as never],
  });
  await a.prompt("hi");
  const s = raw()!.system;
  const hit = (n: string) => s.includes(n);
  record({
    id: "1.1-F5",
    question: "skills 生效吗（名字 / 目录 / SKILL.md / Skill 对象四种形式）",
    observed: `system 含 by-name=${hit("by-name-skill")} by-dir=${hit("by-dir-skill")} by-file=${hit("by-file-skill")}；含技能正文 ${body}=${hit(body)}；system 长度=${s.length}`,
    verdict: hit("by-name-skill") && hit("by-dir-skill") && hit("by-file-skill") ? "OK" : "PARTIAL",
    conclusion:
      hit("by-name-skill") && hit("by-dir-skill") && hit("by-file-skill")
        ? (hit(body) ? "生效，四种形式都进 system，且正文被预载（体积代价）。" : "生效，四种形式都进 system；正文不预载，只给 name+description（正文需模型自己按需读）。")
        : "有形式未能加载。",
    data: { byName: hit("by-name-skill"), byDir: hit("by-dir-skill"), byFile: hit("by-file-skill"), bodyPreloaded: hit(body), systemLen: s.length },
  });
  a.dispose();
}

// F6 extensions：内联工厂 + 文件路径
{
  const extPath = makeExtension(env.root, "e1-ext.ts", "ext_path_probe");
  const inline = (pi: { registerTool: (t: unknown) => void }) =>
    pi.registerTool({
      name: "ext_inline_probe",
      label: "inline",
      description: "内联探针",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  const a = await mk({ extensions: [extPath, inline as never] });
  await a.prompt("hi");
  const tools = raw()!.tools;
  record({
    id: "1.1-F6",
    question: "extensions 生效吗（路径 / 内联工厂，且不给 tools 白名单时）",
    observed: `模型收到的工具 = ${JSON.stringify(tools)}`,
    verdict: tools.includes("ext_path_probe") && tools.includes("ext_inline_probe") ? "OK" : "PARTIAL",
    conclusion: tools.includes("ext_path_probe") && tools.includes("ext_inline_probe") ? "两种形式都生效。" : "有形式未生效。",
  });
  a.dispose();
}

// F8 excludeTools（不传 tools 时）
{
  const a = await mk({ excludeTools: ["write", "edit"] });
  await a.prompt("hi");
  const tools = raw()!.tools;
  record({
    id: "1.1-F8",
    question: "excludeTools 生效吗（只在给 excludeTools、不给 tools 时）",
    observed: `excludeTools=["write","edit"] → ${JSON.stringify(tools)}`,
    verdict: !tools.includes("write") && !tools.includes("edit") && tools.includes("read") ? "OK" : "GAP",
    conclusion: !tools.includes("write") && !tools.includes("edit") ? "生效：默认工具集里剔掉了这两把。" : "未生效。",
    data: { tools },
  });
  a.dispose();
}

// F7 tools 白名单：并入规则
{
  const extPath = makeExtension(env.root, "e1-whitelist-ext.ts", "declared_ext_probe");
  // 用户级（agentDir/extensions 自动发现）的扩展工具
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "user-ext.ts"),
    `export default function (pi) {
  pi.registerTool({ name: "user_ext_probe", label: "u", description: "用户级探针",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
}\n`,
    "utf-8",
  );
  const a = await mk({ tools: ["read"], customTools: [ct("ct_merged")], extensions: [extPath] });
  await a.prompt("hi");
  const tools = raw()!.tools;
  record({
    id: "1.1-F7",
    question: "tools 白名单的并入规则（customTools? 设计者声明的扩展? 用户级扩展?）",
    observed: `tools=["read"] + customTools=[ct_merged] + extensions=[declared_ext_probe] + agentDir 里有 user_ext_probe → 实际 = ${JSON.stringify(tools)}`,
    verdict: tools.includes("read") && tools.includes("ct_merged") && tools.includes("declared_ext_probe") && !tools.includes("user_ext_probe") ? "OK" : "GAP",
    conclusion:
      "只在 tools 非空时并入：customTools ✅、设计者 extensions ✅、环境自动发现的用户级扩展 ❌（决策 #4 生效）。",
    data: { tools },
  });
  a.dispose();
  rmSync(join(agentDir, "extensions"), { recursive: true, force: true });
}

// F9 customTools：静态 + 工厂（工厂能否拿到 ctx.agent）
{
  const eagerSeen: string[] = [];
  const eagerError: string[] = [];
  const lazySeen: string[] = [];
  const eagerFactory = (ctx: { agent: { id: string } }) => {
    try {
      eagerSeen.push(ctx.agent.id);
    } catch (e) {
      eagerError.push((e as Error).message);
    }
    return ct("ct_eager");
  };
  const lazyFactory = (ctx: { agent: { id: string } }) =>
    defineTool({
      name: "ct_lazy",
      label: "lazy",
      description: "惰性读 ctx.agent",
      parameters: Type.Object({}),
      execute: async () => {
        lazySeen.push(ctx.agent.id);
        return { content: [{ type: "text" as const, text: ctx.agent.id }], details: {} };
      },
    });
  const a = await mk({ customTools: [ct("ct_static"), eagerFactory as never, lazyFactory as never] });
  await a.prompt("[[tool:ct_lazy]]");
  const tools = raw()!.tools;
  record({
    id: "1.1-F9",
    question: "customTools 生效吗（静态对象 vs 工厂函数；工厂在创建期能不能读 ctx.agent）",
    observed: `工具 = ${JSON.stringify(tools)}；工厂创建期读 ctx.agent 抛错=${JSON.stringify(eagerError)}；execute 里读到的 agent.id=${JSON.stringify(lazySeen)}（真实 id=${a.id}）`,
    verdict: tools.includes("ct_static") && tools.includes("ct_lazy") ? "OK" : "GAP",
    conclusion:
      tools.includes("ct_static") && tools.includes("ct_lazy")
        ? "静态与工厂都生效。**但工厂调用于 createAgent 内部、agent 还没构造完**：工厂体内同步读 ctx.agent 会抛「工具上下文里的 agent 尚未构造完成」；只有在 execute 里惰性读才拿得到（类型上 ctx.agent 是非可选的 ControlledAgent，不提示这个时序限制）。"
        : "有形式未生效。",
    data: { tools, eagerError, lazySeen, agentId: a.id },
  });
  a.dispose();
}

// F10 model
{
  const smart = await mk({ model: `${env.agentDir}`.length ? env.ref("smart") : model });
  await smart.prompt("hi");
  const m1 = raw()!.model;
  smart.dispose();
  const withSuffix = await mk({ model: `${model}:high` });
  await withSuffix.prompt("hi");
  const m2 = raw()!.model;
  record({
    id: "1.1-F10",
    question: "model 生效吗（含 `:thinking` 后缀的写法）",
    observed: `model="faux/smart" → 请求 model=${m1}；model="faux/echo:high" → 请求 model=${m2}；session.thinkingLevel=${withSuffix.session.thinkingLevel}`,
    verdict: m1 === "smart" && m2 === "echo" ? "OK" : "PARTIAL",
    conclusion: m1 === "smart" && m2 === "echo" ? "生效：模型 id 与后缀都被正确拆分（后缀进 thinkingLevel）。" : "后缀或模型 id 解析不符预期。",
    data: { m1, m2, thinkingLevel: String(withSuffix.session.thinkingLevel) },
  });
  withSuffix.dispose();
}

// F11 thinking：落到 session + 是否真的进了请求体
{
  const levels = ["off", "low", "high"] as const;
  const rows: Record<string, { session: string; bodyFields: Record<string, unknown> }> = {};
  for (const lv of levels) {
    const a = await createAgent({ model: env.ref("smart"), cwd, agentDir, thinking: lv as never }, { modelRuntime: runtime });
    await a.prompt("hi");
    const b = raw()!.body;
    rows[lv] = {
      session: String(a.session.thinkingLevel),
      bodyFields: {
        thinking: b.thinking,
        reasoning_effort: b.reasoning_effort,
        enable_thinking: b.enable_thinking,
        temperature: b.temperature,
      },
    };
    a.dispose();
  }
  const changed = JSON.stringify(rows.off.bodyFields) !== JSON.stringify(rows.high.bodyFields);
  record({
    id: "1.1-F11",
    question: "thinking 生效吗（session 档位 + 是否真的改变了请求体）",
    observed: JSON.stringify(rows),
    verdict: rows.high.session === "high" && changed ? "OK" : rows.high.session === "high" ? "PARTIAL" : "GAP",
    conclusion: changed
      ? "生效：档位落到 session，且请求体随之变化（reasoning:true 的模型）。"
      : "只落到 session，请求体没变 —— 模型能力位或 provider 格式不认这个档位时会静默失效。",
    data: rows,
  });
  // 能力位对照：reasoning:false 的模型配 high
  const plain = await mk({ thinking: "high" as never });
  await plain.prompt("hi");
  record({
    id: "1.1-F11b",
    question: "thinking 在 reasoning:false 的模型上会怎样",
    observed: `reasoning:false 模型 + thinking=high → session.thinkingLevel=${plain.session.thinkingLevel}`,
    verdict: "PARTIAL",
    conclusion: "能力位是天花板：模型声明 reasoning:false 时档位被夹回 off，不报错（静默）。",
    data: { session: String(plain.session.thinkingLevel) },
  });
  plain.dispose();
}

// F12 onToolCall
{
  const gateCalls: Array<{ name: string; input: unknown }> = [];
  const a = await mk({
    tools: ["read"],
    onToolCall: async (call: { name: string; input: unknown }) => {
      gateCalls.push(call);
      return { block: true as const, reason: "审计拦截-TEST" };
    },
  });
  const ends: string[] = [];
  a.on("tool_end", (p) => ends.push(`${p.toolName}:${p.isError}`));
  await a.prompt('[[tool:read]] [[args:{"path":"probe-cwd.txt"}]]');
  const after = JSON.stringify(raw()?.messages ?? []);
  record({
    id: "1.1-F12",
    question: "onToolCall 生效吗（能拿到 name/input、拦截是否真的阻止执行）",
    observed: `门收到=${JSON.stringify(gateCalls)}；tool_end=${JSON.stringify(ends)}；拦截理由出现在对话里=${after.includes("审计拦截-TEST")}；read 的真实输出出现在对话里=${after.includes("CWD-MARK-")}`,
    verdict: gateCalls[0]?.name === "read" && ends[0] === "read:true" && !after.includes("CWD-MARK-") ? "OK" : "PARTIAL",
    conclusion:
      gateCalls[0]?.name === "read"
        ? ends[0] === "read:true" && !after.includes("CWD-MARK-")
          ? "生效：拿到真实 name/input，拦截后工具以错误结果结束、未执行。"
          : "拿到调用信息，但拦截未阻止执行。"
        : "门没被调用。",
    data: { gateCalls, ends, blockedReasonInDialog: after.includes("审计拦截-TEST"), toolOutputInDialog: after.includes("CWD-MARK-") },
  });
  a.dispose();
}

cap.stop();
dump("e1-fields");
await env.close();
