// 复核 20-delivery 对基线的两处修正：
// ① 空闲 steer 是「静默停放 + 下次 prompt 顶替其返回」，不是「静默丢弃」
// ② 串台时 per-call usage 错（18→36），累计仍对
import { createAgent } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const mk = () => createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { modelRuntime: made.runtime });

console.log("═══ ① 空闲 steer：丢弃 还是 停放？ ═══");
{
  const a = await mk();
  const before = faux.calls.length;
  await a.steer("停放的消息");
  await sleep(600);
  console.log(`  steer 返回后 600ms 内，假服务新增请求 = ${faux.calls.length - before}（0 = 没有立刻跑）`);
  const r = await a.prompt("我自己的 prompt");
  console.log(`  随后 prompt("我自己的 prompt") 返回 = ${JSON.stringify(r.text)}`);
  console.log(`  → ${/停放的消息/.test(r.text) ? "**被暂停放的消息顶替了**（不是丢弃）" : "自己的文本正常返回"}`);
  console.log(`  自己那句文本出现在返回里了吗：${/我自己的 prompt/.test(r.text) ? "是" : "**否**"}`);
  console.log(`  lastResult = ${JSON.stringify(a.lastResult?.text)}`);
  a.dispose();
}

console.log("\n═══ ② 串台时 per-call usage ═══");
{
  const a = await mk();
  const ctrl = await a.prompt("对照单人轮");
  console.log(`  对照组 RunResult.usage = ${ctrl.usage.totalTokens}`);
  const a2 = await mk();
  const slow = a2.prompt("[[sleep:400]] 主干").catch(() => {});
  await sleep(150);
  await a2.send("追加");
  const main = await slow as never as { usage: { totalTokens: number }; text: string };
  console.log(`  串台组 主干 RunResult.usage = ${main?.usage?.totalTokens}  text=${JSON.stringify(main?.text)}`);
  await a2.waitForIdle(); await sleep(300);
  console.log(`  a2.usage（累计）= ${a2.usage.totalTokens}`);
  console.log(`  → per-call ${main?.usage?.totalTokens === 18 ? "正确" : "**错**（并入了别人一轮）"}；累计 ${a2.usage.totalTokens === 36 ? "正确" : "错"}`);
  a.dispose(); a2.dispose();
}
await faux.close();
