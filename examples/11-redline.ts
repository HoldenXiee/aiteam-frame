// ⚠️ 这是一个【假设】，不是推荐做法：
//    「agent 不该能配置 agent」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请把下面的 extras 检查整段注释掉再跑，看 agent 会不会自己尝试设计 agent。

// 11-redline：v1 的「红线」假设 —— spawn 只收「要谁」与「干什么」，不收配置。
//
// 判别力：模型**真的发起了两次 spawn 调用**，第一次带 tools / model 配置字段、
// 第二次守法。第一次被使用者代码里那段 extras 检查拦在 createAgent 之前
// （真起的子 agent 数不涨）；第二次放行，并且子 agent 实际收到的工具声明
// （从 faux.calls 读的 ground truth）是脚本写死的 read，而不是模型第一次要的 bash。
//
// 跑法：node examples/11-redline.ts
// 期望看到：带配置字段的那次被拒、理由回到父 agent 面前、子 agent 数为 0；
// 只带 role / task 的那次放行，子 agent 的工具声明只有 read。
//
// 若要用真模型，改这两行：`makeOfflineAgent()` → `makeOfflineAgent({ model: "<provider>/<id>", modelNetwork: true })`
// （默认 ref 在 examples/lib/harness.ts；运行期换模型走 `agent.model.set(...)`，见 07-model.ts）。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import type { Agent } from "../src/index.ts";
import { faux, fauxAgentDir, fauxCwd, FAUX_MODEL_REF, makeOfflineAgent } from "./lib/harness.ts";

// ─────────────── 使用者代码：红线 ───────────────
// spawn 的参数表只有两个位置是对的：要谁、干什么。其余一律是「想配置 agent」。
const ALLOWED = ["role", "task"];
/** 顺手把这些写出来，是为了拒绝时说清「你带的哪个字段不行」 */
const CONFIG_FIELDS = "tools、model、thinking、permissions、extensions、skills、id";

const redline: string[] = [];
const children: Agent[] = [];

const spawn = defineTool({
  name: "spawn",
  label: "Spawn",
  description: "给一个新的子 agent 派一件活：只能传 role 与 task",
  parameters: Type.Object({ role: Type.String(), task: Type.String() }),
  execute: async (_id, params) => {
    // ── 红线就在这一段里（它是使用者代码，不是库的能力；删掉它就等于放开配置权）──
    const raw: Record<string, unknown> = { ...params };
    const extras = Object.keys(raw).filter((key) => !ALLOWED.includes(key));
    if (extras.length) {
      const detail = extras.map((key) => `${key}=${JSON.stringify(raw[key])}`).join("、");
      redline.push(`✗ 拦下带配置字段的调用：${detail}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `拒绝：spawn 只接受 role 与 task；收到的配置字段（${extras.join("、")}）一律不生效。子 agent 的工具与模型由设计者的代码决定，不由你决定。`,
          },
        ],
        details: {},
      };
    }
    // ── 红线结束 ──
    redline.push(`✓ 放行（只有 role / task）：role="${params.role}" task="${params.task}"`);

    const child = await createAgent({
      agentDir: fauxAgentDir,
      cwd: fauxCwd,
      model: FAUX_MODEL_REF,
      modelNetwork: false,
      role: params.role,
      permissions: { only: ["read"] }, // 这个 read 是脚本写死的，模型没得选
    });
    children.push(child);
    const res = await child.io.prompt(params.task);
    const declared = faux.calls[faux.calls.length - 1]?.tools ?? [];
    redline.push(`  子 agent 实际收到的工具声明=[${declared.join(", ")}]（脚本写死的 read，不是模型要的 bash）`);
    return { content: [{ type: "text" as const, text: `[${params.role}] ${res.text}` }], details: {} };
  },
});

const agent = await makeOfflineAgent({ tools: { custom: [spawn] } });

console.log("[1] 红线（写在 spawn 工具里的使用者代码，不是库的能力）");
console.log(`    spawn 的参数表只有 role / task；这些字段一律拒绝：${CONFIG_FIELDS}`);

console.log('[2] 让模型试一次「设计 agent」：spawn 里带上 tools 与 model');
const bad = await agent.io.prompt(
  '[[tool:spawn]] [[args:{"role":"researcher","task":"帮我查点东西","tools":["bash"],"model":"faux/echo-alt"}]]',
);
if (bad.error) throw new Error(`这一轮失败了：${bad.error}`);
for (const line of redline) console.log(`    [红线] ${line}`);
console.log(`    父 agent 读到的工具结果：${bad.text}`);
console.log(`    真起了几个子 agent：${children.length}（拦在 createAgent 之前）`);

console.log("[3] 守法调用：只传 role 与 task");
const seen = redline.length;
const ok = await agent.io.prompt('[[tool:spawn]] [[args:{"role":"researcher","task":"列出三条要点"}]]');
if (ok.error) throw new Error(`这一轮失败了：${ok.error}`);
for (const line of redline.slice(seen)) console.log(`    [红线] ${line}`);
console.log(`    父 agent 的回答：${ok.text}`);
console.log(`    真起了几个子 agent：${children.length}`);

agent.dispose();
for (const child of children) child.dispose();
console.log("\n要检验这条假设：把上面 `红线段` 里那三行（raw / extras / if）注释掉再跑，");
console.log("第 [2] 步就会直接起子 agent —— 模型带的 tools / model 也就成了你自己代码里的真配置。");
console.log("脚本正常结束，退出码 0");
