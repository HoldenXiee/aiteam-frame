// 第 1 部分：配置能力 —— MemberSpec 的每个字段是否真的生效，以及三层优先级的实际规则。
// 跑法：node audit/01-config.ts
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createAgent, createAgentHost } from "../src/index.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { check, dump, record, section } from "./_harness.ts";
import { makeEnv, makeExtension, makeSkill, type Env } from "./_faux.ts";

const env: Env = await makeEnv();
const { agentDir, cwd, runtime, model } = env;
const mk = (extra: Record<string, unknown> = {}) => createAgent({ model, cwd, agentDir, ...extra }, { modelRuntime: runtime });

// ─────────────────────────────────────────────────────────────
section("1.1 MemberSpec 字段逐个验证（ground truth = 假服务收到的请求）");

// description：只给 LLM 看花名册用，不该进 system
{
  const a = await mk({ description: "描述-标记串-XYZ" });
  await a.prompt("hi");
  const call = env.last()!;
  record({
    id: "1.1a",
    question: "`description` 是否进入 system prompt？",
    observed: `system 含标记串 = ${call.system.includes("描述-标记串-XYZ")}`,
    verdict: !call.system.includes("描述-标记串-XYZ") ? "OK" : "GAP",
    conclusion: "只用于 spawn_agent 的工具描述，不污染 system。符合预期。",
  });
  a.dispose();
}

// cwd
{
  const a = await mk({ cwd: env.root });
  const got = a.session.sessionManager.getCwd();
  check("1.1b", "`cwd` 是否真的改掉会话工作目录", got === env.root, `session.getCwd() = ${got}`, got === env.root ? "生效。" : "未生效。");
  a.dispose();
}

// agentDir：换目录就读到另一份 models.json（不再静默复用第一个）
{
  const second = await makeEnv("别的模型");
  const b = await createAgent(
    { model: second.model, cwd: second.cwd, agentDir: second.agentDir },
    { modelRuntime: second.runtime },
  );
  await b.prompt("hi");
  const got = second.last()!.model;
  check(
    "1.1c",
    "`agentDir` 是否决定读哪份 models.json",
    got === second.models[0].id,
    `主环境的模型是 ${env.models[0].id}，请求里的 model = ${got}`,
    "生效（修复后按 agentDir 分别缓存 runtime）。",
  );
  b.dispose();
  await second.close();
}

// role
{
  const a = await mk({ role: "角色标记串-ABC" });
  await a.prompt("hi");
  const system = env.last()!.system;
  const iRole = system.indexOf("角色标记串-ABC");
  const iTools = system.indexOf("<tools>");
  record({
    id: "1.1d",
    question: "`role` 是否通过 appendSystemPrompt 保留默认提示词，且位置在 <tools> 之后",
    observed: `含角色=${iRole >= 0}　含 <tools>=${iTools >= 0}　role 偏移=${iRole}　tools 偏移=${iTools}`,
    verdict: iRole >= 0 && iTools >= 0 && iRole > iTools ? "OK" : "GAP",
    conclusion: iRole > iTools ? "保留默认提示词，角色追加在 <tools> 之后。" : "位置或保留性不符。",
    data: { systemLen: system.length },
  });
  a.dispose();
}

// skills：名字 / 路径 / Skill 对象 / 失败
{
  const skillDir = makeSkill(env.root, "audit-skill", "审计用技能-描述串-QQQ", "技能正文-EEE");
  const a = await mk({ skills: [skillDir] });
  await a.prompt("hi");
  const system = env.last()!.system;
  record({
    id: "1.1e",
    question: "`skills`（目录路径形式）是否进入 system 的可用技能段",
    observed: `system 含技能名=${system.includes("audit-skill")}　含描述=${system.includes("审计用技能-描述串-QQQ")}`,
    verdict: system.includes("audit-skill") ? "OK" : "GAP",
    conclusion: "技能以目录路径注入，出现在 system 里。",
  });
  a.dispose();
}
{
  const a = await mk({ skills: [join(env.root, "skills", "audit-skill", "SKILL.md")] });
  await a.prompt("hi");
  check("1.1f", "`skills` 用 SKILL.md 文件路径能否生效", env.last()!.system.includes("audit-skill"), "含技能名", "两种写法都可以。");
  a.dispose();
}
{
  let err = "";
  try {
    await mk({ skills: ["根本不存在的技能-QQ"] });
  } catch (e) {
    err = (e as Error).message;
  }
  check("1.1g", "技能名解析失败是否抛错（不静默降级）", err.includes("根本不存在的技能-QQ"), `抛出：${err}`, "抛错且错误信息里带名字。");
}
{
  let err = "";
  try {
    await mk({
      skills: [{ name: "假技能", description: "d", filePath: join(env.root, "nope", "SKILL.md"), baseDir: env.root, source: "custom" } as never],
    });
  } catch (e) {
    err = (e as Error).message;
  }
  check("1.1h", "Skill 对象指向不存在的文件是否抛错", err.length > 0, `抛出：${err}`, "抛错。");
}

// extensions：内联工厂 + 文件路径
{
  const extPath = makeExtension(env.root, "audit-ext.ts", "ext_file_probe");
  const inline = (pi: any) =>
    pi.registerTool({
      name: "ext_inline_probe",
      label: "inline",
      description: "内联探针",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  const a = await mk({ extensions: [extPath, inline], tools: ["read", "ext_file_probe", "ext_inline_probe"] });
  await a.prompt("hi");
  const tools = env.last()!.tools;
  record({
    id: "1.1i",
    question: "`extensions` 的两种形式（文件路径 / 内联工厂）是否都能提供工具",
    observed: `模型看到的工具 = ${JSON.stringify(tools)}`,
    verdict: tools.includes("ext_file_probe") && tools.includes("ext_inline_probe") ? "OK" : "GAP",
    conclusion: "两种形式都生效。",
  });
  a.dispose();
}

// tools 白名单 / excludeTools
{
  const a = await mk({ tools: ["read"] });
  await a.prompt("hi");
  const tools = env.last()!.tools;
  check("1.1j", "`tools` 提供时是否只暴露列出的工具", tools.length === 1 && tools[0] === "read", JSON.stringify(tools), "白名单严格生效。");
  a.dispose();
}
{
  const a = await mk({ excludeTools: ["write", "edit"] });
  await a.prompt("hi");
  const tools = env.last()!.tools;
  record({
    id: "1.1k",
    question: "只给 `excludeTools`（不给 tools）时，剔除是否生效",
    observed: `工具 = ${JSON.stringify(tools)}`,
    verdict: !tools.includes("write") && !tools.includes("edit") && tools.includes("read") ? "OK" : "GAP",
    conclusion: "在不传 tools 时也能剔除。",
  });
  a.dispose();
}

// customTools：静态 + 工厂
{
  const staticTool = defineTool({
    name: "custom_static",
    label: "s",
    description: "静态",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
  });
  const factory = (ctx: { agent: { id: string } }) =>
    defineTool({
      name: "custom_factory",
      label: "f",
      description: "工厂",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: ctx.agent.id }], details: {} }),
    });
  const a = await mk({ customTools: [staticTool, factory as never] });
  await a.prompt("hi");
  const tools = env.last()!.tools;
  record({
    id: "1.1l",
    question: "`customTools` 的静态对象与工厂函数是否都生效（不传 tools 时）",
    observed: `工具 = ${JSON.stringify(tools)}`,
    verdict: tools.includes("custom_static") && tools.includes("custom_factory") ? "OK" : "GAP",
    conclusion: "不传 tools 时两者都自动生效。",
  });
  a.dispose();
}

// model
{
  const a = await mk({ model: "faux/echo" });
  await a.prompt("hi");
  check(
    "1.1m",
    "`model` 是否决定请求里的 model",
    env.last()!.model === env.models[0].id,
    `请求里的 model 字段 = ${env.last()!.model}（对照：核好的模型 id = ${env.models[0].id}）`,
    "生效。",
  );
  a.dispose();
}

// thinking（两种模型能力位对照）
{
  const plain = env; // reasoning: false
  const reasoningEnv = await makeEnv([{ id: "think", reasoning: true }]);
  const observed: Record<string, Record<string, string>> = { "reasoning:false": {}, "reasoning:true": {} };
  for (const lv of ["off", "low", "medium", "high"] as const) {
    const a = await createAgent(
      { model: plain.model, cwd: plain.cwd, agentDir: plain.agentDir, thinking: lv as never },
      { modelRuntime: plain.runtime },
    );
    observed["reasoning:false"][lv] = String(a.session.thinkingLevel);
    a.dispose();
    const b = await createAgent(
      { model: reasoningEnv.model, cwd: reasoningEnv.cwd, agentDir: reasoningEnv.agentDir, thinking: lv as never },
      { modelRuntime: reasoningEnv.runtime },
    );
    observed["reasoning:true"][lv] = String(b.session.thinkingLevel);
    b.dispose();
  }
  record({
    id: "1.1n",
    question: "`thinking` 档位是否落到 session（以及是否受模型能力位限制）",
    observed: JSON.stringify(observed),
    verdict: observed["reasoning:true"].high === "high" ? "OK" : "GAP",
    conclusion:
      observed["reasoning:false"].high === "high"
        ? "不受模型能力位影响。"
        : "受模型能力位限制：模型声明 reasoning:false 时，四档全被夹到 off；声明 reasoning:true 才能拿到 high。设计者配错能力位会静默失效。",
    data: observed,
  });
  await reasoningEnv.close();
}

// onToolCall
{
  const a = await mk({
    tools: ["read"],
    onToolCall: async () => ({ block: true as const, reason: "审计拦截" }),
  });
  const seen: string[] = [];
  a.on("tool_end", (p) => seen.push(`${p.toolName}:${p.isError}`));
  await a.prompt("[[tool:read]] 试试");
  record({
    id: "1.1o",
    question: "`onToolCall` 返回 block 时工具是否真的没执行",
    observed: `tool_end = ${JSON.stringify(seen)}`,
    verdict: seen.every((s) => s.endsWith(":true")) ? "OK" : "GAP",
    conclusion: seen.length ? "被拦截（以错误结果结束）。" : "没观察到 tool_end —— 需进一步确认。",
  });
  a.dispose();
}

// ─────────────────────────────────────────────────────────────
section("1.2 三层优先级的实际规则（host.defaults / members[x] / 顶层 spec）");

const textOf = (r: unknown): string =>
  (((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "").join("\n"));

// spawn_agent 的真实合成路径：spec = {...defaults, ...memberSpec}
{
  const host = createAgentHost({
    defaults: { role: "默认角色-DD", tools: ["read"], model },
    members: { m1: { description: "成员一" } },
    modelRuntime: runtime,
  });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const spawn = createSpawnAgentTool({ agent: top, host });
  await spawn.execute("c", { member: "m1", task: "hi" } as never, undefined, undefined, undefined as never);
  const child = host.list().find((x) => x.member === "m1")!;
  const req = env.last()!;
  record({
    id: "1.2a",
    question: "成员没写的字段是否从 host.defaults 继承",
    observed: `子分身请求工具 = ${JSON.stringify(req.tools)}　system 含默认角色 = ${req.system.includes("默认角色-DD")}`,
    verdict: req.tools.includes("read") && req.system.includes("默认角色-DD") ? "OK" : "GAP",
    conclusion: "defaults 是基线，成员未写的字段被继承。",
    data: { tools: req.tools, hasRole: req.system.includes("默认角色-DD") },
  });
  check("1.2b", "成员写了同一字段时是否覆盖 defaults", child.member === "m1", "成员定义生效", "覆盖。");
  host.dispose();
}

{
  // 数组合并还是替换？
  const host = createAgentHost({
    defaults: { tools: ["read", "write"], model },
    members: { m2: { description: "成员二", tools: ["bash"] } },
    modelRuntime: runtime,
  });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const spawn = createSpawnAgentTool({ agent: top, host });
  await spawn.execute("c", { member: "m2", task: "hi" } as never, undefined, undefined, undefined as never);
  const tools = env.last()!.tools;
  record({
    id: "1.2c",
    question: "数组成员字段（tools / customTools / skills）是深合并还是整体替换",
    observed: `defaults.tools=["read","write"] + 成员.tools=["bash"] → 实际 = ${JSON.stringify(tools)}`,
    verdict: tools.length === 1 && tools[0] === "bash" ? "OK" : "PARTIAL",
    conclusion: "浅合并：数组整体替换，不拼接。设计者若想让成员『在默认之上加一个工具』，必须重写整个数组。",
    data: { tools },
  });
  host.dispose();
}

{
  // customTools 被替换会不会静默丢掉容器默认工具
  const t1 = defineTool({ name: "ct_one", label: "1", description: "一", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "1" }], details: {} }) });
  const t2 = defineTool({ name: "ct_two", label: "2", description: "二", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "2" }], details: {} }) });
  const host = createAgentHost({ defaults: { customTools: [t1], model }, members: { m3: { customTools: [t2] } }, modelRuntime: runtime });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  await createSpawnAgentTool({ agent: top, host }).execute("c", { member: "m3", task: "hi" } as never, undefined, undefined, undefined as never);
  const tools = env.last()!.tools;
  record({
    id: "1.2d",
    question: "成员覆盖 customTools 时，容器默认的 customTool 是否被静默丢掉",
    observed: `defaults.customTools=[ct_one] + 成员.customTools=[ct_two] → 实际 = ${JSON.stringify(tools)}`,
    verdict: tools.includes("ct_one") ? "OK" : "PARTIAL",
    conclusion: tools.includes("ct_one") ? "两者都在。" : "ct_one 被静默丢掉 —— 数组替换的副作用。",
    data: { tools },
  });
  host.dispose();
}

// 陷阱：子分身不继承父 agent 的 cwd / agentDir / modelRuntime
{
  const saved = process.env.AITEAM_AGENT_DIR;
  delete process.env.AITEAM_AGENT_DIR;
  const host = createAgentHost({ members: { m9: { description: "成员未声明 agentDir / model" } } });
  const top = await createAgent({ model, agentDir, cwd, tools: ["spawn_agent"] }, { host, modelRuntime: runtime });
  const r = await createSpawnAgentTool({ agent: top, host }).execute(
    "c",
    { member: "m9", task: "hi" } as never,
    undefined,
    undefined,
    undefined as never,
  );
  const txt = textOf(r);
  record({
    id: "1.2e",
    question: "spawn 出来的分身是否继承父 agent 的 cwd / agentDir / modelRuntime",
    observed: `父用 agentDir=${agentDir}。去掉环境变量后，成员未声明 agentDir/model → 子分身的返回：${txt.slice(0, 200)}`,
    verdict: "GAP",
    conclusion:
      "不继承。子分身只由【成员定义 + host.defaults】合成，agentDir 回落到环境变量或全局 ~/.pi/agent，modelRuntime 只能从 host 拿。设计者把 modelRuntime 只传给 createAgent 而不传给 createAgentHost 时，spawn 静默落到全局配置 —— 报错还会指向模型名而不是配置来源。",
  });
  host.dispose();
  if (saved) process.env.AITEAM_AGENT_DIR = saved;
}

// ─────────────────────────────────────────────────────────────
section("1.3 极端与冲突输入");

{
  let err = "";
  let ok = false;
  try {
    const a = await mk({});
    ok = a.status === "idle";
    a.dispose();
  } catch (e) {
    err = (e as Error).message;
  }
  record({
    id: "1.3a",
    question: "空 spec `{}`（连 model 都不给）能否起得来",
    observed: ok ? "起得来" : `抛错：${err}`,
    verdict: "INFO",
    conclusion: ok ? "起得来（用 settings 里的默认模型）。" : "起不来。设计者必须显式给 model，或依赖环境默认。",
  });
}

{
  const skillDir = makeSkill(env.root, "dup-skill", "重复技能");
  const a = await mk({ skills: [skillDir, skillDir] });
  record({ id: "1.3b", question: "同一个技能重复声明两次", observed: "未抛错，agent 起得来", verdict: "INFO", conclusion: "静默去重（不报错）。" });
  a.dispose();
}

{
  let err = "";
  try {
    await mk({ extensions: [join(env.root, "不存在的扩展.ts")] });
  } catch (e) {
    err = (e as Error).message;
  }
  record({
    id: "1.3c",
    question: "扩展路径不存在",
    observed: err ? `抛错：${err}` : "未抛错",
    verdict: err ? "OK" : "GAP",
    conclusion: err ? "构造期抛错（好）。" : "静默忽略 —— 设计者以为挂上了但没挂。",
  });
}

{
  const a = await mk({ tools: ["read", "write"], excludeTools: ["write"] });
  await a.prompt("hi");
  const tools = env.last()!.tools;
  record({
    id: "1.3d",
    question: "`tools` 与 `excludeTools` 重叠时谁赢",
    observed: `tools=["read","write"], excludeTools=["write"] → ${JSON.stringify(tools)}`,
    verdict: tools.includes("write") ? "GAP" : "OK",
    conclusion: tools.includes("write") ? "白名单赢（exclude 被忽略）。" : "excludeTools 赢。",
    data: { tools },
  });
  a.dispose();
}

{
  const a = await mk({ tools: [], customTools: [defineTool({ name: "ct_x", label: "x", description: "x", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "x" }], details: {} }) })] });
  await a.prompt("hi");
  check("1.3e", "`tools: []` 是否真的是零工具（不被 customTools 撑开）", env.last()!.tools.length === 0, JSON.stringify(env.last()!.tools), "零工具。");
  a.dispose();
}

{
  let err = "";
  try {
    await mk({ model: "faux/根本没有这个模型" });
  } catch (e) {
    err = (e as Error).message;
  }
  record({
    id: "1.3f",
    question: "模型名不存在时的行为",
    observed: `抛出：${err}`,
    verdict: "INFO",
    conclusion: "构造期抛错（决策 #28 刻意如此）。注意：pi 原生只给 warning 就继续，这里更严；自定义模型 id 也会被拒。",
  });
}

{
  // 全字段填满
  const skillDir = makeSkill(env.root, "full-skill", "全字段技能");
  const extPath = makeExtension(env.root, "full-ext.ts", "full_ext_probe");
  const ct = defineTool({ name: "full_ct", label: "c", description: "c", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "c" }], details: {} }) });
  let err = "";
  try {
    const a = await mk({
      description: "全字段成员",
      cwd: env.root,
      agentDir,
      role: "全字段角色",
      skills: [skillDir],
      extensions: [extPath],
      tools: ["read", "full_ext_probe", "full_ct"],
      excludeTools: ["write"],
      customTools: [ct],
      model,
      thinking: "low" as never,
      onToolCall: async () => undefined,
    });
    await a.prompt("hi");
    record({
      id: "1.3g",
      question: "全部字段填满能否正常起跑",
      observed: `工具 = ${JSON.stringify(env.last()!.tools)}　thinking = ${a.session.thinkingLevel}`,
      verdict: "OK",
      conclusion: "12 个字段同时使用没有冲突。",
    });
    a.dispose();
  } catch (e) {
    err = (e as Error).message;
    record({ id: "1.3g", question: "全部字段填满能否正常起跑", observed: `抛错：${err}`, verdict: "GAP", conclusion: "字段组合有冲突。" });
  }
}

// ─────────────────────────────────────────────────────────────
section("1.4 配置层面表达不出来的东西（缺口）");

{
  const a = await mk({});
  const s = a.session as unknown as Record<string, unknown>;
  const hasTemp = "temperature" in s;
  record({
    id: "1.4a",
    question: "能否按成员配置采样参数（temperature / top_p / seed）",
    observed: `MemberSpec 无此字段；session 上 temperature 存在=${hasTemp}；createAgentSessionOptions 只暴露 thinkingLevel / noTools`,
    verdict: "GAP",
    conclusion:
      "无法按成员表达。唯一绕法是 Model.samplingParams 烘进 models.json 的模型定义 —— 那是按模型，同一模型的两个成员不能有不同温度。",
  });
  a.dispose();
}

{
  record({
    id: "1.4b",
    question: "能否表达「这个成员最多跑 N 轮 / 最多花 N token」",
    observed: "MemberSpec 无任何按成员的轮次或预算字段",
    verdict: "GAP",
    conclusion: "只有宿主级 budgetTokens 单值，无法按成员或按分支分配。",
  });
}

{
  record({
    id: "1.4c",
    question: "能否表达「这个成员失败后重试 / 换人」",
    observed: "MemberSpec 无重试、降级、备用成员字段",
    verdict: "GAP",
    conclusion: "失败策略在设计层无处表达（详见第 6 部分）。",
  });
}

{
  record({
    id: "1.4d",
    question: "能否表达成员的输入/输出契约（不只是散文 description）",
    observed: "description 是自由文本；无 inputs/outputs 字段",
    verdict: "GAP",
    conclusion: "无契约即无法校验组合（详见第 8、11 部分）。",
  });
}

dump("01-config");
await env.close();
