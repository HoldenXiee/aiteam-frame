// 复核 07-observability 的三条：E1（忙时 prompt 无事件）、⚪H1（settle 窗口内 prompt 静默退化）、⚪H2（WeakSet 去重失效→用量虚高）
import { createAgent } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const mk = (extra: any = {}) =>
  createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir, ...extra }, { modelRuntime: made.runtime });

console.log("═══ E1：忙时 prompt() 抛错时，有没有任何事件？ ═══");
{
  const host = (await import("../src/index.ts")).createAgentHost({});
  const a = await mk();
  const seen: string[] = [];
  for (const e of ["error", "done", "turn", "text", "tool_start", "tool_end", "thinking"] as const) a.on(e, () => seen.push(e));
  const slow = a.prompt("[[sleep:600]] 忙").catch(() => {});
  await sleep(150);
  const before = faux.calls.length;
  let thrown = "";
  try { await a.prompt("插队"); } catch (e) { thrown = (e as Error).message.slice(0, 60); }
  const during = [...seen];
  await slow; await sleep(300);
  console.log(`  抛错：${thrown}`);
  console.log(`  抛错瞬间已收到的事件：${JSON.stringify(during)}`);
  console.log(`  整个实验收到的事件：${JSON.stringify(seen)}`);
  console.log(`  → 这次失败在事件流里${seen.includes("error") ? "有 error 事件" : "**完全不可见**（无 error 事件）"}`);
  a.dispose(); host.dispose();
}

console.log("\n═══ 内部状态探形（H1/H2 需要）═══");
{
  const a = await mk();
  await a.prompt("第一轮");
  const s = a.session as any;
  console.log(`  session 上的相关键：${JSON.stringify(Object.keys(s).filter((k) => /message|agent|state/i.test(k)))}`);
  console.log(`  session.messages 可写？${(() => { try { const v = s.messages; s.messages = v; return "是（有 setter）"; } catch (e) { return `否：${(e as Error).message.slice(0, 50)}`; } })()}`);
  console.log(`  session.agent 存在？${!!s.agent}  其 state.messages？${!!s.agent?.state?.messages}`);
  console.log(`  session.messages.length=${s.messages.length}，类型：${s.messages.map((m: any) => m.role).join(",")}`);
  a.dispose();
}

console.log("\n═══ ⚪H2：克隆 assistant 消息后，用量会不会重复计？ ═══");
{
  const a = await mk();
  await a.prompt("一");
  await a.prompt("二");
  console.log(`  两轮后 agent.usage=${a.usage.totalTokens}（期望 36）`);
  const s = a.session as any;
  const arr = s.agent?.state?.messages ?? s.messages;
  const cloneable = arr.filter((m: any) => m.role === "assistant");
  console.log(`  会话里 assistant 消息 ${cloneable.length} 条`);
  // 原地克隆（模拟 SDK 在 context_edit / content==null 分支的行为）
  for (let i = 0; i < arr.length; i++) if (arr[i].role === "assistant") arr[i] = { ...arr[i] };
  console.log(`  已把 ${cloneable.length} 条 assistant 消息替换为 {...m} 克隆`);
  const r3 = await a.prompt("三");
  console.log(`  第三轮 RunResult.usage=${r3.usage.totalTokens}（若为 18 则正常；若为 18+36=54 则重复计了前两轮）`);
  console.log(`  三轮后 agent.usage=${a.usage.totalTokens}（正常应为 54）`);
  console.log(`  → H2 ${r3.usage.totalTokens > 18 ? "**成立（用量重复计）**" : "不成立"}`);
  a.dispose();
}

console.log("\n═══ ⚪H1：在 agent_settled 发射窗口内调 prompt() ═══");
{
  const a = await mk();
  let h1: any = null;
  let fired = 0;
  a.session.subscribe((raw: any) => {
    if (raw.type === "agent_settled" && fired === 0) {
      fired++;
      console.log(`  [窗口内] 收到 agent_settled，此刻 isStreaming=${a.isStreaming}`);
      const reqBefore = faux.calls.length;
      void a.prompt("在 settle 窗口内投递").then((r) => {
        h1 = { text: r.text, tokens: r.usage.totalTokens, reqDelta: faux.calls.length - reqBefore };
      });
    }
  });
  await a.prompt("第一轮");
  await sleep(800);
  console.log(`  窗口内 prompt() 的返回：${h1 ? JSON.stringify(h1) : "（未捕获到）"}`);
  if (h1) console.log(`  → H1 ${h1.tokens === 0 && h1.text === "" ? "**成立（空文本 + 全 0 usage）**" : "不成立"}`);
  a.dispose();
}

await faux.close();
