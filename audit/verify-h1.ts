// 重测 H1：只看窗口内那次 prompt 是错的 —— 被"偷"走结果的可能是**外层**那次。两边都打印。
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux, sleep } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const host = createAgentHost({});
const a = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });

const rounds: string[] = [];
host.on("round_completed", ({ result }) => rounds.push(`text=${JSON.stringify(result.text)} tok=${result.usage.totalTokens}`));

let inner: any = null;
let fired = 0;
a.session.subscribe((raw: any) => {
  if (raw.type === "agent_settled" && fired === 0) {
    fired++;
    void a.prompt("窗口内投递的消息").then((r) => {
      inner = { text: r.text, tokens: r.usage.totalTokens };
    });
  }
});

const reqBefore = faux.calls.length;
const outer = await a.prompt("外层第一轮");
console.log(`  外层 prompt() 返回：text=${JSON.stringify(outer.text)} tokens=${outer.usage.totalTokens}`);
await sleep(900);
console.log(`  窗口内 prompt() 返回：${inner ? `text=${JSON.stringify(inner.text)} tokens=${inner.tokens}` : "（未捕获）"}`);
console.log(`  假服务收到请求：${faux.calls.length - reqBefore} 次（外层 1 次 + 窗口内消息若被执行则 +1）`);
console.log(`  round_completed 播报：${JSON.stringify(rounds)}`);
console.log(`  agent.usage=${a.usage.totalTokens}（两轮各 18 则应为 36）`);
console.log(`  lastResult.text=${JSON.stringify(a.lastResult?.text)}`);
console.log(`  窗口内那条消息最终跑了吗：${faux.calls.slice(reqBefore).some((c) => /窗口内投递/.test(c.lastUser)) ? "跑了" : "**没有**"}`);
a.dispose();
await faux.close();
