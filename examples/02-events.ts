// 02-events：事件观测 —— 按名收窄的 `on` + 全量的 `onAny`。
//
// 说明：v1 曾有的「七个归一化事件」在 v2 已经删除；`agent.on` / `agent.onAny`
// 直接镜像 pi 的 ExtensionEvent（事件名与负载都是 pi 原样透传，见 src/agent/bridge.ts）。
// 所以这里演示的是两种订阅方式，不发明任何事件名表。
//
// 跑法：node examples/02-events.ts
// 期望看到：一次真实运行里 onAny 收到的事件名序列（含 agent_start / agent_settled），
// 以及 `on("message_end")` 按名收窄后收集到的 message.role 序列。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { makeOfflineAgent } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

// on：按名收窄 —— event 参数已被收窄成 MessageEndEvent，不用自己 cast。
// 注意：handler 必须写成块体；一行箭头 `(e) => roles.push(...)` 的返回值是数组长度（真值），
// 会撞上库的 R47 形状守卫抛错（详见 snippets 的 events.on）。
const roles: string[] = [];
const offOn = agent.on("message_end", (event) => {
  roles.push(event.message.role);
});

// onAny：全量 —— 拿到的是判别的联合，先看 event.type 再取字段（trace / 日志要的形状）。
const types: string[] = [];
const offAny = agent.onAny((event) => {
  types.push(event.type);
});

await agent.io.prompt("说一句话");

console.log("[1] on 按名收窄：message_end 事件里的 message.role 序列");
console.log(`    ${roles.join(" → ")}`);

console.log("[2] onAny 全量：这次运行收到的事件名序列（真实记录，不是发明的事件表）");
console.log(`    ${types.join(" → ")}`);
console.log(`    —— 共 ${types.length} 个；收得到生命周期两端：agent_start=${types.includes("agent_start")} agent_settled=${types.includes("agent_settled")}`);

console.log("[3] 退订：off() 之后不再收新事件（长寿命 agent 上忘了退订，监听器会一轮轮攒下去）");
offOn();
offAny();
const before = types.length; // 退订后再跑一轮：两个计数器都不该再涨 —— 这条宣称就是这么变成可证伪的
await agent.io.prompt("再说一句");
console.log(`    onAny 计数 ${before} → ${types.length}（没涨 = 退订真的生效了）`);
agent.dispose();
console.log("    已退订并 dispose；脚本正常结束，退出码 0");
