// 运行期 vs 创建期不对称探针（判据 B：实验室内资源 spec 说了算）。
// 直连库真实入口 lab.createAgent / createLab，本机假 provider，零成本。
// 覆盖 5 个问题：
//   1. 运行期 skills.add / extensions.add 能不能绕过创建期白名单（R48）
//   2. permissions.only/allow/deny 之后，环境自动发现的扩展工具会不会偷偷回来
//   3. tools.add 能不能加白名单外的工具，add 后 active 吗
//   4. context.override / replace / erase 能否改到别的 agent 的上下文
//   5. lab.inspectEnv() 的「实际生效」与某个 agent 实际拿到的会不一致吗
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createLab } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { FAUX_MODEL_REF, makeFauxRuntime } from "../test/faux-models.ts";

process.env.PI_OFFLINE = "1";
const faux = await startFaux();
const { runtime, agentDir, cwd } = await makeFauxRuntime(faux.baseUrl);
const lab = await createLab({ agentDir, cwd, modelNetwork: false, modelRuntime: runtime });

const sentTools = (i?: number) => faux.calls[i ?? faux.calls.length - 1]?.tools ?? [];
const head = (t: string) => console.log(`\n=== ${t} ===`);
const check = (label: string, ok: boolean, detail?: unknown) =>
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail === undefined ? "" : ` —— ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);

function mkSkill(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `probe-${name}-`));
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 探针技能\n---\n\n正文\n`);
  return dir;
}
function extSource(toolName: string): string {
  return `import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool(defineTool({ name: "${toolName}", label: "${toolName}", description: "x",
    parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }));
}
`;
}
function envExt(cwd: string, toolName: string): string {
  const dir = join(cwd, ".pi", "extensions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${toolName}.ts`);
  writeFileSync(file, extSource(toolName));
  return file;
}
function envSkill(cwd: string, name: string): void {
  const dir = join(cwd, ".pi", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 环境技能\n---\n\n正文\n`);
}
function echoTool(name: string): ToolDefinition {
  return defineTool({
    name, label: name, description: "回显",
    parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `echo:${p.text ?? ""}` }], details: {} }),
  });
}

// ── 1. 运行期 add 绕过创建期白名单 ──
head("1. 运行期 skills.add / extensions.add vs 创建期白名单（R48）");
{
  const otherCwd = mkdtempSync(join(tmpdir(), "probe-r48-"));
  envSkill(otherCwd, "env-skill");
  const own = await createLab({ agentDir, cwd: otherCwd, modelNetwork: false, modelRuntime: runtime });
  const a = await own.createAgent({ model: FAUX_MODEL_REF, skills: ["env-skill"], extensions: [] });
  check("前提：spec.skills=[env-skill] 精确白名单，env-skill 在", a.skills.list().some((s) => s.name === "env-skill"));
  // 运行期再加一个环境里就存在但白名单没写的技能
  envSkill(otherCwd, "hidden-skill");
  const b = await own.createAgent({ model: FAUX_MODEL_REF, skills: [], extensions: [] });
  check("前提：hidden-skill 被环境发现但 spec.skills=[] 把它裁掉", !b.skills.list().some((s) => s.name === "hidden-skill"));
  // 现在运行期 add 它 —— 能不能绕过白名单？
  await b.skills.add(join(otherCwd, ".pi", "skills", "hidden-skill"));
  check("运行期 skills.add(路径) 把白名单外的技能放进了 agent", b.skills.list().some((s) => s.name === "hidden-skill"));
  a.dispose(); b.dispose();

  // 扩展版：环境自动发现的环境扩展被白名单裁掉，运行期 add 它的路径能否放回来？
  const extCwd = mkdtempSync(join(tmpdir(), "probe-r48ext-"));
  const envFile = envExt(extCwd, "env_tool_x");
  const own2 = await createLab({ agentDir, cwd: extCwd, modelNetwork: false, modelRuntime: runtime });
  const c = await own2.createAgent({ model: FAUX_MODEL_REF, extensions: [] });
  await c.io.prompt("hi");
  check("前提：spec.extensions=[] 时 env_tool_x 不在声明面", !sentTools().includes("env_tool_x"));
  await c.extensions.add(envFile);
  await c.io.prompt("hi");
  check("运行期 extensions.add(环境发现的扩展路径) 把被白名单裁掉的工具放回了声明面",
    sentTools().includes("env_tool_x"));
  c.dispose();
}

// ── 2. permissions.only/allow/deny 之后环境扩展工具会不会回来 ──
head("2. permissions.only / allow / deny 之后环境自动发现的扩展工具");
{
  const extCwd = mkdtempSync(join(tmpdir(), "probe-perm-"));
  envExt(extCwd, "env_tool_a");
  envExt(extCwd, "env_tool_b");
  const own = await createLab({ agentDir, cwd: extCwd, modelNetwork: false, modelRuntime: runtime });
  const a = await own.createAgent({ model: FAUX_MODEL_REF, permissions: { only: ["read"] } });
  await a.io.prompt("hi");
  check("前提：only=[read] 时环境扩展工具被硬过滤", sentTools().every((t) => t === "read"), sentTools());
  // only 之后 deny(read) + allow([read]) —— 环境扩展工具会不会偷偷回来？
  await a.permissions.deny(["read"]);
  await a.permissions.allow(["read"]);
  await a.io.prompt("hi");
  check("deny(read)+allow([read]) 后环境扩展工具没回来", sentTools().every((t) => t === "read"), sentTools());
  a.dispose();

  // 无白名单：deny 一个内置工具，环境扩展工具应照常
  const b = await own.createAgent({ model: FAUX_MODEL_REF });
  await b.io.prompt("hi");
  check("无白名单时环境扩展工具在（对照）", sentTools().includes("env_tool_a"), sentTools());
  await b.permissions.deny(["bash"]);
  await b.io.prompt("hi");
  check("deny(bash) 后 env_tool_a 仍在（deny 不物化白名单）", sentTools().includes("env_tool_a"), sentTools());
  b.dispose();

  // only 之后 allow 一个**环境扩展注册的**工具名 —— 能不能把它从硬过滤外拉回来？
  const c = await own.createAgent({ model: FAUX_MODEL_REF, permissions: { only: ["read"] } });
  await c.permissions.allow(["env_tool_a"]);
  await c.io.prompt("hi");
  check("only=[read] 后 allow([env_tool_a])：环境扩展工具被拉回来了？（白名单允许，但扩展本身是否被裁？)",
    sentTools().includes("env_tool_a"), sentTools());
  c.dispose();
}

// ── 3. tools.add 加白名单外工具 ──
head("3. tools.add 一个创建期白名单里没有的工具");
{
  const a = await lab.createAgent({ model: FAUX_MODEL_REF, permissions: { only: ["read"] } });
  await a.io.prompt("hi");
  check("前提：only=[read]，模型只看到 read", sentTools().every((t) => t === "read"), sentTools());
  await a.tools.add(echoTool("probe_added"));
  const entry = a.tools.list().find((t) => t.name === "probe_added");
  check("tools.add 后 list() 里 active", entry?.active === true, entry);
  await a.io.prompt("hi");
  check("tools.add 后模型收到了 probe_added", sentTools().includes("probe_added"), sentTools());
  a.dispose();
}

// ── 4. context 面跨 agent ──
head("4. context.override / replace / erase 能否改到别的 agent 的上下文");
{
  const a = await lab.createAgent({ model: FAUX_MODEL_REF });
  const b = await lab.createAgent({ model: FAUX_MODEL_REF });
  await a.io.prompt("[[sleep:200]] A first");
  await b.io.prompt("[[sleep:200]] B first");
  const aHist = a.context.history.length;
  // A 上装 override，B 上提示 —— B 收到的消息应不受 A 的 override 影响
  a.context.override([{ role: "user", content: "OVERRIDE-A" } as never]);
  const before = faux.calls.length;
  await b.io.prompt("B second");
  const bCall = faux.calls[faux.calls.length - 1];
  check("B 的请求里没有 A 的 override 文本", !bCall.messagesText.includes("OVERRIDE-A"), bCall.messagesText.slice(0, 120));
  check("A 的历史条数没变（B 跑轮不影响 A）", a.context.history.length === aHist, { before: aHist, after: a.context.history.length });
  // A 的 entries 能否拿到 B 的 entry id？取 B 的 entry id 在 A 上 replace
  const bEntries = b.context.entries();
  const bId = bEntries[0]?.id;
  let crossErr: string | undefined;
  if (bId) {
    try { await a.context.erase(bId); } catch (e) { crossErr = String(e); }
  }
  check("A 上 erase(B 的 entry id) 被拒（找不到该 entry）", crossErr !== undefined, crossErr?.slice(0, 100));
  check("B 的历史/entries 未被 A 的 erase 动过", b.context.entries().length === bEntries.length,
    { before: bEntries.length, after: b.context.entries().length });
  a.dispose(); b.dispose();
}

// ── 5. inspectEnv 的「实际生效」 vs agent 实际拿到的 ──
head("5. lab.inspectEnv() 报告的 vs 某个 agent 实际拿到的");
{
  const extCwd = mkdtempSync(join(tmpdir(), "probe-env-"));
  envSkill(extCwd, "env-s1");
  envSkill(extCwd, "env-s2");
  const envFileA = envExt(extCwd, "env_tool_p");
  envExt(extCwd, "env_tool_q");
  const own = await createLab({ agentDir, cwd: extCwd, modelNetwork: false, modelRuntime: runtime });
  const report = await own.inspectEnv();
  const a = await own.createAgent({
    model: FAUX_MODEL_REF,
    skills: ["env-s1"],
    extensions: [envFileA],
  });
  const reportSkills = report.skills.filter((s) => s.name.startsWith("env-s")).map((s) => s.name).sort();
  const agentSkills = a.skills.list().filter((s) => s.name.startsWith("env-s")).map((s) => s.name).sort();
  const reportExtTools = report.extensions.filter((e) => e.path.includes("env_tool_")).flatMap((e) => e.tools).sort();
  const agentExtTools = a.extensions.list().filter((e) => e.path.includes("env_tool_")).flatMap((e) => [...e.tools.keys()]).sort();
  console.log(`  inspectEnv 技能: ${JSON.stringify(reportSkills)}`);
  console.log(`  agent 实际技能:  ${JSON.stringify(agentSkills)}`);
  console.log(`  inspectEnv 扩展工具: ${JSON.stringify(reportExtTools)}`);
  console.log(`  agent 实际扩展工具:  ${JSON.stringify(agentExtTools)}`);
  check("不一致：inspectEnv 报了 agent 拿不到的 env-s2", reportSkills.includes("env-s2") && !agentSkills.includes("env-s2"));
  check("不一致：inspectEnv 报了 agent 拿不到的 env_tool_q", reportExtTools.includes("env_tool_q") && !agentExtTools.includes("env_tool_q"));
  check("EnvReport 里没有 withheld 字段（loader.ts §注释 声称有）", !("withheld" in report), Object.keys(report));
  a.dispose();
}

console.log("\n探针结束");
await faux.close();
