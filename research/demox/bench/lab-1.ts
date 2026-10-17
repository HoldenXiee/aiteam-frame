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
  /** 跑几轮（每轮 = 选题 → 设计 → 跑 → 解读 → 写成果 → 自审） */
  rounds?: number;
  /** 是否做「干净上下文自审」 */
  audit?: boolean;
  /** 给它的一句额外方向（可选） */
  steer?: string;
};

/** ★ 受保护的路径：它**不能写**（读可以）—— 我 430 轮的资产 */
const PROTECTED = [
  "src", "dev", "research/demox/bench", "research/demox/成果",
  "research/demox/runs", "研究规划.md", "进度总表.md", "研究规划",
];

const isProtected = (p: string) => {
  const rel = p.replace(/\\/g, "/").replace(REPO.replace(/\\/g, "/"), "").replace(/^\//, "");
  return PROTECTED.some((x) => rel === x || rel.startsWith(x + "/"));
};

export async function runLabOne(sw: Switch = {}) {
  const rounds = sw.rounds ?? 1;
  const cwd = join(LAB1, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(LAB1, "outbox"), { recursive: true });

  const journal = join(LAB1, "work", "JOURNAL.md");
  if (!existsSync(journal)) writeFileSync(journal, "# 研究员集群的日志\n\n");

  const results: { round: number; tokens: number; secs: number; ok: boolean; note: string }[] = [];

  for (let r = 1; r <= rounds; r++) {
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
        if (PROTECTED.some((x) => cmd.includes(x)) && /(>|>>|sed -i|rm\s|mv\s|cp\s)/.test(cmd)) {
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
        `## 这一轮你要做的\n\n` +
        `1. 读上面 + 读你需要的仓库文件（成果清单、研究规划、未解决问题清单、真实工作形态调研等）\n` +
        `2. ★ **自己选一个真问题**（不要问我要选题）\n` +
        `3. 写实验设计 → \`work/designs/\`\n` +
        `4. 跑（把 bench 复制到 work/ 里改再跑）\n` +
        `5. 解读\n` +
        `6. 写成果 → \`outbox/\`（四段格式 + 【成本】）\n` +
        `7. 把这一轮追加进 \`work/JOURNAL.md\`\n` +
        `8. git add -A && git commit\n\n` +
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
    let auditText = "";
    if (sw.audit !== false) {
      const files = existsSync(join(LAB1, "outbox")) ? readdirSync(join(LAB1, "outbox")).filter((f) => f.endsWith(".md")) : [];
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
            "· 结论有没有超出证据？（样本量？对照组？）\n" +
            "· 在说「它不守规格」之前，有没有先核对**规格本身**写对了没有？\n" +
            "★ 输出：\n" +
            "  ① 站得住的结论（逐条）\n" +
            "  ② ★ **有问题的结论**（逐条，说清为什么）\n" +
            "  ③ 它漏了什么（没做的对照 / 没查的装置）\n" +
            "  ④ 一句话总评：这条成果该「收进仓库」/「打回重做」/「补实验再定」",
          permissions: { only: ["bash", "read", "grep", "find", "ls"] }, // ★ 只读 —— 审查员不该改东西
        });
        try {
          const ar = await auditor.io.prompt(
            `请审查这份成果：\`${target}\`\n\n` +
              `需要时你可以读相关数据与代码（\`research/demox/runs/\`、\`research/demox/bench/\`）来核实。\n` +
              `★ 但**先只读这一份产物**，形成你自己的判断，再去查证。`,
          );
          if (ar.error) auditNote = `审查失败：${ar.error}`;
          else auditText = ar.text ?? "";
        } catch (e) {
          auditNote = `审查崩了：${(e as Error).message}`;
        }
        // 把审查意见落盘（★ 我的审查材料）
        // ⚠ 实测：`observe.wire` 是**元数据摘要**（n/count/roles/chars/systemCount），**不含消息正文**。
        //   要正文用 `RunResult.text`（结算的产物）。—— 又一次"先 dump 形状"。
        const txt = auditText;
        if (txt) {
          mkdirSync(join(LAB1, "work", "audits"), { recursive: true });
          writeFileSync(join(LAB1, "work", "audits", `round-${r}.md`), `# 第 ${r} 轮自审\n\n被审：${files[files.length - 1]}\n\n${txt}\n`);
        }
        await auditor.dispose();
      }
    }

    results.push({
      round: r, tokens, secs, ok: !note,
      note: [note, blocked ? `被拦 ${blocked} 次越权写` : "", auditNote].filter(Boolean).join(" | "),
    });
    await agent.dispose();
  }

  return results;
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("lab-1.ts")) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const sw: Switch = {
    rounds: Number(arg("rounds") ?? 1),
    audit: arg("audit") !== "0",
    allowProtectedWrites: arg("allowProtected") === "1",
    steer: arg("steer"),
  };
  console.log(`★ 第一层集群启动：${sw.rounds} 轮，自审=${sw.audit}`);
  const out = await runLabOne(sw);
  for (const o of out) console.log(`  第${o.round}轮 ${o.ok ? "✓" : "✗"} tok=${o.tokens.toLocaleString()} ${o.secs.toFixed(0)}s ${o.note}`);
}
