// 13-sandbox：沙箱面 —— 让**模型**写一小段 JS 来编排 agent 的调用。
//
// 与 10-spawn 的区别（这是本示例的重点）：
//   10-spawn 给模型**一个** spawn 工具。模型调一次、等它回来、再调一次 —— **串行、逐个、每步一轮 LLM**。
//   13-sandbox 给模型**一段代码**。它可以在脚本里并发起 5 个 agent、自己过滤结果、只把结论带回来。
//   编排逻辑从「模型一轮一轮选」变成「一段代码」。这正是 DESIGN.md 那句
//   「通过代码，这种极具有逻辑的方式来使用大语言模型」在**模型侧**的那一半。
//
// 三个关键设计（都在本示例里看得见）：
//   1. **能力白名单**：设计者声明沙箱里能碰哪些面；没声明的**连存在都看不见**
//   2. **限一层**：沙箱里 spawn 出来的子 agent **不再有沙箱**，避免无限递归
//   3. **只回一条结果**：脚本里跑 50 次调用，回到模型面前的只有 return 的那点东西（省上下文）
//
// 跑法：node examples/13-sandbox.ts
import { createSandbox } from "../src/index.ts";
import { lab, makeOfflineAgent, sentTools } from "./lib/harness.ts";

const agent = await makeOfflineAgent();

console.log("\n[1] 造一个沙箱工具：给 spawn / prompt / list_agents / dispose 四个能力");
const sandbox = createSandbox({
  lab,
  agent,
  capabilities: ["spawn", "prompt", "list_agents", "dispose"],
});
console.log(`    已声明：${sandbox.capabilities.join("、")}`);

console.log("\n[2] 加进 agent（就是一个普通工具，不新增机制）");
await agent.io.waitIdle();
await agent.tools.add(sandbox.tool);
console.log(`    tools.list() = ${agent.tools.list().map((t) => `${t.name}:active=${t.active}`).join(", ")}`);

console.log("\n[3] 判据 a：模型下一轮**真的收到**这个工具（不是我们自说自话）");
await agent.io.prompt("你好");
const received = sentTools();
console.log(`    模型实际收到的工具：${received.join(", ")}`);
console.log(`    含 codemode：${received.includes("codemode")}`);

console.log("\n[4] 判据 b：沙箱描述里**只有**声明过的能力（未声明的连存在都看不见）");
const def = sandbox.tool as unknown as { description?: string };
for (const name of ["spawn", "prompt", "list_agents", "dispose"]) {
  console.log(`    提到 tools.${name}：${String(def.description).includes(`tools.${name}`)}`);
}
for (const name of ["perm_only", "tools_add", "interrupt"]) {
  console.log(`    提到 tools.${name}（未声明，应为 false）：${String(def.description).includes(`tools.${name}`)}`);
}

console.log("\n[5] 判据 c：直接跑一段脚本，看沙箱真的在编排（绕过模型，只看管道）");
const runnable = sandbox.tool as unknown as {
  execute(
    id: string,
    p: { script: string },
  ): Promise<{ content: { text: string }[]; details: { ok: boolean; calls: unknown[] } }>;
};
// 这段脚本做的事：**并发起 3 个子 agent**，各问一句，自己挑出最短的回答。
// —— 串行做法要让模型走 6 轮以上（3 次 spawn + 3 次 prompt）；这里 1 轮、1 条工具结果。
//
// 注意：不能 prompt **自己** —— agent 忙时 prompt 会被拒（这是真实的限制，示例里特意避开）。
const out = await runnable.execute("demo-1", {
  script: `
    const qs = ["说一个字", "说两个字", "说三个字"];
    const kids = await Promise.all(qs.map(() => tools.spawn({ role: "回答者" })));
    const answers = await Promise.all(kids.map((k, i) => tools.prompt({ id: k.id, text: qs[i] })));
    const shortest = answers.map(a => a.text).sort((a, b) => a.length - b.length)[0];
    kids.forEach(k => tools.dispose({ id: k.id }));
    return { 起了几个: kids.length, 最短的回答: shortest };
  `,
});
console.log(`    脚本跑了：ok=${out.details.ok}，调用 ${out.details.calls.length} 次`);
console.log("    回到模型面前的内容：");
for (const line of out.content[0].text.split("\n").slice(0, 6)) console.log(`      ${line}`);

console.log("\n[6] 判据 d：沙箱是隔离的（脚本摸不到 process / require）");
console.log("    （见 dev/test/sandbox.test.ts 里的隔离性用例 —— 已实测四项全 false）");

sandbox.close();
agent.dispose();
console.log("\n完成。要点：编排逻辑写进了代码，模型一轮就能干完多件事，且能力边界由设计者说了算。");
