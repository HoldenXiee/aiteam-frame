// ★★★ 第一层集群的启动器（lab-1.ts）
//
// ★ 设计者的话（2026-10-17）：
//   「理想的研究模式，不是亲自去研究，而是通过设计一个**研究（研究集群）的集群**来实现研究。」
//   「这个集群拥有你现在所有的权限，它来规划、实验、找灵感、重审视、记录成果等等。」
//
// ★ 两层结构：
//   第一层（本文件）—— **研究员集群**：拥有设计者的全部权限（除写本仓库成果外）
//   第二层 —— ★ **它自己设计出的「研究集群」**，去研究 DESIGN 的目标
//
// ★ 我的位置（设计者）：
//   ★ 我只**设计第一层**；第一层自己决定第二层长什么样。
//   ★ 我审查它的产物（`outbox/`），决定是否搬进本仓库。
//
// ★★★ 本文件本身也是一次「用研究成果去检验研究成果」：
//   我 430 轮得出的 14 条纪律，全部写进了它的 BRIEF 里。

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { lab, MODEL } from "../env.ts";

const REPO = process.cwd(); // D:/space/aiteam/test
const LAB1 = join(REPO, "research/demox/lab-1");

// ★ 它能用的工具：全套（读 + 写 + 跑 + 查）
const TOOLS = ["bash", "read", "write", "edit", "grep", "find", "ls"];

export type Switch = {
  /** ★ 它想改仓库里**受保护**的路径时，我是否放行 */
  allowProtectedWrites?: boolean;
  /**
   * ★ 硬上限（安全阀，不是"该停"的判据）。
   * ★★ 真正的退出条件是**它自己声明收敛**（见 `converged`）。
   */
  maxRounds?: number;
  /**
   * ★★★ 收敛判据：连续几轮"审查员提不出**新**缺陷"才算收敛。
   * 默认 2 —— 一轮可能是偶然，两轮才叫"稳定地挑不出毛病"。
   */
  quietRounds?: number;
  /** 是否做「干净上下文自审」 */
  audit?: boolean;
  /** 给它的一句额外方向（可选） */
  steer?: string;
};

/**
 * ★ 受保护的路径：它**不能写**（读可以）—— 设计者 430 轮的资产
 *
 * ⚠ 踩过的坑（2026-10-17，研究员集群第 1 轮实测 + 独立审查员复核）：
 *   原来这里写的是**裸短串** `"src"` / `"dev"`，于是
 *   `ls foo 2>/dev/null` 被拦 —— 因为 `/dev/null` **同时**含子串 `dev` 和字符 `>`。
 *   ★ **任何含 `2>/dev/null` 的命令无条件被拦**（与是否触及受保护路径无关）。
 *   ⇒ 改成**带路径边界**的形态；并且重定向只认「真写目标」。
 */
const PROTECTED = [
  "src/", "dev/", "research/demox/bench/", "research/demox/成果/",
  "research/demox/runs/", "研究规划.md", "进度总表.md",
];

/** ★ 把任意字符串里出现的"受保护仓库相对路径"找出来（带边界，不看裸子串） */
function protectedHits(text: string): string[] {
  const t = text.replace(/\\/g, "/");
  const hits: string[] = [];
  for (const p of PROTECTED) {
    // ★ 边界：前面是行首/空白/引号/=/:，后面接路径继续或结束
    const esc = p.replace(/[/.]/g, (m) => "\\" + m);
    const re = new RegExp(`(^|[\\s"'=:(])${esc}`, "m");
    if (re.test(t)) hits.push(p);
  }
  return hits;
}

/**
 * ★ 只读重定向白名单：`2>/dev/null`、`2>&1`、`> /dev/null` 之类**不是写受保护路径**。
 * 先把它们从命令里去掉，再看还有没有真写。
 */
function stripReadOnlyRedirects(cmd: string): string {
  return cmd
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>>?\s*&\s*\d/g, " ")
    .replace(/\d?>>?\s*\$?\{?\w*\}?\s*\/dev\/null/g, " ");
}

/** ★ 真写目标：`>`/`>>`/`tee`/`sed -i`/`rm`/`mv`/`cp` 的**目标**，而不是"命令里有 `>`" */
function looksLikeWrite(cmd: string): boolean {
  const c = stripReadOnlyRedirects(cmd);
  // 重定向到**非 /dev/null** 的东西
  if (/(^|[^\d])>>?\s*(?!&)/.test(c)) return true;
  if (/tee/.test(c)) return true;
  if (/sed\s+(-i|--in-place)/.test(c)) return true;
  if (/(rm|mv|cp)\s/.test(c)) return true;
  if (/(touch|mkdir|rmdir|chmod|chown)\s/.test(c)) return true;
  return false;
}

/**
 * ★ 只用于 `write` / `edit` 的**路径参数**（绝对或相对）。
 * ⚠ 不要拿它判 bash —— bash 是**命令文本**，要走 protectedHits + looksLikeWrite。
 *   （审查员指出：修 `isProtected` 并不能修 bash 假阳，二者是两码事。）
 */
/**
 * ★★★ 收敛声明 —— 退出条件由**它自己**给，不由我数轮子。
 *
 * 设计者 2026-10-17 的要求（逐字）：
 *   「是不是**达到研究目标，且怎么分析都没有错误，或深度已经足够深了，才停止**，
 *    且……根据探索后对目标的理解，和系统科学、信息论的知识，对 design 目标**看不出新想法**」
 *
 * ★ 三条判据（要写成**可被我审的**，不是自我感觉）：
 *   ① **深度够了**：本问题**还有哪些没排除的替代解释**？列空才算够。
 *   ② **重看目标看不出新东西**：拿已有成果 + 系统科学/信息论，再读 DESIGN 目标，
 *      **还能不能生出没做过的新问题**？
 *   ③ **分析没有错误**：审查员连续 N 轮提不出**新**缺陷。
 *
 * ★★ 关键：声明必须**可证伪** —— 要写"我排除了哪些替代解释、用什么证据"，
 *    不是写"我觉得够了"。审查员会拿它开火。
 */
const CONVERGE_INSTRUCTIONS = `
## ★★★ 何时停：由**你**声明收敛，不由我数轮子

**这个循环没有固定轮数。你必须在每一轮末**显式判断**该不该继续，并把判断写成可被审查的文字。**

### 你可以宣布收敛（写 \`outbox/CONVERGED.md\`），当且仅当三条**同时**成立：

**① 深度够了 —— 替代解释列空了**
   把你正在研究的问题**所有**能想到的替代解释列出来，逐条写"用什么证据排除了它"。
   ★ **只要还剩一条没排除** → 不能宣布收敛，下一轮去做那个。
   ★ 特别注意 **confound**：你的效应有没有可能来自装置、提示措辞、采样随机？
     （本项目已因此作废过 51 轮数据 —— 见 \`成果/优化方法/P18-已撤回-*.md\`）

**② 重看 DESIGN 目标，看不出新想法了**
   拿你现在**已经掌握的**全部成果 + **系统科学 / 信息论**的视角，再读 DESIGN 的目标
   （"用代码有效且高质量地使用几乎零成本的智力"、"人的位置"）。
   ★ 写清：**还能不能生出一个没做过的新问题？**
   ★ 若能 → 不能收敛，下一轮做它。若真的想不出来了 → 说明白了**为什么想不出来**
   （是能力边界？是工具不够？是这个问题已经饱和？）

**③ 分析没有错误**
   这一条由**独立审查员**判（不是你）。但它要看到你的收敛声明才能判。

### 收敛声明的格式（\`outbox/CONVERGED.md\`）

\`\`\`
# 收敛声明 · <你研究的问题>
## 1. 目标是什么（DESIGN 的哪一句 / 哪个子问题）
## 2. 我得到了什么（逐条结论 + 证据 id）
## 3. ★ 替代解释清单：逐条写"排除了吗 / 用什么排除的"（★ 必须列空才算够）
## 4. ★ 重看目标：还能生出新问题吗？哪些？（若列空，说清为什么列不出）
## 5. 我还**明确没做**的（诚实清单 —— 不是缺陷，是边界）
## 6. ★ 我认为够了/不够，理由是……
\`\`\`

### 不够时怎么办
★ **不写 CONVERGED.md，继续下一轮。** 在 \`work/JOURNAL.md\` 里写清：
下一轮做什么、为什么那是当前**最值得做**的那一件。

★★ **不许为了收工而宣布收敛。** 审查员专门盯这个。
`;

const isProtected = (p: string) => {
  const rel = p.replace(/\\/g, "/").replace(REPO.replace(/\\/g, "/"), "").replace(/^\//, "");
  return protectedHits(rel).length > 0;
};

export async function runLabOne(sw: Switch = {}) {
  const maxRounds = sw.maxRounds ?? 12;      // ★ 安全阀（默认 12，够它跑几轮收敛）
  const quietNeed = sw.quietRounds ?? 2;     // ★ 连续几轮"无新缺陷"算收敛
  // ★★ 每个实例一个独立工作区（2026-10-17 研究员集群第 1 轮的改库提案）：
  //   原先是所有实例共用 `lab-1/work`，且下游脚本默认「截断同名数据文件」——
  //   两个实例并发时会**静默**互相删数据（实测：15 行 → 2 行）。
  //   设计者裁定：**改装置，不靠写规矩**（P17/O7：用提示做该由面做的事必然是弱的）。
  const inst = process.env.LAB1_INSTANCE ?? `i${process.pid}-${Date.now().toString(36)}`;
  const cwd = join(LAB1, "work", inst);
  mkdirSync(cwd, { recursive: true });
  // ★ 实例登记（设计者一眼能看到谁在跑）
  try {
    const reg = join(LAB1, "work", "instances");
    mkdirSync(reg, { recursive: true });
    writeFileSync(join(reg, `${inst}.json`), JSON.stringify({ inst, pid: process.pid, at: new Date().toISOString() }, null, 1));
  } catch { /* 登记失败不该拦住开工 */ }
  mkdirSync(join(LAB1, "outbox"), { recursive: true });

  const journal = join(cwd, "JOURNAL.md");
  if (!existsSync(journal)) writeFileSync(journal, "# 研究员集群的日志\n\n");

  const results: { round: number; tokens: number; secs: number; ok: boolean; note: string; converged?: string }[] = [];

  /** ★★★ 收敛状态：连续多少轮"审查员提不出新缺陷" */
  let quiet = 0;
  /** 累积见过的缺陷指纹 —— "新缺陷"= 不在这个集合里 */
  const seenDefects = new Set<string>();
  let stopReason = "（未收敛，撞到安全阀 maxRounds）";

  for (let r = 1; r <= maxRounds; r++) {
    const t0 = Date.now();
    const brief = readFileSync(join(LAB1, "inbox", "BRIEF.md"), "utf8");
    const done = existsSync(journal) ? readFileSync(journal, "utf8") : "";
    const prior = existsSync(join(LAB1, "outbox"))
      ? readdirSync(join(LAB1, "outbox")).filter((f) => f.endsWith(".md"))
      : [];

    const agent = await lab.createAgent({
      id: `LAB1-r${r}-${Date.now()}`,
      model: MODEL,
      role:
        "你是一个**研究员集群**。你在研究「用代码组织近乎零成本智力」这门生产方式的规律。\n" +
        "★ 你不是执行者，你是研究者：自己选题、找灵感、重看目标、设计实验、跑、解读、记录、自审。\n" +
        "★ 你的工作区是 `research/demox/lab-1/work/`，成果写进 `research/demox/lab-1/outbox/`。\n" +
        "★ 你可以读仓库里任何文件，但**不能写** `src/` `dev/` `research/demox/bench/` `research/demox/成果/`。\n" +
        "  要改 bench 的东西 → 复制到 `work/` 里改。\n" +
        "★★★ 撞到「底层能力不够」（想做的功能，库/pi 没有接口）时：**不要自己改库**，\n" +
        "  在 `outbox/` 写一份**改库提案**（六节：想做什么 / 卡在哪（要 dump 过形状）/ 试过的绕法 / " +
        "为什么非改不可 / 改哪里怎么改 / 改了能做什么），交设计者去改。\n" +
        "  ★ 提案本身是成果；反复撞到的同一类缺口，攒成 `outbox/能力缺口-*.md` 更值钱。",
      permissions: { only: TOOLS },
    });

    // ★★★ 受保护路径的写拦截：用 permissions.gate（不是提示！）
    // ★ 形状来自 dev/examples/05-permissions.ts（**dump 过，不猜**）：
    //   gate(call: {name, input, callId}) → Promise<{block:true, reason} | undefined>
    let blocked = 0;
    agent.permissions.gate(async (call) => {
      if (sw.allowProtectedWrites) return undefined;
      const inp = (call.input ?? {}) as Record<string, unknown>;
      const hit = (msg: string) => {
        blocked++;
        return { block: true as const, reason: msg };
      };
      if (call.name === "bash") {
        const cmd = String(inp.command ?? "");
        // ★ 两个条件都要**精确**：① 真写（不是只读重定向）② 目标里出现受保护路径
        const hits = protectedHits(cmd);
        if (hits.length && looksLikeWrite(cmd)) {
          return hit(
            `⛔ 这条命令会写受保护的路径（属于设计者 430 轮的资产）。
` +
              `★ 要改 bench/ 的东西 → **复制一份到 lab-1/work/ 里改**，在那里跑。`,
          );
        }
        return undefined;
      }
      if (call.name !== "write" && call.name !== "edit") return undefined;
      const p = String(inp.path ?? inp.file_path ?? "");
      if (!p || !isProtected(p)) return undefined;
      return hit(
        `⛔ \`${p}\` 是受保护的（设计者的成果/工具）。
` +
          `★ 你的成果写进 \`research/demox/lab-1/outbox/\`；` +
          `要改 bench 的代码，复制到 \`research/demox/lab-1/work/\` 再改。`,
      );
    });

    let note = "";
    try {
      const prompt =
        `# 第 ${r} 轮\n\n` +
        `## 你的任务书（★ 逐字读，这是你的身份）\n\n${brief}\n\n` +
        (done ? `## 你自己的日志（到目前为止）\n\n${done.slice(-6000)}\n\n` : "") +
        (prior.length ? `## 你已产出的成果\n\n${prior.map((f) => "- outbox/" + f).join("\n")}\n\n` : "") +
        (sw.steer ? `## 设计者给你的方向\n\n${sw.steer}\n\n` : "") +
        `## 这一轮\n\n` +
        `★ **怎么做由你定。** 没有规定的步骤 —— 你可以同时跑多个实验、起多个子 agent、\n` +
        `写自己的脚手架、中途改主意、去复核别人的成果，甚至只重读 DESIGN 和已有成果。\n` +
        `★ 唯一的期望是：你产出的东西**可被审**（有证据、可追溯、成本可报），并且**朝着 DESIGN 的目标**。\n` +
        `★ 觉得某条约束不对 → 写进 outbox，别默默绕过去。\n` +
        `\n` +
        `★ 结束时把这一轮追加进 \`work/JOURNAL.md\` 并 \`git add -A && git commit\`。\n` +
        `\n` +
        `★ 不要等我指示。现在就开始。`;

      const res = await agent.io.prompt(prompt);
      if (res.error) note = res.error;
    } catch (e) {
      note = (e as Error).message;
    }

    const tokens = agent.usage.totalTokens ?? 0;
    const secs = (Date.now() - t0) / 1000;

    // ★★★ 自审：另起一个**上下文干净**的 agent
    let auditNote = "";
    // ─────────── ★★★ 独立审查（判"有没有**新**缺陷"，并给收敛把关）───────────
    let auditText = "";
    let newDefects: string[] = [];
    let convergedThisRound = "";
    if (sw.audit !== false) {
      const files = existsSync(join(LAB1, "outbox"))
        ? readdirSync(join(LAB1, "outbox")).filter((f) => f.endsWith(".md"))
        : [];
      const convergedPath = join(LAB1, "outbox", "CONVERGED.md");
      const declared = existsSync(convergedPath);

      if (files.length) {
        const target = join(LAB1, "outbox", files[files.length - 1]!);
        const auditor = await lab.createAgent({
          id: `LAB1-audit-r${r}-${Date.now()}`,
          model: MODEL,
          role:
            "你是一个**独立审查员**。★ 你没有看过任何推导过程 —— 你只看产物本身。\n" +
            "你的任务是**找问题**，不是点头。逐条问：\n" +
            "· 判据有没有漏洞？（能不能被糊弄？）\n" +
            "· 装置有没有系统性缺陷？（换个装置还复现吗？）\n" +
            "· 结论有没有超出证据？（样本量？对照组？替代解释排除了吗？）\n" +
            "· 在说「它不守规格」之前，有没有先核对**规格本身**写对了没有？\n" +
            "\n" +
            "★ 输出（**严格按这个结构，我要机器解析**）：\n" +
            "  ① 站得住的结论（逐条）\n" +
            "  ② **缺陷**：每条**必须**以 `DEFECT: ` 开头，一行一条，说清为什么\n" +
            "  ③ 它漏了什么（没做的对照 / 没查的装置）\n" +
            "  ④ 一句话总评「收进仓库」/「打回重做」/「补实验再定」\n" +
            "\n" +
            "★★ 若被审产物是**收敛声明**（`CONVERGED.md`），额外判：\n" +
            "  · 它列的**替代解释**真的都排除了吗？有没有含糊过关的？\n" +
            "  · 它说「重看目标看不出新想法」——★ 你自己去读 DESIGN + 它的成果，\n" +
            "    能不能生出一个它没提过的新问题？**能 → 必须写一条 DEFECT:**\n" +
            "  · ★ 它有没有为了收工而宣布收敛？（最要防的）",
          permissions: { only: ["bash", "read", "grep", "find", "ls"] }, // ★ 只读 —— 审查员不该改东西
        });
        try {
          const ar = await auditor.io.prompt(
            `请审查这份产物：\`${target}\`\n\n` +
              (declared
                ? `★★ 注意：\`outbox/CONVERGED.md\` **存在** —— 它宣布收敛了。请**额外**审那个文件，` +
                  `并按你角色里说的三条把关（替代解释是否排空 / 重看目标能否生出新问题 / 是否为了收工而宣布）。\n\n`
                : "") +
              `需要时你可以读相关数据与代码（\`research/demox/runs/\`、\`research/demox/bench/\`）来核实。\n` +
              `★ 但**先只读这一份产物**，形成你自己的判断，再去查证。`,
          );
          if (ar.error) auditNote = `审查失败：${ar.error}`;
          else auditText = ar.text ?? "";
        } catch (e) {
          auditNote = `审查崩了：${(e as Error).message}`;
        }

        // ★ 解析 DEFECT: 行，判"新不新"
        newDefects = (auditText.match(/^\s*DEFECT:\s*(.+)$/gm) ?? []).map((l) =>
          l.replace(/^\s*DEFECT:\s*/, "").trim(),
        );
        const fresh = newDefects.filter((d) => !seenDefects.has(d));
        for (const d of newDefects) seenDefects.add(d);

        // ★★★ 收敛判据：声明了收敛 且 本轮没有**新**缺陷 → quiet++
        //     ★ 注意：quiet 计的是"稳定的挑不出新毛病"，不是"宣称收敛的次数"
        if (declared && fresh.length === 0) {
          quiet++;
          if (quiet >= quietNeed) {
            convergedThisRound = `CONVERGED.md 已声明，且连续 ${quiet} 轮审查员提不出新缺陷`;
            stopReason = convergedThisRound;
          }
        } else {
          // ★ 有**新**缺陷 → 之前的"静默"作废（不能拿老账抵新问题）
          if (fresh.length > 0) quiet = 0;
          if (!declared) quiet = 0;
        }

        if (auditText) {
          const ad = join(LAB1, "work", "audits");
          mkdirSync(ad, { recursive: true });
          writeFileSync(
            join(ad, `round-${r}.md`),
            `# 第 ${r} 轮独立审查

被审：${files[files.length - 1]}

` +
              `## 缺陷（机器解析）\n\n` +
              (newDefects.length ? newDefects.map((d) => `- DEFECT: ${d}`).join("\n") : "（无 DEFECT 行）") +
`\n\n## 审查员原文\n\n${auditText}\n`,
);
}
await auditor.dispose();
}
}

results.push({
round: r, tokens, secs, ok: !note,
converged: convergedThisRound || undefined,
note: [
note,        blocked ? `被拦 ${blocked} 次越权写` : "",
        auditNote,
        newDefects.length ? `审查员提 ${newDefects.length} 条缺陷（新 ${newDefects.filter((d) => !seenDefects.has(d)).length}）` : "",
      ].filter(Boolean).join(" | "),
    });
    await agent.dispose();

    // ★★★ 退出条件：**它自己声明收敛**（不是轮数）
    if (convergedThisRound) break;
  }

  console.log(`\n★ 循环结束：${stopReason}`);
  return results;
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lab-1.ts")) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const sw: Switch = {
    maxRounds: Number(arg("max") ?? 12),
    quietRounds: Number(arg("quiet") ?? 2),
    audit: arg("audit") !== "0",
    allowProtectedWrites: arg("allowProtected") === "1",
    steer: arg("steer"),
  };
  console.log(`★ 第一层集群启动：安全阀 ${sw.maxRounds} 轮，收敛需「连续 ${sw.quietRounds} 轮无新缺陷」，自审=${sw.audit}`);
  const out = await runLabOne(sw);
  for (const o of out) {
    console.log(`  第${o.round}轮 ${o.ok ? "✓" : "✗"} tok=${o.tokens.toLocaleString()} ${o.secs.toFixed(0)}s ${o.converged ? "★" + o.converged : ""} ${o.note}`);
  }
  const conv = out.find((o) => o.converged);
  console.log(
    conv
      ? `
★★★ 它自己声明收敛了：${conv.converged}（第 ${conv.round} 轮）`
      : `
⚠ 未收敛，撞到安全阀 ${sw.maxRounds} 轮 —— 它还想继续跑。`,
  );
}
