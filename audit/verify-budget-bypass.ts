// 重测①：不能用「先花光」的方式进入忙碌态 —— 那会让 prompt() 在预算检查处就抛错，压根没有忙碌窗口。
// 正确构造：budget=18、usage 起始 0（第一轮放行），在第一轮**正在跑**时投递。
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);

console.log("═══ ① 忙时 send（followUp 路径）是否绕过预算 ═══");
{
  const host = createAgentHost({ budgetTokens: 18 });
  const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
  const reqBefore = faux.calls.length;

  const slow = a.prompt("[[sleep:700]] 第一轮").catch((e) => `throw:${(e as Error).message}`);
  await sleep(200);
  console.log(`  第一轮进行中：isStreaming=${a.isStreaming}，host.usage=${host.usage.totalTokens}（上限 18，此刻尚未结算）`);

  const r = await a.send("忙时投递");
  console.log(`  忙时 send → ${JSON.stringify(r)}`);
  await Promise.resolve(slow);
  await a.waitForIdle();
  await sleep(400);

  console.log(`  两轮结束后：host.usage=${host.usage.totalTokens}，假服务新增请求=${faux.calls.length - reqBefore} 次`);
  console.log(`  → 预算${host.usage.totalTokens > 18 ? `被击穿（${host.usage.totalTokens}/${18}，超 ${(host.usage.totalTokens / 18).toFixed(1)}×）` : "守住了"}`);
  a.dispose();
}

console.log("\n═══ ①b 直接 steer() 是否绕过预算 ═══");
{
  const host = createAgentHost({ budgetTokens: 18 });
  const b = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
  const slow = b.prompt("[[sleep:700]] 第一轮").catch((e) => `throw:${(e as Error).message}`);
  await sleep(200);
  const st = await b.steer("直接插话").then(() => "no-throw", (e) => `throw:${(e as Error).message}`);
  await Promise.resolve(slow);
  await b.waitForIdle();
  await sleep(400);
  console.log(`  steer → ${st}；结束后 host.usage=${b.usage.totalTokens > 18 ? `被击穿（${b.usage.totalTokens}）` : `守住了（${b.usage.totalTokens}）`}`);
  b.dispose();
}
await faux.close();
