// 03-context：读历史 / 本轮覆盖（override）/ 压缩（compact）。
//
// 跑法：node examples/03-context.ts
// 期望看到：history.length 的前后变化 —— override 期间历史照常增长（只改「这一轮发什么」），
// 压缩后 history 变短；若历史太短压缩会抛「Nothing to compact」，这里明确打印「会话太小、无需压缩」。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { faux, makeOfflineAgent } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log("[1] 读历史（只读快照，不含 system）");
console.log(`    创建后 history.length = ${agent.context.history.length}`);
await agent.io.prompt("第一句：大家好");
console.log(`    跑完一轮后 history.length = ${agent.context.history.length}（roles: ${agent.context.history.map((m) => m.role).join(",")}）`);

console.log("[2] 本轮覆盖：还是那几条历史，但这一轮只发最后 1 条");
const beforeOverride = agent.context.history.length;
agent.context.override((messages) => messages.slice(-1));
await agent.io.prompt("第二句：今天聊上下文");
const overrideCall = faux.calls[faux.calls.length - 1];
console.log(`    模型这轮实际收到 ${overrideCall?.messageCount} 条（system + 1 条 user = override 生效）`);
console.log(`    历史照常增长：${beforeOverride} → ${agent.context.history.length}（override 不动历史，只改「这一轮发什么」）`);
agent.context.override(undefined); // 清除：下一轮恢复全量
await agent.io.prompt("第三句：清除 override 试试");
console.log(`    清除 override 后模型收到 ${faux.calls[faux.calls.length - 1]?.messageCount} 条（完整历史回来了）`);

console.log("[3] 压缩：先攒够长的历史，再压");
console.log(`    压缩前 history.length = ${agent.context.history.length}`);
await agent.io.prompt("[[huge:200000]] 攒一段很长的历史，方便把「没有东西可压缩」的情况排除掉");
console.log(`    攒完历史 history.length = ${agent.context.history.length}`);
const beforeCompact = agent.context.history.length;
try {
  // compact 要求 idle（pi 的 session.compact() 首行就是 abort，运行中调用会静默打断在飞那轮）
  await agent.context.compact("保留结论与待办，压掉中间过程");
  console.log(`    压缩后 history.length = ${agent.context.history.length}（变短 = 压缩生效，不是消息丢了）`);
} catch (err) {
  const message = String((err as Error)?.message ?? err);
  if (message.includes("Nothing to compact")) {
    // 历史太短时 pi 认为「没东西可压」——这不是出错；但这里不许静默吞掉，要明确说出来
    console.log(`    压缩：会话太小、无需压缩（${message}）`);
    console.log(`    压缩后 history.length = ${agent.context.history.length}（与压缩前一致，符合预期）`);
  } else {
    throw err;
  }
}

agent.dispose();
console.log("\n脚本正常结束，退出码 0");
