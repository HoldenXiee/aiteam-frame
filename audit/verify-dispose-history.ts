// 决定性验证：dispose 到底清不清 session.messages（既有报告 5.1g 说「变空数组」，05 独立实测说「保留」）
// 关键：受试分身必须**先真的跑过**，否则 0 是「本来就没有」而非「被清掉」
import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const host = createAgentHost({ members: { mid: { tools: ["spawn_agent"] }, leaf: {} } });

// 对照组：建完就 dispose、从未 prompt（复刻既有报告的样本）
const never = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
never.dispose();

// 实验组：跑过两轮再 dispose
const ran = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
await ran.prompt("第一轮");
await ran.prompt("第二轮");
console.log(`dispose 前：messages=${ran.session.messages.length} usage=${ran.usage.totalTokens}`);
ran.dispose();
console.log(`dispose 后：messages=${ran.session.messages.length} usage=${ran.usage.totalTokens} status=${ran.status}`);
console.log(`对照组（从未 prompt）：messages=${never.session.messages.length} usage=${never.usage.totalTokens}`);
console.log(`→ dispose ${ran.session.messages.length > 0 ? "不清" : "清空"} session.messages`);

// 顺带验证 E4：中间层回收后，祖先还投得到自己的真后代吗
console.log("\n── E4：中间层回收后祖先的寻址范围 ──");
const top = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, modelRuntime: made.runtime });
const mid = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, parent: top, member: "mid", modelRuntime: made.runtime });
const leaf = await createAgent({ model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir }, { host, parent: mid, member: "leaf", modelRuntime: made.runtime });
const send = (await import("../src/tools/send-message.ts")).createSendMessageTool({ agent: top, host });
const call = async (target: string) => {
  const r = await send.execute("c", { agentId: target, message: "喂" } as never, undefined, undefined, undefined as never);
  return (r.content[0] as any).text as string;
};
console.log(`回收 mid 前，top→leaf：${await call(leaf.id)}`);
mid.dispose();
console.log(`回收 mid 后，top→leaf：${await call(leaf.id)}`);
console.log(`leaf.parentId=${leaf.parentId}，mid 已回收=${host.get(mid.id) === undefined}，leaf 仍在 list=${host.list().some((x) => x.id === leaf.id)}`);
host.dispose();
await faux.close();
