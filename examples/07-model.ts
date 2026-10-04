// 07-model：换模型 / 换思考档。
//
// 要点：`faux/echo` 是 reasoning:false，可用思考档只有 ["off"]；演示思考档必须切到
// FAUX_MODEL_ALT_REF（faux/echo-alt，reasoning:true）。并且**演示一次非法档位会抛错**：
// 库先按会话的可用档校验，不在里面就抛错（pi 对非法档位会静默钳到最近的档 —— 这正是库与
// pi 的差别）。抛错是预期行为，捕获并打印后脚本继续正常结束、退出码 0。
//
// 跑法：node examples/07-model.ts
// 期望看到：current.id 从 echo 换成 echo-alt；thinking 从 off 换成 high；available 的长度；
// 以及一次非法档位（very-high）的报错信息。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import type { ThinkingLevel } from "../src/index.ts";
import { FAUX_MODEL_ALT_REF, FAUX_MODEL_REF, makeOfflineAgent } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log(`[1] 初始状态`);
console.log(`    current.id = ${agent.model.current?.id}  thinking = ${agent.model.thinking}`);
console.log(`    available = ${agent.model.available.length} 个（${agent.model.available.map((m) => m.id).join(", ")}）`);

console.log("[2] 换到支持思考档的模型（faux/echo-alt，reasoning:true 的那个）");
await agent.model.set(FAUX_MODEL_ALT_REF);
console.log(`    current.id = ${agent.model.current?.id}  thinking = ${agent.model.thinking}`);
console.log(`    available = ${agent.model.available.length} 个**模型**（${agent.model.available.map((m) => m.id).join(", ")}）—— 思考档不在这个列表里：它由当前模型决定，上面那行 thinking 此刻仍是 off，high 要到下一步 setThinking 才设得上`);

console.log("[3] 换思考档 high（setThinking 是同步的，下一次请求生效）");
agent.model.setThinking("high");
console.log(`    thinking = ${agent.model.thinking}`);

console.log("[4] 非法档位：库先校验、不静默钳 —— 这与 pi 的差别（pi 会静默钳到最近的档）");
try {
  agent.model.setThinking("very-high" as ThinkingLevel); // 故意传一个不存在的档位
  console.log("    没有抛错？—— 这不对，合法档位之外必须报错");
} catch (err) {
  console.log(`    抛错（预期）：${(err as Error).message}`);
}
console.log(`    非法档位之后 thinking 仍是 ${agent.model.thinking}，脚本继续正常结束`);

console.log("[5] 换回原来的模型");
await agent.model.set(FAUX_MODEL_REF);
console.log(`    current.id = ${agent.model.current?.id}  thinking = ${agent.model.thinking}`);

agent.dispose();
console.log("\n脚本正常结束，退出码 0");
