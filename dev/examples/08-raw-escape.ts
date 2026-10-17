// 08-raw-escape：raw 直通 pi —— 各面的逃生口。
//
// 这是逃生口：**全权、无护栏**。库的守卫（忙判据、结算、白名单自动并入、上下文视角）在
// raw 这一层都不存在，用之前自己想清楚代价。raw 的用途不是绕开库，而是拿到 pi 原样的那一层：
// 库的每个面都以 pi 的某个对象为底座，raw 把那个底座直接交给你。
//
// 这里演示两处（其余各面的 raw 见 examples/lib/snippets.ts 的 raw.* 片段）：
//   [1] io.raw 就是 pi 的 AgentSession 本体：会话原样可见（含 system），而 context.history 不含；
//   [2] tools.raw 读 pi **真正持有**的那份工具定义（list() 只给名字 + active，参数 schema / description 只有这里看得到）。
//
// 跑法：node examples/08-raw-escape.ts
// 期望看到：history.length 与 io.raw.messages.length 的差（system 那条），以及 read 工具的完整描述。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { makeOfflineAgent } from "./lib/harness.ts";

const agent = await makeOfflineAgent();
await agent.io.prompt("说一句话");

console.log("说明：raw = 逃生口，全权、无护栏 —— 库的守卫不在这层。");
console.log("例如库的 `context.compact()` 要求空闲（pi 的 compact 首行就是 abort），");
console.log("而 `context.raw.session.compact()` 没有这道守卫，运行中调用会静默打断在飞那轮。\n");

console.log("[1] io.raw 就是 pi 的 AgentSession 本体（历史视角与库不同）");
const session = agent.io.raw;
console.log(`    context.history.length = ${agent.context.history.length}（库的视角：不含 system，每轮由 pi 重建）`);
console.log(`    io.raw.messages.length = ${session.messages.length}（会话原样：含 system）`);
console.log(`    raw 里看到的 roles: ${session.messages.map((m) => m.role).join(", ")}`);

console.log("[2] tools.raw：读 pi 真正持有的那份工具定义（list() 只有名字 + active）");
const definition = agent.tools.raw.getToolDefinition("read");
console.log(`    read 的注册结果：name=${definition?.name}，description=${definition?.description}`);
console.log(`    不存在的名字：${agent.tools.raw.getToolDefinition("no_such_tool") ?? "(undefined，诚实返回)"}`);

agent.dispose();
console.log("\n脚本正常结束，退出码 0");
