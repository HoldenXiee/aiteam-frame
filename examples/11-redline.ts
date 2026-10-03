// ⚠️ 这是一个【假设】，不是推荐做法：
//    「agent 不该能配置 agent」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请把下面的红线守卫（extras 检查）整段注释掉再跑，看 agent 会不会自己尝试设计 agent。

// 11-redline：v1 的「红线」假设 —— spawn 只收「要谁」与「干什么」，不收配置。
//
// 判别力：模型**真的发起了两次 spawn 调用**，第一次带 tools / model 配置字段、
// 第二次守法。第一次被使用者代码里那段 extras 检查拦在 createAgent 之前
// （真起的子 agent 数不涨）；第二次放行，并且子 agent 实际收到的工具声明
// （从 faux.calls 读的 ground truth）是脚本写死的 read，而不是模型第一次要的 bash。
// 另外注意：createAgent 里有两行【故意留的洞】会读模型带进来的 model / tools —— 把红线守卫
// 注释掉，模型要的配置就真的会被接进子 agent（对照实验与真实输出见文件末尾）。
//
// 跑法：node examples/11-redline.ts
// 期望看到：带配置字段的那次被拒、理由回到父 agent 面前、子 agent 数为 0；
// 只带 role / task 的那次放行，子 agent 的工具声明只有 read。
//
// 若要用真模型：光换 model ref 不够 —— 临时 agentDir 里只有假 provider 的 models.json，
// 换没有声明的模型会被 aiteam 当错误抛（不是警告）。请把 makeOfflineAgent 的 agentDir 和
// model 都换成你自己的（真 key 在 ~/.pi/），并去掉 examples/lib/harness.ts 里钉死的
// PI_OFFLINE=1。（运行期换模型走 agent.model.set(...)，见 07-model.ts。）
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent } from "../src/index.ts";
import type { Agent } from "../src/index.ts";
import { faux, fauxAgentDir, fauxCwd, FAUX_MODEL_REF, makeOfflineAgent } from "./lib/harness.ts";

// ─────────────── 使用者代码：红线 ───────────────
// spawn 的参数表只有两个位置是对的：要谁、干什么。其余一律是「想配置 agent」。
// 允许的键只有下面这一份：拒绝逻辑与运行时的打印都从它来，不再维护第二份列举。
const ALLOWED = ["role", "task"];

const redline: string[] = [];
const children: Agent[] = [];

const spawn = defineTool({
  name: "spawn",
  label: "Spawn",
  description: "给一个新的子 agent 派一件活：只能传 role 与 task",
  parameters: Type.Object({ role: Type.String(), task: Type.String() }),
  execute: async (_id, params) => {
    // ── 红线守卫就在下面（它是使用者代码，不是库的能力；注释掉它 = 放开配置权）──
    // 这条检查依赖 pi 把 schema 未声明的参数原样传进 execute（TypeBox 的 Object 不带
    // additionalProperties:false，extra 键不会在入口被剥掉）；若哪天 pi 改成剥掉未知属性，
    // extras 会静默变成空数组 —— 步骤 [2] 会打印「✓ 放行」而不是「✗ 拦下」。
    const raw = params as unknown as Record<string, unknown>;
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
    // ── 红线守卫结束 ──
    redline.push(
      extras.length
        ? `✓ 放行（红线被注释掉了，这次带进来的 extras=[${extras.join("、")}] 会真的生效）`
        : `✓ 放行（只有 role / task）：role="${params.role}" task="${params.task}"`,
    );

    // ── 下面一行是【故意留的洞】：createAgent 会读模型带进来的可选配置，而不是视而不见。
    //    默认状态下红线守卫把带配置的调用拦在入口，模型永远走不到这里；把上面那段守卫注释掉，
    //    这个洞就会把模型要的 model / tools 当真接进子 agent —— 那才是「agent 自己设计 agent」的后果。
    const wanted = params as unknown as { model?: string; tools?: string[] };
    const child = await createAgent({
      agentDir: fauxAgentDir,
      cwd: fauxCwd,
      model: wanted.model ?? FAUX_MODEL_REF,
      modelNetwork: false,
      role: params.role,
      permissions: { only: wanted.tools ?? ["read"] }, // 默认 read；模型给了 tools 就按它来
    });
    children.push(child);
    const res = await child.io.prompt(params.task);
    const childCall = faux.calls[faux.calls.length - 1];
    const declared = childCall?.tools ?? [];
    redline.push(
      extras.length
        ? `  子 agent 实际请求：model=${childCall?.model ?? "?"}、工具声明=[${declared.join(", ")}]（模型要的配置被洞接进去了）`
        : `  子 agent 实际请求：model=${childCall?.model ?? "?"}、工具声明=[${declared.join(", ")}]（脚本默认值，不是模型第一次要的 bash / faux/echo-alt）`,
    );
    return { content: [{ type: "text" as const, text: `[${params.role}] ${res.text}` }], details: {} };
  },
});

const agent = await makeOfflineAgent({ tools: { custom: [spawn] } });

console.log("[1] 红线（写在 spawn 工具里的使用者代码，不是库的能力）");
console.log("    spawn 的参数表只有 role / task；其余字段一律拒绝（具体是哪些字段，看下面运行时的拒绝明细，不维护第二份列举）");

console.log('[2] 让模型试一次「设计 agent」：spawn 里带上 tools 与 model');
const bad = await agent.io.prompt(
  '[[tool:spawn]] [[args:{"role":"researcher","task":"帮我查点东西","tools":["bash"],"model":"faux/echo-alt"}]]',
);
if (bad.error) throw new Error(`这一轮失败了：${bad.error}`);
for (const line of redline) console.log(`    [红线] ${line}`);
console.log(`    父 agent 读到的工具结果：${bad.text}`);
console.log(`    真起了几个子 agent：${children.length}${children.length === 0 ? "（拦在 createAgent 之前）" : ""}`);

console.log("[3] 守法调用：只传 role 与 task");
const seen = redline.length;
const ok = await agent.io.prompt('[[tool:spawn]] [[args:{"role":"researcher","task":"列出三条要点"}]]');
if (ok.error) throw new Error(`这一轮失败了：${ok.error}`);
for (const line of redline.slice(seen)) console.log(`    [红线] ${line}`);
console.log(`    父 agent 的回答：${ok.text}`);
console.log(`    真起了几个子 agent：${children.length}`);

agent.dispose();
for (const child of children) child.dispose();
console.log("\n要检验这条假设：把上面 `红线守卫` 那段 if（extras 检查）整段注释掉再跑。");
console.log("第 [2] 步就会直接起子 agent，而 createAgent 里那两行故意留的洞（model / tools 透传）会把模型要的");
console.log("配置当真 —— 你会看到子 agent 的实际请求变成 model=echo-alt、工具声明=[bash]（不是 read）。");
console.log("那就是「agent 自己设计 agent」的后果：配置企图从『被明确拒绝』变成『真的生效』。");
console.log("脚本正常结束，退出码 0");
