// spike：aiteam 沙箱面的可行性验证（零 API 成本，不调模型）
//
// 要验证：
//   1. 能不能把「一个函数」包成 CodemodeTool，让脚本 tools.xxx() 调到
//   2. 脚本里能不能并发（Promise.all）—— 这是「通过代码编排」的核心价值
//   3. 错误 / 超时 / 隔离性是否可控
//
// 这个 spike **不碰真 agent**，只用假函数，先确认管道通。
import { InlineCodemodeSandbox, loadQuickJSWasm, type CodemodeTool } from "@earendil-works/pi-codemode";

/** 把普通函数包成沙箱工具（这就是 aiteam 要做的"包装"） */
function sandboxTool(
  name: string,
  description: string,
  fn: (args: Record<string, unknown>) => Promise<unknown> | unknown,
): CodemodeTool {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: true },
    execute: (args) => fn(args as Record<string, unknown>),
  };
}

const calls: string[] = [];
const wasm = await loadQuickJSWasm();

// 模拟 aiteam 的面：这里先用两个假的
const tools: CodemodeTool[] = [
  sandboxTool("spawn_agent", "起一个子 agent，返回它的 id", (a) => {
    const id = `a${calls.length + 1}`;
    calls.push(`spawn:${id}`);
    return { id, role: String(a.role ?? "通用") };
  }),
  sandboxTool("prompt_agent", "给某个 agent 发一句话，返回它的回答", async (a) => {
    const id = String(a.id);
    calls.push(`prompt:${id}`);
    await new Promise((r) => setTimeout(r, 60)); // 模拟"思考"时间，用来验证并发
    return { text: `[${id}] 我读完了：${String(a.text)}` };
  }),
];

const sandbox = new InlineCodemodeSandbox({ tools, wasm });

// ── 1. 基础调用 ──
const r1 = await sandbox.execute(`
  const a = await tools.spawn_agent({ role: "只读" });
  const out = await tools.prompt_agent({ id: a.id, text: "读 src/" });
  return out.text;
`);
console.log("1 基础调用  :", r1.ok ? "ok" : "FAIL", "|", JSON.stringify(r1.value));

// ── 2. 并发 ──
calls.length = 0;
const t0 = Date.now();
const r2 = await sandbox.execute(`
  const agents = await Promise.all([1,2,3,4,5].map(i => tools.spawn_agent({ role: "w" + i })));
  const outs = await Promise.all(agents.map(a => tools.prompt_agent({ id: a.id, text: "读材料" })));
  return outs.map(o => o.text).join(" / ");
`);
console.log("2 并发 5 个 :", r2.ok ? "ok" : "FAIL", `| ${Date.now() - t0}ms（串行应 300ms+）| 调用 ${calls.length} 次`);

// ── 3. 脚本内判断/过滤 ──
const r3 = await sandbox.execute(`
  const results = [{ok:true,v:1},{ok:false,v:2},{ok:true,v:3}];
  return results.filter(r => r.ok).map(r => r.v);
`);
console.log("3 脚本内判断:", r3.ok ? "ok" : "FAIL", "|", JSON.stringify(r3.value));

// ── 4. 工具抛错 ──
const s2 = new InlineCodemodeSandbox({ tools: [sandboxTool("explode", "总是抛错", () => { throw new Error("boom"); })], wasm });
const r4 = await s2.execute(`
  try { await tools.explode({}); return "没炸"; }
  catch (e) { return "抓到了：" + e.message; }
`);
console.log("4 错误传播  :", r4.ok ? "ok" : "FAIL", "|", JSON.stringify(r4.value));

// ── 5. 隔离性 ──
const r5 = await sandbox.execute(`
  const has = (n) => { try { return typeof eval(n) !== "undefined"; } catch { return false; } };
  return { process: has("process"), require: has("require"), fetch: has("fetch") };
`);
console.log("5 隔离性    :", r5.ok ? "ok" : "FAIL", "|", JSON.stringify(r5.value));

// ── 6. 超时 ──
const s3 = new InlineCodemodeSandbox({ tools, wasm, timeoutMs: 200 });
const r6 = await s3.execute(`while (true) {}`);
console.log("6 超时       :", r6.ok ? "ok" : "FAIL", "|", JSON.stringify(String(r6.error ?? "")).slice(0, 70));

// ── 7. 观测：能不能看到调用轨迹 ──
const r7 = await sandbox.execute(`
  await tools.spawn_agent({ role: "x" });
  await tools.prompt_agent({ id: "a1", text: "hi" });
`);
console.log("7 调用轨迹  :", r7.ok ? "ok" : "FAIL", "|", JSON.stringify(r7.calls));

sandbox.close();
s2.close();
s3.close();
