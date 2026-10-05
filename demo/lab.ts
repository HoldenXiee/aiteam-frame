// 实验起点：一个文件，一条直线。
//
// 跑法：node demo/lab.ts
// 期望：环境自检四条都 ✓，agent 回话，退出码 0。
//
// 学习方式：**每一段是一个可以改的旋钮**，改完再跑，看输出变了什么。
// 每段都标了「改这里」。改坏了没关系，git checkout demo/lab.ts 就回来了。
import { lab, MODEL, agentDir, cwd } from "./env.ts";
import type { AgentSpec } from "../src/index.ts";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** demo/ —— 也就是 cwd（demo/work）的祖先目录，用来验实验室边界 */
const here = dirname(agentDir);
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, readFileSync, statSync } from "node:fs";

// ─────────────────────────────────────────────────────────────
// 第 1 段：环境自检 —— 这套环境里实际生效了什么（不建 agent、不花钱）
// 改这里：把打印顺序换一换，或者加别的判断
// ─────────────────────────────────────────────────────────────
console.log("[1] 环境自检");

const report = await lab.inspectEnv();

console.log(`    agentDir: ${report.agentDir}`);
console.log(`    cwd:      ${report.cwd}`);
console.log(`    我预期的: ${agentDir} / ${cwd}  ${report.agentDir === agentDir && report.cwd === cwd ? "✓" : "✗ 不一致！"}`);

// 模型：只列「配好凭证、现在就能用」的
for (const group of report.models) {
  console.log(`    模型 ${group.provider}: 可用 ${group.available.length} / 目录里 ${group.total}`);
}
// 你这份 MODEL（provider/id）在不在可用列表里 —— 这是真正会绊倒你的那一环
const [wantProvider, wantId] = MODEL.split("/");
const group = report.models.find((g) => g.provider === wantProvider);
const modelOk = group?.available.includes(wantId) ?? false;
console.log(`    我用的 ${MODEL} … ${modelOk ? "✓ 在位" : "✗ 不在可用列表里（凭证没配 / id 拼错 / provider 名不对）"}`);

// 技能与扩展：列出来，然后跟 ls demo/agent/ 眼睛看到的对一遍
console.log(`    技能 ${report.skills.length} 个: ${report.skills.map((s) => s.name).join(", ") || "（无）"}`);
for (const e of report.extensions) {
  console.log(`    扩展 ${e.path.split(/[\\/]/).pop()}: 注册了工具 [${e.tools.join(", ")}]`);
}

// ⚠️ 这个字段必须打印：库以前静默吞掉的东西全在这里
console.log(`    warnings: ${report.warnings.length} 条`);
for (const w of report.warnings) console.log(`      · ${w}`);

// 上下文文件链（R49）：实验室边界 = {agentDir} ∪ {cwd 子树}。
// 本仓库根的 AGENTS.md 在 cwd 的**祖先**里 —— 按设计不该进来，所以这里应该是空的。
console.log(`    上下文文件: ${report.contextFiles.length} 个 ${JSON.stringify(report.contextFiles.map((f) => f.replace(/.*[\\/]/, "…/")))}`);
console.log(
  `       判断：${report.contextFiles.length === 0 ? "✓ 实验室外（含仓库根 AGENTS.md）都没进来" : `⚠ 有 ${report.contextFiles.length} 个 —— 确认是不是实验室边界内的`}`,
);

// ─────────────────────────────────────────────────────────────
// 第 2 段：把 spec 的每个字段都写一遍 —— 一个字段一个旋钮
//
// 说完「定 spec」再「起」：**其实是一步**（没有单独的 start()）。但拆成两步有用：
//   a) spec 是普通对象，可以先打印、先检查、先存进数组，想改几版都行；
//   b) 起多个 agent 时把它当「成员定义」复用 —— 那是使用者代码，不是库的概念。
//
// ⚠️ 下面每个字段都故意只放**一个**值，注释里写了「怎么改」。
//    一次只改一处，跑一遍，看输出变了什么。（全开太多，会互相掩盖）
// ─────────────────────────────────────────────────────────────
console.log("\n[2a] 定 spec（创建参数，不是模板；库不保存它）");

// 一个**真能干活**的自定义工具：统计工作目录里的文件（字数 / 行数 / 大小）。
//
// 它不是玩具：execute 里真的去读文件系统了。看清楚三件事——
//   ① description 是模型判断「什么时候该用我」的**唯一**依据；
//   ② parameters 是 JSON Schema，params 的类型由它推出来（写错字段名 tsc 会报）；
//   ③ 返回值必须是 { content, details }，content 是**数组**。
/** details 的形状必须是**一个**类型：四个分支返回不同的 details，不标注的话 tsc 会拿第一个分支的字面量
 *  当契约，后面几个分支就全报错。（工具给你自己看的数据，模型看不到；随便放什么都行。） */
type FileStatsDetails = {
  kind: "list" | "stats" | "denied" | "error";
  count?: number;
  file?: string;
  words?: number;
  lines?: number;
  bytes?: number;
  message?: string;
};

const fileStats = defineTool({
  name: "file_stats",
  label: "File Stats",
  description:
    "统计工作目录里某个文件的字数、行数和字节数。参数 file 是文件名（不是绝对路径），" +
    "留空则列出工作目录里所有文件。",
  parameters: Type.Object({
    file: Type.Optional(Type.String({ description: "文件名，如 notes.md；留空则列出全部文件" })),
  }),
  execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: FileStatsDetails }> => {
    // cwd 从 env.ts 来 —— 与 agent 的 cwd 是同一个目录，所以它看到的就是 agent 看到的地方
    if (!params.file) {
      const names = readdirSync(cwd, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => `${d.name} (${statSync(join(cwd, d.name)).size} 字节)`);
      return {
        content: [
          { type: "text" as const, text: names.length ? `工作目录里的文件：\n${names.join("\n")}` : "工作目录是空的" },
        ],
        details: { kind: "list", count: names.length } as const,
      };
    }

    // 防目录穿越：只允许读工作目录里的文件（★ 信任边界，不能省 ★）
    const target = join(cwd, params.file);
    if (!target.startsWith(cwd)) {
      return { content: [{ type: "text" as const, text: `拒绝：只能统计工作目录里的文件` }], details: { kind: "denied" } as const };
    }

    let text: string;
    try {
      text = readFileSync(target, "utf8");
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `读不到 ${params.file}：${(e as Error).message}` }],
        details: { kind: "error", message: (e as Error).message } as const,
      };
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text, "utf8");
    return {
      content: [
        { type: "text" as const, text: `${params.file}：${words} 个词、${lines} 行、${bytes} 字节` },
      ],
      details: { kind: "stats", file: params.file, words, lines, bytes } as const,
    };
  },
});

const spec: AgentSpec = {
  // ① id：给这个分身起名。不写就自动生成（上次跑出来是 "a1"）。
  //    改这里：删掉这行，看 id 变成自动生成的什么
  id: "learner",

  // ② model：provider/id。从 env.ts 的 MODEL 来。
  //    改这里：换成 "opencode-go/glm-5.3" 或 "opencode-go/deepseek-v4-flash"，对比耗时与用量
  model: MODEL,

  // ③ thinking：思考档。可选 "off" | "low" | "medium" | "high"（取决于模型支不支持）。
  //    改这里：换成 "off" 再跑，对比耗时 —— 这是最直观的一个旋钮
  thinking: "high" as const,

  // ④ role：追加到系统提示词**尾部**（不是替换）。
  //    改这里：加一句「每句话结尾必须加 🙂」，看它照不照做 ——
  //    ⚠️ 这是**软约束**：靠模型读了照做，不是代码强制。它不照做不算 bug。
  role: "你在做一个环境自检实验。回答尽量短。",

  // ⑤ permissions：哪些工具**允许被调用**。★ 最硬的一块 ★
  //    only  = 精确白名单（集合就是这些）；allow = 并集启用；deny = 差集关掉。
  //    ⚠️ 只写 only: ["read"] 的话，下面第 ⑦ 项的自定义工具**看不见**（白名单是硬过滤）；
  //       但环境自动发现的扩展工具（本环境里有 env_checklist）**仍会出现** —— 这是已知的 R41，
  //       就是下面 [2b] 要你亲手验证的那条。
  //    改这里：试三种情况，每次只看「真实工具集」那一行
  //      a) 现在是 only: ["read"]              → read, file_stats（创建期声明自动并入）
  //      b) 整段注释掉                              → read, bash, edit, write, file_stats, env_checklist
  //      c) 改成 only: ["file_stats"]            → 只剩 file_stats —— 这是最该亲眼看一次的效果
  permissions: { only: ["read"] },

  // ⑥ tools.custom：塞自定义工具进去（用代码定义，不落文件）。
  //    创建期声明会自动并入 only 白名单 —— 所以下面只写了 ["read"]，file_stats 照样在。
  //    （运行期 tools.add() 就**不会**自动并入，那时 only 里必须写它 —— 两种挂法的真差别）
  tools: { custom: [fileStats] },

  // ⑦ extensions / skills：**精确白名单**（新语义，R48）。
  //    不写 = 环境自动发现的全部给；写了 = 集合就是这些；`[]` = 一个都没有。
  //    改这里：把下面两行取消注释，一次只看一行，对比 [2b] 的「真实工具集」
  //      skills: ["env-style"],      → 只留环境里那个技能（写名字，不用写路径）
  //      skills: [],                → 一个技能都没有（上下文里再也没有 <available_skills> 段）
  //      extensions: [],            → 环境扩展不加载，env_checklist 从工具集里消失
  //      extensions: ["<绝对路径>"],  → 只加载指定的那个扩展
  //    ⚠️ 白名单**只裁环境自动发现的那部分**，不裁运行期 tools.add / skills.add 追加的东西。

  // ⑧ context.autoCompact：上下文快满时自动压缩。默认 true。
  //    改这里：改成 false 再跑，看 inspectEnv 打印的 context 用量有没有区别（短会话看不出，属于正常）
  context: { autoCompact: true },

  // ⑦ 的两个字段（见上面的注释）。默认不写 = 环境全给。
  // skills: ["env-style"],
  // skills: [],
  // extensions: [],
};

console.log(`    ① id          = ${spec.id}`);
console.log(`    ② model       = ${spec.model}`);
console.log(`    ③ thinking    = ${spec.thinking}`);
console.log(`    ④ role        = ${spec.role}`);
console.log(`    ⑤ permissions = only=${JSON.stringify(spec.permissions?.only)}`);
console.log(`    ⑥ tools.custom= [${(spec.tools?.custom ?? []).map((t) => t.name).join(", ")}]`);
console.log(`    ⑦ skills      = ${spec.skills === undefined ? "不写（环境技能全给）" : JSON.stringify(spec.skills)}`);
console.log(`    ⑦ extensions  = ${spec.extensions === undefined ? "不写（环境扩展全给）" : JSON.stringify(spec.extensions)}`);
console.log(`    ⑧ autoCompact = ${spec.context?.autoCompact}`);
console.log(`    → spec 就是个普通对象，库不保存它。改上面任意一行，下面全部跟着变`);

// ─────────────────────────────────────────────────────────────
// [2b] 起 agent —— 到这里才真的创建。一行。
// ─────────────────────────────────────────────────────────────
console.log("\n[2b] 起 agent");

const agent = await lab.createAgent(spec);
console.log(`    id=${agent.id}  status=${agent.status}`);
// 两行的区别（实测）：tools.list() 读的是 aiteam 自己那张表（bridge.tools），
// **只有 agent.tools.add() 会往里写** —— 所以 spec.tools.custom 的 ping、pi 自带的 read、
// 环境扩展的 env_checklist 都不在里面，这里永远是「（无）」。它是用来调试运行期增删工具的。
// 要知道「现在真能干什么」，只能看 io.raw.getActiveToolNames()（raw = 全权出口）。
console.log(`    库登记的工具: [${agent.tools.list().map((t) => t.name + (t.active ? "" : "(关)")).join(", ") || "（无）—— 这个字段只有调过 tools.add() 才会有东西"}]`);
console.log(`    真实工具集:   [${agent.io.raw.getActiveToolNames().join(", ")}]`);
console.log(`    当前模型:     ${agent.model.current?.provider}/${agent.model.current?.id}`);
console.log(`    当前思考档:   ${agent.model.thinking}`);

// ─────────────────────────────────────────────────────────────
// 第 3 段：交办 —— 这一轮直接试试你那个工具
// 改这里：三个提示词挨个跑，看它调不调、参数传得对不对
//         · "用 file_stats 说说工作目录里有什么"       ← 留空 file，走分支一
//         · "先写一个 notes.md，里面有 20 个词，再用 file_stats 统计它" ← 两轮工具串起来
//         · "统计一下 C:/Windows/System32 有多少词"   ← 试越界，看防穿越那一行拦不拦
// ─────────────────────────────────────────────────────────────
console.log("\n[3] 交办");

const t0 = Date.now();
const result = await agent.io.prompt("用 file_stats 说说工作目录里有什么文件，并简述你的工具能干什么");
console.log(`    耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 四个字段都要看，尤其 error：pi 对「接受之后失败」不 reject，只写进这里
if (result.error) {
  console.log(`    ✗ 这一轮失败了：${result.error}`);
} else {
  console.log(`    说：${result.text}`);
}
console.log(`    本次运行: in=${result.usage.input} out=${result.usage.output} tokens=${result.usage.totalTokens}`);
console.log(`    全生命周期: tokens=${agent.usage.totalTokens}  （和上一行语义不同，别混）`);
console.log(`    本次覆盖 ${result.messages.length} 条消息，runId=${result.runId}`);

// ─────────────────────────────────────────────────────────────
// 第 4 段：观测 —— 看它调了什么工具
// 改这里：换成 onAny((e) => console.log(e.type)) 看一轮里有多少种事件
// ─────────────────────────────────────────────────────────────
console.log("\n[4] 观测：再问一句，这次把工具调用打出来");

const off = agent.on("tool_call", (event) => {
  console.log(`    它调了工具：${event.toolName}`);
});

const second = await agent.io.prompt("列出当前工作目录里的文件名");
off(); // 退订：不然下次还会打

if (second.error) console.log(`    ✗ ${second.error}`);
else console.log(`    说：${second.text.slice(0, 120)}${second.text.length > 120 ? "…" : ""}`);

// ─────────────────────────────────────────────────────────────
// 第 5 段：实验室边界（R49）—— 真跑一遍，看边界是不是活的
//
// 判据（不用看代码，看输出就能判）：在 cwd 的**祖先**目录（demo/）放一个 AGENTS.md，
// 它**不应**进这个 agent 的系统提示词；放在 cwd **自己**里则应该进。
// 想验证它真的起作用：把 loader.ts 里那行 agentsFilesOverride 注释掉再跑 —— 第一条会变 ✗。
// ─────────────────────────────────────────────────────────────
console.log("\n[5] 实验室边界：祖先目录的 AGENTS.md 该被挡住，cwd 自己的该保留");

const ancestorProbe = join(here, "AGENTS.md"); // here = demo/（cwd 的祖先）
const ownProbe = join(cwd, "AGENTS.md"); // cwd 自己
let ancestorCreated = false;
let ownCreated = false;
try {
  if (!existsSync(ancestorProbe)) {
    writeFileSync(ancestorProbe, "ANCESTOR-BOUNDARY-MARKER（这是实验室外的文件）\n");
    ancestorCreated = true;
  }
  if (!existsSync(ownProbe)) {
    writeFileSync(ownProbe, "CWD-BOUNDARY-MARKER（这是实验室内的文件）\n");
    ownCreated = true;
  }

  const probe = await lab.createAgent({ model: MODEL, id: "boundary", skills: [] });
  const sys = probe.io.raw.systemPrompt;
  const ancestorLeaked = sys.includes("ANCESTOR-BOUNDARY-MARKER");
  const ownKept = sys.includes("CWD-BOUNDARY-MARKER");
  probe.dispose();

  console.log(`    祖先 ${ancestorProbe}`);
  console.log(`      → system 里有它吗？ ${ancestorLeaked ? "✗ 漏进来了（R49 没生效）" : "✓ 挡住了"}`);
  console.log(`    自己 ${ownProbe}`);
  console.log(`      → system 里有它吗？ ${ownKept ? "✓ 保留了" : "✗ 被误杀"}`);
  console.log(`    判断：${!ancestorLeaked && ownKept ? "✓ 边界是对的：只认 cwd 子树" : "✗ 不符合设计"}`);
} finally {
  // 探针文件必须清掉：留着它们会静默改变下次运行的结果（尤其 ownProbe 会进系统提示词）
  if (ancestorCreated) rmSync(ancestorProbe);
  if (ownCreated) rmSync(ownProbe);
  console.log("    （探针文件已清理）");
}

// ─────────────────────────────────────────────────────────────
// 第 6 段：收尾
// 改这里：试试不 dispose 会怎样（进程会挂着不退出）
// ─────────────────────────────────────────────────────────────
agent.dispose();
console.log(`\n[6] dispose 后 status=${agent.status}`);
