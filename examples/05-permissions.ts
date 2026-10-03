// 05-permissions：审批门（gate）+ 精确白名单（only）。
//
// 判别力：门**真的被调用一次**，而不是只装上没触发 —— 用假 provider 的 `[[tool:NAME]]`
// 脚本约定让模型发起一次 bash 调用（带 rm -rf），门在工具执行前拦截，打印 {name, input}；
// 门返回的 `reason` 会作为工具结果回到模型面前，模型读到什么也打印出来。
//
// 跑法：node examples/05-permissions.ts
// 期望看到：白名单生效后模型只收到 read / bash 两个声明；门被调用一次并打印
// {name:"bash", input:{command:"rm -rf ..."}}；模型的最终回答里出现门的 reason。
//
// 若要用真模型，改这两行：`makeOfflineAgent()` → `makeOfflineAgent({ model: "<provider>/<id>", modelNetwork: true })`
// （默认 ref 在 examples/lib/harness.ts；运行期换模型走 `agent.model.set(...)`，见 07-model.ts）。
import { makeOfflineAgent, sentTools } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log("[1] 精确白名单：只给 read / bash —— 集合外的东西模型连看都看不到");
await agent.io.waitIdle();
await agent.permissions.only(["read", "bash"]);
await agent.io.prompt("先探一下环境");
console.log(`    这轮模型实际收到的工具声明：${sentTools().join(", ")}`);

console.log("[2] 装一个审批门：每次工具调用前先问一句，能拦能改");
console.log("    —— gate 是只写不读的同步单槽位：判定逻辑一次写清，没有「读回来」的机会");
agent.permissions.gate(async (call) => {
  // 门被调用时的 {name, input}
  console.log(`    [门被调用] {name: "${call.name}", input: ${JSON.stringify(call.input)}}`);
  const command = String((call.input as { command?: string }).command ?? "");
  if (call.name === "bash" && command.includes("rm -rf")) {
    return { block: true, reason: "这条命令看起来会删我的东西，换个方式" };
  }
  return undefined; // 不拦
});

console.log("[3] 让模型真的发起一次被拦的工具调用（假 provider 的 [[tool:...]] 脚本约定）");
const result = await agent.io.prompt('[[tool:bash]] [[args:{"command":"rm -rf /tmp/xxx"}]]');
console.log("    —— 门返回的 reason 作为工具结果回到模型面前，模型读到的是：");
console.log(`    ${result.text}`);
if (result.error) throw new Error(`这一轮失败了：${result.error}`);

agent.dispose();
console.log("\n脚本正常结束（脚本打印完即退出，无需手动 close 假服务），退出码 0");
