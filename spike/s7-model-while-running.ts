// S7（任务 7）：运行中调 `session.setModel` / `session.setThinkingLevel` 会怎样？
// 任务 3 发现 `session.compact()` 首行是 `await this.abort()`（→ R27 给它加了 idle 守卫）。
// 这里问同一个问题：这两个会不会**静默**破坏在飞的那轮？调用方能不能察觉？
//
// 顺带实测两件被简报写错的事实：
//   - 假 provider 收到的 `model` 字段是 **id**（`echo`）还是 ref（`faux/echo`）？
//   - 思考档到底有没有落到请求负载上（off vs high）？
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  resolveCliModel,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { startFaux, sleep } from "../test/faux-server.ts";
import { FAUX_MODEL_ALT_ID, FAUX_MODEL_ID, FAUX_MODEL_REF, writeModelsJson } from "../test/faux-models.ts";
import { check, head } from "./_pi.ts";

process.env.PI_OFFLINE = "1";

const faux = await startFaux();
const root = mkdtempSync(join(tmpdir(), "aiteam-s7-"));
const agentDir = join(root, "agent");
const cwd = join(root, "work");
mkdirSync(cwd, { recursive: true });
const modelsPath = writeModelsJson(agentDir, faux.baseUrl, [FAUX_MODEL_ID, FAUX_MODEL_ALT_ID]);
const modelRuntime = await ModelRuntime.create({ modelsPath, allowModelNetwork: false });
const settingsManager = SettingsManager.inMemory({});

// 捕获每次出网请求的负载（pi 的 before_provider_request）——思考档的落点只能从这里看
const payloads: any[] = [];
const capture = (pi: ExtensionAPI): void => {
  pi.on("before_provider_request", (event: any) => {
    payloads.push(event.payload);
  });
};
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [capture] });
await loader.reload();
const resolved = resolveCliModel({ cliModel: FAUX_MODEL_REF, modelRuntime });
if (!resolved.model) throw new Error("解析失败");
const { session } = await createAgentSession({
  cwd,
  agentDir,
  modelRuntime,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
  settingsManager,
  model: resolved.model,
});
const alt = modelRuntime.getAvailableSnapshot().find((m) => m.id === FAUX_MODEL_ALT_ID)!;

head("0. 模型能力");
check("默认模型不支持思考（available 只有 off）", JSON.stringify(session.getAvailableThinkingLevels()) === '["off"]', session.getAvailableThinkingLevels());
console.log(`  切到 alt 后 available=${JSON.stringify((await session.setModel(alt), session.getAvailableThinkingLevels()))}`);
await session.setModel(resolved.model);

head("A. 运行中 setModel");
{
  const before = faux.calls.length;
  const p = session.prompt("[[sleep:500]] [[tool:read]] 慢");
  p.catch(() => {});
  await sleep(150); // 让第一条请求真的出去（假服务正卡在 500ms 的 sleep 里）
  check("此刻在飞（isStreaming）", session.isStreaming === true, String(session.isStreaming));
  const sentSoFar = faux.calls.length - before;
  let setErr: string | undefined;
  await session.setModel(alt).catch((e: unknown) => (setErr = String(e)));
  console.log(`  setModel：${setErr ? `抛错 ${setErr}` : "正常 resolve"}`);
  check("调用方看不到异常", setErr === undefined);
  check("session 的当前模型立刻变了", session.model?.id === FAUX_MODEL_ALT_ID, `session.model.id=${session.model?.id}`);
  let outcome = "未结束";
  await Promise.race([
    p.then((r: any) => (outcome = `跑完 error=${r?.error ?? "无"}`), (e: unknown) => (outcome = `抛错 ${String(e).slice(0, 100)}`)),
    sleep(5000).then(() => (outcome = "超时")),
  ]);
  console.log(`  在飞那轮：${outcome}`);
  console.log(`  该轮请求（model 字段，原样来自负载）：${faux.calls.slice(before).map((c) => JSON.stringify(c.model)).join(" → ")}`);
  check("在飞那轮没被中止", !outcome.startsWith("抛错") && outcome !== "超时", outcome);
  check("该轮一共发了 2 条请求（切换只影响第 2 条）", sentSoFar === 1 && faux.calls.length - before === 2, `已发 ${sentSoFar} → 共 ${faux.calls.length - before}`);
}

head("B. 运行中 setThinkingLevel");
{
  const before = faux.calls.length;
  const p = session.prompt("[[sleep:500]] [[tool:read]] 慢");
  p.catch(() => {});
  await sleep(150);
  const levels = session.getAvailableThinkingLevels();
  let threw: string | undefined;
  try {
    session.setThinkingLevel("high");
  } catch (e) {
    threw = String(e);
  }
  console.log(`  setThinkingLevel("high")：${threw ?? "正常返回"}；levels=${JSON.stringify(levels)}，现在 thinkingLevel=${session.thinkingLevel}`);
  let outcome = "未结束";
  await Promise.race([
    p.then((r: any) => (outcome = `跑完 error=${r?.error ?? "无"}`), (e: unknown) => (outcome = `抛错 ${String(e).slice(0, 100)}`)),
    sleep(5000).then(() => (outcome = "超时")),
  ]);
  console.log(`  在飞那轮：${outcome}；该轮请求数 ${faux.calls.length - before}；thinkingLevel 现在是 ${session.thinkingLevel}`);
  check("在飞那轮没被中止", !outcome.startsWith("抛错") && outcome !== "超时", outcome);
  session.setThinkingLevel("off");
}

head("C. 非法思考档：pi 会静默钳（v1 决策 #28 的教训）");
{
  const before = session.thinkingLevel;
  let threw: string | undefined;
  try {
    session.setThinkingLevel("very-high" as any);
  } catch (e) {
    threw = String(e);
  }
  check("pi 的 setThinkingLevel 对非法值**不抛错**", threw === undefined, threw);
  console.log(`  钳后 thinkingLevel=${session.thinkingLevel}（调用前 ${before}）——调用方看不出自己的值被改成了别的`);
  session.setThinkingLevel("off");
}

head("D. 思考档有没有落到请求负载上（off vs high，alt 有 reasoning）");
{
  await session.setModel(alt);
  const from = payloads.length;
  session.setThinkingLevel("off");
  await session.prompt("off 档");
  session.setThinkingLevel("high");
  await session.prompt("high 档");
  const [a, b] = payloads.slice(from);
  const keys = (x: any) => Object.keys(x ?? {}).sort().join(",");
  const strip = (x: any) => {
    const { messages: _m, ...rest } = x ?? {};
    return JSON.stringify(rest);
  };
  console.log(`  off  : ${JSON.stringify({ reasoning_effort: a?.reasoning_effort, thinking: a?.thinking, reasoning: a?.reasoning })}`);
  console.log(`  high : ${JSON.stringify({ reasoning_effort: b?.reasoning_effort, thinking: b?.thinking, reasoning: b?.reasoning })}`);
  check("两次请求负载的键集合一致", keys(a) === keys(b), keys(a));
  check(
    "负载里确实有思考档的差别（去掉 messages 后相比）",
    strip(a) !== strip(b),
    strip(a) === strip(b) ? "（两次负载的配置部分逐字相同——思考档没上网）" : undefined,
  );
  console.log(`  off 键：${keys(a)}`);
}

head("E. setModel 到未授权的 provider：抛错且不留半应用状态");
{
  const beforeModel = session.model?.id;
  let err: string | undefined;
  await session.setModel({ id: "x", provider: "no-such-provider", api: "openai-completions" } as any).catch(
    (e: unknown) => (err = String(e)),
  );
  check("抛错", err !== undefined, err);
  check("当前模型没被改坏", session.model?.id === beforeModel, String(session.model?.id));
}

console.log(`\n假服务收到的 model 字段（全部）：${faux.calls.map((c) => c.model).join(" , ")}`);
try {
  session.dispose();
} catch {
  /* 忽略 */
}
await faux.close();
