// 重测报告 C2.6：预算**已经**耗尽（不是初始就小）之后，send() 的行为
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const host = createAgentHost({ budgetTokens: 18 });   // 假服务每次正好产 18 token
const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });

await a.prompt("先烧掉预算");                          // → host.usage = 18，达到上限
console.log(`预热后：host.usage=${host.usage.totalTokens}，budgetTokens=${host.budgetTokens}`);

const errs: string[] = [];
a.on("error", (p) => errs.push(p.message));
const before = faux.calls.length;
const r = await a.send("这条应该跑不了");
await sleep(400);
console.log(`send() 返回        ：${JSON.stringify(r)}`);
console.log(`假服务请求数       ：${before} → ${faux.calls.length}（不变 = 一个字都没跑）`);
console.log(`error 事件         ：${errs.length ? JSON.stringify(errs) : "(无)"}`);
console.log(`lastResult.text    ：${JSON.stringify(a.lastResult?.text)}`);
console.log(`status             ：${a.status}`);
a.dispose();
await faux.close();
