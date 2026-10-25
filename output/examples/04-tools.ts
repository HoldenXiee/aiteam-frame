// 04-tools：运行期加一个自定义工具，并证明它真的上了线。
//
// 判别力（两条判据，缺一不可）：
//   (a) `agent.tools.list()` 里它 active；
//   (b) 模型下一轮**实际收到**的声明里有它（用 harness 的 `sentTools()` 读假服务的请求记录）。
// 顺序必须「先起、后加、再看下一轮」：创建期的工具不加也在，看到它说明不了 add 做了什么
// （详见 snippets 的 tools.addThenInspect）。
//
// 跑法：node examples/04-tools.ts
// 期望看到：加之前 `tools.list()` 里没有 word_count；加之后它 active=true；
// 下一轮 sentTools() 的声明列表里包含 word_count。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { makeOfflineAgent, sentTools } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log("[1] 起 agent，还没加任何工具");
console.log(`    tools.list() = ${agent.tools.list().map((t) => `${t.name}:active=${t.active}`).join(", ") || "(空)"}`);

console.log("[2] 运行期 add：word_count（数一段文本有多少个词）");
console.log("    —— add 碰声明面（reload），忙时会抛错，所以先 waitIdle（片段 io.waitIdle 的固定前奏）");
await agent.io.waitIdle();
await agent.tools.add(
  defineTool({
    name: "word_count",
    label: "Word Count",
    description: "数一段文本有多少个词",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params) => ({
      content: [{ type: "text" as const, text: String(params.text.split(/\s+/).filter(Boolean).length) }],
      details: {},
    }),
  }),
);

console.log("[3] 判据 a：tools.list() 里它 active");
const listed = agent.tools.list();
console.log(`    ${listed.map((t) => `${t.name}:active=${t.active}`).join("  ")}`);

console.log("[4] 判据 b：加完之后才请求，看模型下一轮实际收到的声明（sentTools()）");
await agent.io.prompt("数一下这行有几个词"); // 加完之后才请求
const received = sentTools();
console.log(`    模型这轮收到的声明：${received.join(", ")}`);
console.log(`    word_count 在声明里吗：${received.includes("word_count")}`);

agent.dispose();
console.log("\n脚本正常结束，退出码 0");
