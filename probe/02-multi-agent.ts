// 探针 02：同进程多个 agent 并存 + 共享 ModelRuntime + 真并发。
// 这是「集群」的物理前提。
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, finish, note, section, startFaux, withTimeout } from "./_support.ts";
import { assistantTexts, FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p02-"));
const sharedAgentDir = join(root, "agent");
const runtime = await makeRuntime(sharedAgentDir, faux.baseUrl);
const model = runtime.getModel("faux", FAUX_MODEL_ID)!;

async function spawnAgent(index: number) {
  const cwd = join(root, `work-${index}`);
  mkdirSync(cwd, { recursive: true });
  const { session } = await createAgentSession({
    cwd,
    agentDir: sharedAgentDir,
    model,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({}),
  });
  return session;
}

section("三个 agent 同时存在，共用一个 ModelRuntime 和 agentDir");
const started = Date.now();
const sessions = await Promise.all([0, 1, 2].map(spawnAgent));
const spawnMs = Date.now() - started;
check("三个 session 都建起来了", sessions.length === 3);
check("三个 sessionId 互不相同", new Set(sessions.map((s) => s.sessionId)).size === 3);
note("建三个 session 耗时 ms", spawnMs);

section("真并发：每人都发一个 sleep 400ms 的任务");
const batchStart = Date.now();
await Promise.all(sessions.map((s, i) => s.prompt(`[[sleep:400]] agent-${i}`)));
const batchMs = Date.now() - batchStart;
note("三个并发 prompt 总耗时 ms", batchMs);
check("并发执行（总耗时远小于 3×400ms）", batchMs < 1000, `实际 ${batchMs}ms`);

section("各自的上下文不串");
for (const [i, session] of sessions.entries()) {
  const texts = assistantTexts(session);
  check(`agent-${i} 只看到自己的回复`, texts.every((t) => t.includes(`agent-${i}`)), JSON.stringify(texts));
}
check("假服务共收到 3 次请求", faux.calls.length === 3, `calls=${faux.calls.length}`);

section("各自的 cwd 不串");
check(
  "三个 session 的 cwd 不同",
  new Set(sessions.map((s) => (s as any).sessionManager?.getCwd?.() ?? s.sessionId)).size === 3,
);

section("并发互相打断测试：一个 agent 跑着时另一个照常跑");
const slow = sessions[0].prompt("[[sleep:500]] 慢");
await withTimeout(sessions[1].prompt("快的"), 15000, "fast prompt");
check("慢 agent 仍在跑时，快 agent 已完成", sessions[0].isStreaming === true, `isStreaming=${sessions[0].isStreaming}`);
await slow;

await faux.close();
finish();
