// 探针 01：地基。假 provider 能不能跑通一条完整的 prompt？
// 这条不通，规格里的「零成本测试策略」直接作废。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, finish, note, section, startFaux, withTimeout } from "./_support.ts";
import { assistantTexts, FAUX_MODEL_ID, lastAssistant, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p01-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");

const runtime = await makeRuntime(agentDir, faux.baseUrl);

section("模型解析");
const model = runtime.getModel("faux", FAUX_MODEL_ID);
check("runtime.getModel('faux','echo') 拿到模型", Boolean(model), String(model));
if (!model) {
  await faux.close();
  finish();
  process.exit(0);
}
note("model.api / provider", `${(model as any).api} / ${(model as any).provider}`);

section("起 session 并 prompt");
const eventTypes: string[] = [];
const { session } = await createAgentSession({
  cwd,
  agentDir,
  model,
  modelRuntime: runtime,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager: SettingsManager.inMemory({}),
});
session.subscribe((event) => eventTypes.push(event.type));

await withTimeout(session.prompt("你好世界"), 20000, "first prompt");

const texts = assistantTexts(session);
check("拿到模型回复", texts.some((t) => t.includes("echo:你好世界")), JSON.stringify(texts));
check("假服务确实被调用", faux.calls.length === 1, `calls=${faux.calls.length}`);
note("事件类型顺序", [...new Set(eventTypes)].join(", "));

section("用量");
const assistant = lastAssistant(session);
note("assistant.usage", assistant?.usage);
check("assistant 消息带 usage", Boolean(assistant?.usage), JSON.stringify(assistant?.usage));
check(
  "usage.totalTokens 可读",
  typeof assistant?.usage?.totalTokens === "number",
  String(assistant?.usage?.totalTokens),
);

section("空闲状态与多轮");
check("prompt 结束后 isStreaming 为 false", session.isStreaming === false);
check("prompt 结束后 isIdle 为 true", session.isIdle === true);
await withTimeout(session.prompt("第二轮"), 20000, "second prompt");
check("多轮后历史累积", assistantTexts(session).length === 2, `assistant 条数=${assistantTexts(session).length}`);
check("假服务收到 2 次请求", faux.calls.length === 2, `calls=${faux.calls.length}`);
note("第二次请求的 messageCount", faux.calls[1]?.messageCount);

section("等待原语");
await withTimeout(session.agent.waitForIdle(), 5000, "session.agent.waitForIdle");
check("session.agent.waitForIdle() 存在且可等待", true);

await faux.close();
finish();
