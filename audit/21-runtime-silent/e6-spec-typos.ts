// E6：MemberSpec 每个字段都写错一遍 —— 哪些「构造成功但行为不符预期」？
// 每组都打印：构造结果 / 模型实际收到的工具（假服务 ground truth）/ system prompt 里的标记 / 门有没有被调用。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../../src/index.ts";
import { makeEnv2 } from "./_srv.ts";
import { save } from "./_data.ts";

const env = await makeEnv2();
const envR = await makeEnv2("thinky", { reasoning: true }); // 另起一个声明 reasoning:true 的模型环境
const ROLE = "ROLE-MARKER-123";
const rows: any[] = [];

const echoTool = defineTool({
  name: "probe_echo",
  label: "Probe Echo",
  description: "回显",
  parameters: Type.Object({ text: Type.Optional(Type.String()) }),
  execute: async (_id: string, p: any) => ({ content: [{ type: "text" as const, text: `ran:${p.text ?? ""}` }], details: {} }),
});
const echoTool2 = defineTool({
  name: "probe_echo",
  label: "另一个同名工具",
  description: "同名覆盖测试",
  parameters: Type.Object({ text: Type.Optional(Type.String()) }),
  execute: async (_id: string, p: any) => ({ content: [{ type: "text" as const, text: `OVERRIDDEN:${p.text ?? ""}` }], details: {} }),
});
for (const [name, desc] of [["magic-marker", "魔法标记技能"], ["other-skill", "另一个技能"]]) {
  const d = join(env.agentDir, "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文\n`, "utf-8");
}
mkdirSync(join(env.cwd, "sub"), { recursive: true });
writeFileSync(join(env.cwd, "a-file.txt"), "我是一个文件，不是目录", "utf-8");

/** 测一组 spec。base 里放「对照组」字段，extra 覆盖它 */
async function run(label: string, extra: any, prompt = "hi", base: any = {}) {
  const spec = { model: env.model, cwd: env.cwd, agentDir: env.agentDir, role: ROLE, ...base, ...extra };
  const from = env.srv.calls.length;
  let a: any;
  try {
    a = await createAgent(spec, { modelRuntime: env.runtime });
  } catch (e: any) {
    rows.push({ label, spec: JSON.stringify(extra), 构造: `throw:${e.message}` });
    console.log(`  ▶ ${label}\n      构造 throw: ${e.message}`);
    return;
  }
  let outcome: any;
  try {
    const r = await a.prompt(prompt);
    outcome = { text: r.text.slice(0, 120), error: r.error ?? null };
  } catch (e: any) {
    outcome = { throw: e.message };
  }
  const calls = env.srv.calls.slice(from);
  const sys = calls[0]?.system ?? "";
  const row = {
    label,
    spec: JSON.stringify(extra),
    构造: "成功",
    模型看到的工具: calls[0]?.tools ?? null,
    请求次数: calls.length,
    outcome,
    role在system里: sys.includes(ROLE),
    system里有magic: /magic-marker/.test(sys),
    thinking档位: a.session.thinkingLevel,
    status: a.status,
  };
  rows.push(row);
  console.log(`  ▶ ${label}\n      工具=${JSON.stringify(row.模型看到的工具)} role=${row.role在system里} magic=${row.system里有magic} thinking=${row.thinking档位} ` + `结果=${JSON.stringify(outcome).slice(0, 160)}`);
  a.dispose();
}

console.log("═══ A 对照组 ═══");
await run("A1 不给 tools（默认工具集）", {}, "hi", {});
await run("A2 tools:['read','probe_echo'] + customTools", { tools: ["read", "probe_echo"], customTools: [echoTool] });
await run("A3 excludeTools:['probe_echo']（写对）", { tools: ["read", "probe_echo"], customTools: [echoTool], excludeTools: ["probe_echo"] });
await run("A4 skills:['magic-marker']（写对）", { skills: ["magic-marker"] });
await run("A5 不写 role（role 标记应当缺席）", {}, "hi", { role: undefined });

console.log("\n═══ B 键名写错（多余字段静默忽略）═══");
await run("B1 descriptoin（少 e）", { descriptoin: "描述" } as any);
await run("B2 tool（少 s）", { tool: ["read"] } as any, "hi", {});
await run("B3 excludeTool（少 s）", { tool: ["read"], excludeTool: ["read"] } as any, "hi", {});
await run("B4 onToolcall（大小写）", { onToolcall: async () => ({ block: true }) } as any);
await run("B5 systemPrompt（不存在的键）", { systemPrompt: "SECRET-OVERRIDE" } as any);
await run("B6 Skills（大写 S）", { Skills: ["magic-marker"] } as any);

console.log("\n═══ C 工具白名单写法错（base 不含 customTools，避免被强制并入掩盖）═══");
await run("C1 tools:['read']（写对）", { tools: ["read"] }, "hi", {});
await run("C2 tools:['Read']（大写）", { tools: ["Read"] }, "hi", {});
await run("C3 tools:['read ',' read']（空格）", { tools: ["read ", " read"] }, "hi", {});
await run("C4 tools:'read'（字符串而非数组）", { tools: "read" } as any, "hi", {});
await run("C5 tools:[] （一个都不给）", { tools: [] }, "hi", {});
await run("C6 excludeTools:[' read']（前空格）", { tools: ["read", "bash"], excludeTools: [" read"] }, "hi", {});
await run("C7 excludeTools:['BASH']（大写）", { tools: ["read", "bash"], excludeTools: ["BASH"] }, "hi", {});

console.log("\n═══ D customTools 同名 / 不该出现的组合 ═══");
{
  const from = env.srv.calls.length;
  const a = await createAgent({ model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["probe_echo"], customTools: [echoTool, echoTool2] }, { modelRuntime: env.runtime });
  const r = await a.prompt('[[tool:probe_echo]] [[args:{"text":"T"}]]');
  rows.push({ label: "D1 customTools 里两个同名 probe_echo", 模型看到的工具: env.srv.calls[from].tools, outcome: r.text });
  console.log(`  ▶ D1 两个同名 customTool → 工具=${JSON.stringify(env.srv.calls[from].tools)} 调用结果=${r.text}`);
  a.dispose();
}
await run("D2 customTool 冒充内置 read（对照）", { tools: ["read"], customTools: [{ ...echoTool, name: "read", label: "read" }] }, '[[tool:read]] [[args:{"text":"T"}]]');

console.log("\n═══ E cwd / agentDir 写错 ═══");
await run("E1 cwd 指向一个文件", { cwd: join(env.cwd, "a-file.txt") });
await run("E2 cwd 末尾反斜杠", { cwd: env.cwd.replace(/\//g, "\\") + "\\" });
await run("E3 cwd 正斜杠", { cwd: env.cwd.replace(/\\/g, "/") });
await run("E4 cwd 不存在的目录", { cwd: join(env.cwd, "no-such-dir") });
await run("E5 agentDir 指向一个文件", { agentDir: join(env.agentDir, "models.json") });

console.log("\n═══ F skills 写法错 ═══");
await run("F1 skills:['other-skill']（已存在但没声明 magic-marker）", { skills: ["other-skill"] });
await run("F2 skills:['Magic-Marker']（大小写）", { skills: ["Magic-Marker"] });
await run("F3 skills:['magic_marker']（下划线）", { skills: ["magic_marker"] });
await run("F4 skills:'magic-marker'（字符串）", { skills: "magic-marker" } as any);
await run("F5 skills:['magic-marker ']（尾空格）", { skills: ["magic-marker "] });
await run("F6 skills:['magic-marker','magic-marker']（重复）", { skills: ["magic-marker", "magic-marker"] });

console.log("\n═══ G model / thinking 写法错 ═══");
await run("G1 model:'faux/ECHO'（大写）", { model: "faux/ECHO" });
await run("G2 model:'faux/echo '（尾空格）", { model: "faux/echo " });
await run("G3 thinking:'High'（大写，模型不支持 reasoning）", { thinking: "High" } as any);
await run("G4 thinking:'none'（非法档位）", { thinking: "none" } as any);
await run("G5 thinking:'低'（中文）", { thinking: "低" } as any);
{
  // reasoning:true 的模型上再测一遍档位
  const cases: any[] = [["H1 thinking:'high'（写对）", "high"], ["H2 thinking:'High'", "High"], ["H3 thinking:'none'", "none"], ["H4 thinking:'低'", "低"], ["H5 thinking:'ultra'", "ultra"]];
  for (const [label, th] of cases) {
    try {
      const a = await createAgent({ model: envR.model, cwd: envR.cwd, agentDir: envR.agentDir, thinking: th }, { modelRuntime: envR.runtime });
      rows.push({ label, spec: JSON.stringify({ thinking: th }), 构造: "成功", thinking档位: a.session.thinkingLevel });
      console.log(`  ▶ ${label} → 构造成功，session.thinkingLevel=${a.session.thinkingLevel}`);
      a.dispose();
    } catch (e: any) {
      rows.push({ label, spec: JSON.stringify({ thinking: th }), 构造: `throw:${e.message}` });
      console.log(`  ▶ ${label} → 构造 throw: ${e.message}`);
    }
  }
}

console.log("\n═══ H 审批门键名 ═══");
for (const [label, key] of [["I1 onToolCall（写对）", "onToolCall"], ["I2 onToolcall（大小写错）", "onToolcall"], ["I3 OnToolCall（首字母大写）", "OnToolCall"]] as const) {
  const gateLog: string[] = [];
  const a = await createAgent(
    { model: env.model, cwd: env.cwd, agentDir: env.agentDir, tools: ["probe_echo"], customTools: [echoTool], [key]: async (c: any) => { gateLog.push(c.name); return { block: true, reason: "门说不行" }; } } as any,
    { modelRuntime: env.runtime },
  );
  const r = await a.prompt('[[tool:probe_echo]] [[args:{"text":"T"}]]');
  rows.push({ label, 门被调用: gateLog, outcome: r.text });
  console.log(`  ▶ ${label} → 门被调用=${JSON.stringify(gateLog)}，工具结果=${r.text}`);
  a.dispose();
}

console.log("\n═══ J cwd 写错时，文件类工具实际会怎样 ═══");
const bashPwd = '[[tool:bash]] [[args:{"command":"pwd"}]]';
await run("J0 cwd 正常 + bash pwd（对照）", {}, bashPwd, {});
await run("J1 cwd 指向文件 + bash pwd", { cwd: join(env.cwd, "a-file.txt") }, bashPwd, {});
await run("J2 cwd 不存在 + bash pwd", { cwd: join(env.cwd, "no-such-dir") }, bashPwd, {});
await run("J3 agentDir 指向文件 + read", { agentDir: join(env.agentDir, "models.json") }, '[[tool:read]] [[args:{"path":"a-file.txt"}]]', {});

save("e6", rows);
await env.srv.close();
await envR.srv.close();
