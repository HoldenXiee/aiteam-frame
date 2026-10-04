// ⚠️ 这是一个【假设】，不是推荐做法：
//    「委派给分身能扩展能力」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请把下面的 MAX_DEPTH 从 2 改成 1（或去掉那道检查），看结果怎么变。

// 10-spawn：v1 的「委派/分身」假设 —— 一个 spawn 工具，内部起子 agent 并把结果当工具返回值。
//
// 判别力：模型真的发起 spawn 调用，工具真的 `createAgent` 起了一个子 agent、真的 `await io.prompt`，
// 子 agent 的文本真的作为工具结果回到父 agent 面前 —— 每一环都打印（faux.calls 的条数涨了 3 条：
// 父的请求 / 子 agent 的请求 / 父拿到结果后的收尾请求）。
// 深度计数器是**使用者代码**：库里没有 maxDepth 这种东西。所以这里直接让第 2 层的子 agent
// 再往下派一次 —— 计数器的拒绝日志与「子 agent 数仍是 1」就是它真的生效的证据。
//
// 跑法：node examples/10-spawn.ts
// 期望看到：第 1 层派活被允许并起了第 2 层子 agent；第 2 层再往下派被 MAX_DEPTH 拦下；
// 全程真起了 1 个子 agent，父 agent 拿到的是子 agent 的文本。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。请把 makeOfflineAgent 的 agentDir 和
// model 都换成你自己的（真 key 在 ~/.pi/），并去掉 examples/lib/harness.ts 里钉死的
// PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Agent, AgentTool } from "../src/index.ts";
import { faux, FAUX_MODEL_REF, lab, makeOfflineAgent, sentTools } from "./lib/harness.ts";

// ─────────────── 使用者代码：深度护栏 ───────────────
// 库不给护栏，所以「最多几层」这件事只能自己数。改成 1 就是本文件要你去做的那个检验。
const MAX_DEPTH = 2;

/** 计数器每次判定的原样记录 */
const log: string[] = [];
/** 真被起起来的子 agent（拿它们当证据：数量不涨 = 拒绝真的发生了） */
const spawned: { depth: number; role: string; agent: Agent }[] = [];

/** depth = 调用者所处的层数；父 agent 是第 1 层，它起出来的子 agent 是第 2 层。 */
function spawnTool(depth: number): AgentTool {
  return defineTool({
    name: "spawn",
    label: "Spawn",
    description: "把一件活派给一个新的子 agent，拿它的文本结果",
    parameters: Type.Object({ role: Type.String(), task: Type.String() }),
    execute: async (_id, params) => {
      const what = `role="${params.role}" task="${params.task}"`;
      if (depth >= MAX_DEPTH) {
        log.push(`✗ depth=${depth} >= MAX_DEPTH=${MAX_DEPTH} → 拒绝 ${what}`);
        return {
          content: [{ type: "text" as const, text: `拒绝：当前深度 ${depth} 已达上限 ${MAX_DEPTH}，不再往下派。` }],
          details: {},
        };
      }
      log.push(`✓ depth=${depth} < MAX_DEPTH=${MAX_DEPTH} → 起子 agent（第 ${depth + 1} 层） ${what}`);
      // 子 agent 也会拿到 spawn 工具（层数 +1）—— 递归真的可能发生，所以计数器不是摆设。
      const child = await lab.createAgent({
        model: FAUX_MODEL_REF,
        role: params.role,
        tools: { custom: [spawnTool(depth + 1)] },
      });
      spawned.push({ depth: depth + 1, role: params.role, agent: child });
      const res = await child.io.prompt(params.task);
      // 子 agent 的结果就是这次工具调用的返回值 —— 父 agent 下一步读到的就是它
      return {
        content: [{ type: "text" as const, text: `[第 ${depth + 1} 层 ${params.role}] ${res.text}` }],
        details: {},
      };
    },
  });
}

const parent = await makeOfflineAgent({ tools: { custom: [spawnTool(1)] } });

console.log(`[1] 深度上限 MAX_DEPTH = ${MAX_DEPTH}（使用者代码里的一个计数器，库不提供护栏）`);

console.log('[2] 父 agent（第 1 层）派活给一个子 agent：模型真的发起 spawn 调用');
const callsBefore = faux.calls.length;
const ok = await parent.io.prompt('[[tool:spawn]] [[args:{"role":"researcher","task":"列出三条要点"}]]');
if (ok.error) throw new Error(`这一轮失败了：${ok.error}`);
console.log(`    父 agent 收到的工具声明里有没有 spawn：${sentTools().includes("spawn")}`);
for (const line of log) console.log(`    [计数器] ${line}`);
console.log(`    真起了几个子 agent：${spawned.length} → ${spawned.map((s) => `第 ${s.depth} 层 ${s.role}`).join("、")}`);
console.log(`    父 agent 的回答（= 子 agent 的文本被当值传回来）：${ok.text}`);
console.log(`    faux 收到的请求数：${callsBefore} → ${faux.calls.length}（父的请求 / 子 agent 的请求 / 父拿到结果后的收尾）`);

console.log("[3] 反证计数器真的会咬：直接让第 2 层子 agent 再往下派一次");
const grandBefore = spawned.length;
const seen = log.length;
const child = spawned[0].agent;
const nested = await child.io.prompt('[[tool:spawn]] [[args:{"role":"analyst","task":"再往下派一个"}]]');
if (nested.error) throw new Error(`这一轮失败了：${nested.error}`);
for (const line of log.slice(seen)) console.log(`    [计数器] ${line}`);
console.log(`    第 2 层子 agent 的回答：${nested.text}`);
console.log(`    子 agent 数：${grandBefore} → ${spawned.length}（没涨：没有孙子）`);

parent.dispose();
for (const s of spawned) s.agent.dispose();
console.log(`\n要检验这条假设：把 MAX_DEPTH 从 ${MAX_DEPTH} 改成 1 —— 第 [2] 步那次调用（depth=1 >= 1）当场被拒，`);
console.log("父 agent 的回答会变成拒绝文本、子 agent 数为 0；去掉那道 if，第 [3] 步就会再多出一个孙子。");
console.log("脚本正常结束，退出码 0");
