// ⚠️ 这是一个【假设】，不是推荐做法：
//    「预定义成员能约束 agent 的行为」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请删掉下面的花名册、让 spawn 的 role 接受任意字符串，跑同一个任务对比结果。

// 09-roster：v1 的「花名册」假设 —— 一张成员表，agent 只能从中挑人。
//
// 判别力：让模型**真的发起两次 spawn 调用**（假 provider 的 [[tool:...]] 脚本约定），
// 一次挑花名册里的 researcher、一次挑花名册外的 ceo。判定只发生在使用者代码的那次
// `roster.get(role)` 里，`decisions` 数组把它的每次判定原样记下来。
// 子 agent 实际收到的工具声明从假服务的请求记录 `faux.calls` 里读 —— 花名册写 read，
// 子 agent 就只能收到 read；这是「花名册约束了行为」的 ground truth，不是声明。
//
// 跑法：node examples/09-roster.ts
// 期望看到：花名册两条成员；第一次 spawn 命中 researcher、真起了一个子 agent
// （工具声明只有 read）；第二次 spawn 被花名册挡下，父 agent 读到拒绝理由。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。改成自己 createLab({ agentDir, cwd })
// 起一个实验室（agentDir 指你自己的环境，真 key 在 ~/.pi/agent），模型在 lab.createAgent 的
// spec 里换，并去掉 examples/lib/harness.ts 里钉死的 PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { faux, FAUX_MODEL_REF, lab, makeOfflineAgent } from "./lib/harness.ts";

// ─────────────── 使用者代码：花名册 ───────────────
// 成员名 → 它的角色描述 + 工具白名单。库对这张表一无所知，它只是这个脚本里的一个 Map。
const roster = new Map<string, { role: string; tools: string[] }>([
  ["researcher", { role: "研究员：只查资料、给结论，别的都不做", tools: ["read"] }],
  ["writer", { role: "写手：把材料写成一段通顺的话", tools: ["read", "write"] }],
]);

/** 花名册那次检查实际做了什么（打印用的事实记录，不是装饰） */
const decisions: string[] = [];
/** 真正起起来的子 agent 数 —— 拒绝发生在 createAgent 之前，所以它不会涨 */
let childCount = 0;

const spawn = defineTool({
  name: "spawn",
  label: "Spawn",
  description: "从花名册里挑一个角色，把一件活派给它",
  parameters: Type.Object({ role: Type.String(), task: Type.String() }),
  execute: async (_id, params) => {
    // 全部「约束」就是这一行查表：查不到 → 拒绝，agent 没有别的入口。
    const member = roster.get(params.role);
    if (!member) {
      const reason = `拒绝：花名册里没有「${params.role}」这个角色。可选：${[...roster.keys()].join("、")}`;
      decisions.push(`✗ ${reason}`);
      return { content: [{ type: "text" as const, text: reason }], details: {} };
    }
    decisions.push(`✓ 选中「${params.role}」→ role="${member.role}" tools=[${member.tools.join(", ")}]`);

    const child = await lab.createAgent({
      model: FAUX_MODEL_REF,
      role: member.role,
      permissions: { only: member.tools }, // 花名册说的工具，就是子 agent 能看到的全部
    });
    childCount += 1;
    const res = await child.io.prompt(params.task);
    // 子 agent 这一轮模型**实际收到**的工具声明（假服务的请求记录，ground truth）
    const declared = faux.calls[faux.calls.length - 1]?.tools ?? [];
    decisions.push(`  子 agent 收到 prompt="${params.task}"，工具声明=[${declared.join(", ")}]，回复=${JSON.stringify(res.text)}`);
    child.dispose();

    return { content: [{ type: "text" as const, text: `[${params.role}] ${res.text}` }], details: {} };
  },
});

const agent = await makeOfflineAgent({ tools: { custom: [spawn] } });

console.log("[1] 花名册：库看不见的一张表，agent 只能挑，不能改也不能加");
for (const [name, m] of roster) console.log(`    ${name} → role="${m.role}" tools=[${m.tools.join(", ")}]`);

console.log("[2] 让模型发起一次 spawn，挑一个花名册里存在的角色（researcher）");
const ok = await agent.io.prompt('[[tool:spawn]] [[args:{"role":"researcher","task":"列出三条要点"}]]');
if (ok.error) throw new Error(`这一轮失败了：${ok.error}`);
for (const line of decisions) console.log(`    [花名册] ${line}`);
console.log(`    父 agent 拿到的工具结果 → 它的回答：${ok.text}`);
console.log(`    到这里真起了几个子 agent：${childCount}`);

console.log("[3] 让模型挑一个花名册里没有的角色（ceo）：查表挡下，没人被起起来");
const seen = decisions.length;
const bad = await agent.io.prompt('[[tool:spawn]] [[args:{"role":"ceo","task":"帮我写一段代码"}]]');
if (bad.error) throw new Error(`这一轮失败了：${bad.error}`);
for (const line of decisions.slice(seen)) console.log(`    [花名册] ${line}`);
console.log(`    父 agent 读到的拒绝理由：${bad.text}`);
console.log(`    到这里真起了几个子 agent：${childCount}（拒绝发生在 createAgent 之前，不会涨）`);

agent.dispose();
console.log("\n要检验这条假设：按文件头的改法删掉花名册，同一个任务就会让 agent 自由指定角色。");
console.log("脚本正常结束，退出码 0");
