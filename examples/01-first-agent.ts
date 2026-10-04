// 01-first-agent：起一个 agent、交办一件事、拿到文本与用量。
//
// 跑法：node examples/01-first-agent.ts
// 期望看到：agent 的回答（RunResult.text）、本次运行的用量（RunResult.usage）、
// 以及库层面的累计用量与状态。全程离线，零 API 成本。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { makeOfflineAgent } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log(`agent id: ${agent.id}（一个分身）\n`);

console.log("[1] 问一句，拿文本（RunResult.text）");
const result = await agent.io.prompt("用一句话说明你能做什么");
// 失败分两种：接受之前失败会 reject；接受之后失败不 reject、只写进 result.error —— 必须显式看。
if (result.error) throw new Error(`这一轮失败了：${result.error}`);
console.log(`    模型说：${result.text}`);

console.log("[2] 本次运行的用量（RunResult.usage）");
console.log(`    input=${result.usage.input} output=${result.usage.output} total=${result.usage.totalTokens} 成本=${result.usage.cost.total}`);

console.log("[3] 生命周期结算：累计用量与状态（agent.usage / agent.status）");
console.log(`    usage.total=${agent.usage.totalTokens} status=${agent.status}`);

agent.dispose();
console.log(`\ndispose 后 status=${agent.status} —— 脚本正常结束，退出码 0`);
