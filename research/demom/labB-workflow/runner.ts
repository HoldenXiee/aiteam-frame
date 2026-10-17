// 实验室 B 的驱动器：纯代码推进这张写死的图，**没有一步是模型决定的**。
//
// 与 A 的对照：
//   · A 的 `spawn` 是模型调用的工具；B 的「派活」是这里的一个 for 循环。
//   · A 的 agent 数是变量；B 的 = 阶段数（常数）。
//   · A 可能一直派活；B 跑完批次就停。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lab, MODEL, cwd } from "../env.ts";
import type { Agent, AgentMessage } from "../../../src/index.ts";
import { Meter, summarize, type RunRecord } from "../bench/measure.ts";
import { judge, TASK_BRIEF, type Verdict, REPORT_FILE } from "../bench/task.ts";
import { STAGES, topoBatches, toolByName, stagesFor, type Stage } from "./stages.ts";
import { resetScene } from "../bench/prep.ts";
import { newWorkbench, type Workbench } from "../bench/workbench.ts";

/**
 * 护栏的默认上限（每个阶段可以在 Stage.maxCalls 里覆写）。
 *
 * ★ 为什么需要它（实测）★
 * 补样本时撞上 **S5-校验失控**：拿了 read 反复读同一份报告，
 * 最重的一次 **423 次工具调用、547 万 tokens**（占那一次总用量的 96%），而无人拦。
 *
 * 关键认识：**A 的预算闸拦不住这个** —— A 的闸是在 `spawn` **之前**查的，
 * 而失控发生在**一个 agent 内部**。所以这是两种不同位置的护栏：
 *   · 闸（gate）：进门前查 —— 管“要不要再起一个”
 *   · 闸（cap）：干活时查 —— 管“这一个是不是停不下来”
 */
export const MAX_TOOL_CALLS = 100;

/** 跑一次完整的工作流 */
export async function runWorkflow(runNo: number, tag: string, variant = "base"): Promise<RunRecord> {
  resetScene(); // ★ 每轮之前重置，否则第 N 轮会看到第 N-1 轮的 draft/ 与 report.md（静默污染）
  const meter = new Meter();
  const stages = stagesFor(variant);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const batches = topoBatches(stages);

  let crashed: string | undefined;
  let rootError: string | undefined;
  /** 护栏记录：哪个阶段因为工具调用超限被中止 */
  const guarded: string[] = [];
  /** 审批门记录：哪些重复读被拦下（库的 permissions.gate） */
  const repeats: string[] = [];
  /** 中途纠正记录（库的 io.steer）：什么时侯拉了一把 */
  const steered: string[] = [];
  const useSteer = variant === "steer";
  /** board 变体：共享工作台（所有阶段共用一块） */
  const board: Workbench | undefined = variant === "board" ? newWorkbench() : undefined;
  /** 阶段 id → agent（share 变体要拿上游的上下文，所以得留着不 dispose） */
  const agentsById = new Map<string, Agent>();
  /** share 变体：注进下游的轨迹字符数（这是它相对“走文件”的代价） */
  let sharedChars = 0;
  const sharedFrom: string[] = [];

  for (const batch of batches) {
    // 同批次的阶段并行放（S2 与 S3 是并行的）
    await Promise.all(
      batch.map(async (stage: Stage) => {
        // ── 纯代码阶段：不起 agent，直接跑（B 相对 A 的结构性优势，见 stages.ts） ──
        if (stage.kind === "code") {
          try {
            const line = stage.run?.() ?? "（没有 run）";
            console.log(`      [code] ${stage.id}：${line}`);
            meter.noteCodeStage(stage.id, line);
          } catch (e) {
            crashed = `${stage.id} 崩了：${(e as Error).message}`;
          }
          return;
        }

        let agent: Agent | undefined;
        try {
          agent = await lab.createAgent({
            id: `B-${stage.id}-${runNo}`,
            model: MODEL, // ← 与 A 同一个模型（公平性自查表第 1 条）
            role: stage.role,
            permissions: { only: stage.tools },
            tools: {
              custom: [
                // `post` 由工作台提供（它需要 board 实例），不走 toolByName
                ...stage.custom.filter((n) => n !== "post").map((n) => toolByName(n, stage.id)),
                ...(board ? [board.postTool(stage.id)] : []),
              ],
            },
          });
          // 共享工作台：每轮注入黑板 + 读后即消化
          board?.attach(agent, stage.id);
          meter.watchAndKeep(agent, { role: stage.id, parent: null, depth: 1 });
          // 键用 agent.id（= `B-<阶段名>-<轮次>`）—— 下面按同一形状查，别用 stage.id
          agentsById.set(agent.id, agent);

          // ── 闸（cap）：干活时查工具调用数，超限就中止（防失控）──
          //
          // ★ 为什么不用 token 而用次数（实测）★
          // 先试了「按 agent.usage.totalTokens > 1M 中止」，**从来没触发过** ——
          // 因为库里的 `agent.usage` 是在 prompt **结算之后**才累加的
          // （io.ts 的 accumulate 在 all 循环里跑），**跑的过程中它是陈的**。
          // 所以拿它做实时闸是拿了一个不会动的读数。（这是本实验发现的库层缺口，已记进研究记录。）
          // 能用的是 `tool_call` 事件 —— 它是实时的。
          const cap = stage.maxCalls ?? 100;
          let calls = 0;
          let tripped = false;

          // ── ★ 中途纠正（库的 io.steer）：同**一个触发**，不同的**响应** ★ ──
          //
          // 动机：所有现有的护栏都是**事后**的 —— 撞上限 → abort → 这一轮白跑。
          // 而 pi 的 steer 是**实时**的：「当前这一轮工具调完、下一次请求之前」插一句话，
          // **不打断运行**。于是可以「把它拉回来」而不是「把它打死」。
          //
          // ★ 触发点踩过一次坑（记下来，因为它本身就是结论）★
          // 第一版触发是「连续 20 次调用没有 note/write」—— 结果**帮了倒忙**：
          // S1 读材料本来就要 44 次调用，那**就是它的活**，不是空转；
          // 于是它在第 20 次就被叫停，只读了 31 份，去重直接变差（M18≡M37 没合上）。
          //
          // 教训：**abort 的门槛可以设得很高（它是最后手段），
          // 但 corrective steer 会插进正常工作里，触发必须精确。**
          // 所以现在改成「**就在本来要 abort 的那个点上** steer」—— 同触发、不同响应，
          // 才是干净的对照。steer 之后还不收手，才真的 abort。
          const PRODUCTIVE = new Set(["note", "write", "record_groups"]);
          const MAX_STEERS = 2; // 拉两次还不听才放弃
          const GRACE = 30; // ★ 拉一把之后要**真的给它余地**（否则 steer 等于白拉）★
          let sinceOutput = 0;
          let steers = 0;
          let effectiveCap = cap;

          agent.on("tool_call", (e) => {
            calls++;
            if (PRODUCTIVE.has(e.toolName)) sinceOutput = 0;
            else sinceOutput++;

            if (calls <= effectiveCap || tripped) return;

            // 到了上限：steer 变体先拉一把，其余变体直接中止
            if (useSteer && steers < MAX_STEERS) {
              steers++;
              // 关键：拉完之后必须抬高上限。否则 steer 只是“把 abort 推迟两次调用”，
              // 模型还没来得及按你说的收尾就被打死了（实测就是这样：73 次才 abort，但它 70 次就被叫停）。
              effectiveCap = cap + GRACE * steers;
              steered.push(`${stage.id}（第 ${steers} 次，已 ${calls} 次调用，上限抬到 ${effectiveCap}）`);
              void agent!.io.steer(
                `停一下：你已经做了 ${calls} 次工具调用，**超出了这个阶段该有的量**。` +
                  `现在不要再读新的东西 —— 用 note（或 write）把你**已经知道**的结论立刻落下来，然后收尾。` +
                  `已经看过的内容不会因为你再看一遍而变多。`,
              );
              return;
            }
            tripped = true;
            guarded.push(`${stage.id}（${calls} 次调用 > 上限 ${effectiveCap}${steers ? `，拉过 ${steers} 次` : ""}）`);
            void agent!.io.abort();
          });

          // ── 闸（gate）：**按路径**拦重复读（库的 permissions.gate）──
          //
          // 实测：share 变体有一次 S4 把同一份 `corpus/M4-裁历史的三层.md` **读了 32 次**，
          // 一直读到撞上 70 次的上限被中止 —— 总闸只能**事后中止**，不能阻止浪费。
          //
          // 而「同一份文件读第 4 次」这件事**永远是错的**（信息不会变），
          // 所以可以用**审批门**在调用发生**之前**就拦掉，并告诉它该干什么。
          // 这就是 gate 与 cap 的分工：
          //   · cap 是**总量**闸，管“这一次整体是不是失控了”（只能中止）
          //   · gate 是**语义**闸，管“这一个具体动作是不是没意义”（可以纠正）
          const readCounts = new Map<string, number>();
          const REPEAT_LIMIT = 3;
          agent.permissions.gate((call) => {
            if (call.name !== "read") return undefined;
            const p = String((call.input as { path?: unknown } | undefined)?.path ?? "");
            if (!p) return undefined;
            const n = (readCounts.get(p) ?? 0) + 1;
            readCounts.set(p, n);
            if (n > REPEAT_LIMIT) {
              repeats.push(`${stage.id} 读 ${p} ×${n}`);
              return {
                block: true,
                reason: `你已经读过 ${p} ${n - 1} 次了，内容不会变。用你**已经看到的内容**继续；如果确实缺信息，去读**别的**材料。`,
              };
            }
            return undefined;
          });

          // ★ 上游成果怎么交给它 —— 这里是**两种交接机制的分岔点** ★
          //
          //   默认（走文件）：告诉它去 draft/ 自己看。交接靠**自由文本**，有损。
          //   share 变体：把上游的**真实上下文轨迹**直接注进本轮（库的 context.override）。
          //
          // 后者正是 Cognition 的 Principle 1：「share context, and share full agent traces,
          // **not just individual messages**」。之前四轮实验里我一直在用**文件**做交接
          // （那是 Anthropic 的 artifact systems 那一派），**从没试过库原生的轨迹共享**。
          //
          // 两种做法的理论差别：
          //   · 走文件：下游只能看到上游**写下来的结论**（上游的推理过程和它读过的原文都丢了）
          //   · 共享轨迹：下游看到上游**读过什么、怎么想的、得出什么**（无损，但占上下文）
          let upstream = stage.needs.length
            ? `\n\n上游阶段 ${stage.needs.join("、")} 的成果已经在 draft/ 里，用 read 工具自己去看。`
            : "";
          if (variant === "share" && stage.needs.length) {
            const trace: AgentMessage[] = [];
            for (const n of stage.needs) {
              const up = agentsById.get(`B-${n}-${runNo}`);
              if (up) trace.push(...up.context.history.filter((m) => m.role !== "system"));
            }
            if (trace.length) {
              sharedChars += JSON.stringify(trace).length;
              sharedFrom.push(`${stage.id}←${stage.needs.join("+")}(${trace.length}条)`);
              // 函数形式：复用 pi 自己构好的 messages，不自己造消息形状
              agent.context.override((messages) => [...trace, ...messages]);
              upstream = ""; // 轨迹里已经含上游读了什么，不需要再去翻文件
            }
          }
          const res = await agent.io.prompt(stage.task + upstream);
          if (res.error && !tripped) rootError = `${stage.id} 这一轮失败：${res.error}`;
        } catch (e) {
          crashed = `${stage.id} 崩了：${(e as Error).message}`;
        }
      }),
    );
    if (crashed) break;
  }

  meter.settle();
  const sum = summarize(meter);
  meter.dispose();
  // ⚠️ 必须真的 dispose：agent 挂着不退出，进程会悬住（04 文档里那条实测结论）
  for (const a of meter.liveAgents()) a.dispose();

  const verdict: Verdict = judge(cwd);

  // ★ 诊断：产物写到了嵌套路径吗？★
  // 实测踩过：任务文本写的是「work/report.md」，而 cwd **就是** work，
  // 于是模型有时写到了 work/work/report.md —— 判据读 cwd/report.md 读不到，
  // 整次跑就被记成「产物不存在」，看起来像**能力失败**，实际是**路径歧义**。
  // 现在文本已经改成 report.md，但这类失败必须能在数据里认出来，不能继续伪装。
  const nested = join(cwd, "work", REPORT_FILE);
  const misdirected = !existsSync(join(cwd, REPORT_FILE)) && existsSync(nested)
    ? `产物写到了嵌套路径 work/${REPORT_FILE}（cwd 已经是 work/）—— 这是路径歧义，不是能力失败`
    : undefined;

  return {
    lab: "B-workflow",
    tag,
    variant,
    startedAt,
    secs: (Date.now() - t0) / 1000,
    crashed: crashed ?? rootError ?? misdirected,
    agents: meter.records,
    ...sum,
    verdict,
    reportText: existsSync(join(cwd, "report.md")) ? readFileSync(join(cwd, "report.md"), "utf8") : null,
    guarded: guarded.length ? guarded : undefined,
    codeStages: meter.codeStages.length ? meter.codeStages : undefined,
    sharedTraceChars: variant === "share" ? sharedChars : undefined,
    sharedFrom: sharedFrom.length ? sharedFrom : undefined,
    repeatBlocks: repeats.length ? repeats : undefined,
    steered: steered.length ? steered : undefined,
    workbench: board ? { ...board.snapshot(), rejections: board.rejections } : undefined,
  };
}
