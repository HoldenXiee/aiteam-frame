// 探针 03：忙时投递语义 —— 规格里决策 #18 的直接依据。
// 必须弄清：目标正在 streaming 时 prompt / steer / followUp 各是什么行为。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, finish, note, section, sleep, startFaux, withTimeout } from "./_support.ts";
import { assistantTexts, FAUX_MODEL_ID, makeRuntime } from "./_sdk.ts";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-p03-"));
const agentDir = join(root, "agent");
const runtime = await makeRuntime(agentDir, faux.baseUrl);
const model = runtime.getModel("faux", FAUX_MODEL_ID)!;

function makeSession() {
  return createAgentSession({
    cwd: root,
    agentDir,
    model,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({}),
  });
}

const { session } = await makeSession();

section("目标正忙时的 prompt()");
let promptThrew = "";
const slowRun = session.prompt("[[sleep:700]] 慢任务");
await sleep(200);
check("慢任务进行中 isStreaming 为 true", session.isStreaming === true);
try {
  await withTimeout(session.prompt("插队"), 3000, "prompt while streaming");
} catch (error) {
  promptThrew = (error as Error).message;
}
check("streaming 时 prompt() 抛错（决策 #18 的前提）", promptThrew.length > 0, promptThrew || "没有抛错");
note("错误信息", promptThrew);

section("目标正忙时的 steer() / followUp()");
let steerError = "";
try {
  await withTimeout(session.steer("改方向"), 3000, "steer while streaming");
} catch (error) {
  steerError = (error as Error).message;
}
check("streaming 时 steer() 不抛错", steerError === "", steerError);

let followError = "";
try {
  await withTimeout(session.followUp("做完再说"), 3000, "followUp while streaming");
} catch (error) {
  followError = (error as Error).message;
}
check("streaming 时 followUp() 不抛错", followError === "", followError);
note("排队中的消息数 pendingMessageCount", session.pendingMessageCount);

await withTimeout(slowRun, 20000, "slow run");
await withTimeout(session.agent.waitForIdle(), 30000, "waitForIdle after slow run");
note("队列处理完后 assistant 条数", assistantTexts(session).length);
note("队列处理完后总请求数", faux.calls.length);

section("目标空闲时 steer() 会怎样？（未知项，仅观测）");
const before = faux.calls.length;
let idleSteerError = "";
try {
  await withTimeout(session.steer("空闲时的 steer"), 3000, "steer while idle");
} catch (error) {
  idleSteerError = (error as Error).message;
}
await sleep(700);
note("空闲 steer 抛错", idleSteerError || "(未抛错)");
note("请求数变化", `${before} → ${faux.calls.length}`);
check(
  "空闲时 steer() 不抛错但静默丢弃消息（决策 #19 的关键实证）",
  idleSteerError === "" && faux.calls.length === before,
  `抛错=${idleSteerError || "无"} 请求数 ${before}→${faux.calls.length}`,
);
note("assistant 条数", assistantTexts(session).length);

section("投递语义的实现依据");
note(
  "结论",
  "忙→prompt 抛错；忙→steer/followUp 可排队；空闲→steer 行为见上。send() 必须自己分派",
);

await faux.close();
finish();
