/**
 * 离线读数：hunt 的实验账（0 token，纪律⑦ 可离线重判）
 *
 * ★ 用法：`npm run exp`（默认读 research/labfirst/hunt）
 */
import {
  conjectures,
  artifactLoci,
  externalUsage,
  itemGap,
  renderItemGap,
  providedUsage,
  renderExternal,
  renderProvided,
  attentionMix,
  renderLoci,
  crossCarrier,
  renderCrossCarrier,
  generalizability,
  renderAttention,
  readArtifacts,
  readExperiments,
  renderExperiments,
  renderGeneralizability,
} from "../hunt/topology/experiments.ts";
import { dialecticStats, readChallenges, renderDialectic } from "../hunt/topology/dialectic.ts";
import { runLibTests, renderLibTests } from "./libtest.ts";
import { deadUse, renderDeadUse } from "../hunt/topology/experiments.ts";
import {
  convergenceDebt,
  convergedGate,
  renderDebt,
  renderGate,
  renderUnsupported,
  unsupportedClaims,
} from "../hunt/topology/converged-gate.ts";
import {
  deepProjects,
  externalUrlShare,
  projectChains,
  readStructured,
  renderSeven,
  sevenStats,
} from "../hunt/tools/record-experiment.ts";
import { readProjects, renderProjects } from "../hunt/topology/projects.ts";
import { readdirSync, readFileSync } from "node:fs";

const root = process.argv[2] ?? "research/labfirst/hunt";

/** ★ 拼出全部实验账的文本（`outbox/EXPERIMENTS*.md`）—— 判「七项有哪几列」只看它 */
function ledgerTextOf(lab: string): string {
  try {
    const dir = lab + "/outbox";

    return readdirSync(dir)
      .filter((f) => /^EXPERIMENTS.*\.md$/.test(f))
      .map((f) => readFileSync(dir + "/" + f, "utf8"))
      .join(String.fromCharCode(10));
  } catch {
    return "";
  }
}
const { stats, att, mix, outcomeSamples, ledgerConflicts } = readExperiments(root);
const cj = conjectures(readArtifacts(root + "/outbox"));
const pj = readProjects(root);
console.log(
  [renderProjects(pj.stats, pj.mode), `★ 猜想：${cj.total} 条 · 行内明写「未验证」${cj.unverified} 条${cj.headerDeclared ? "（★ 表头已声明，按列定义全算标过）" : ""}`,
    renderGeneralizability(generalizability(readArtifacts(root + "/outbox"))),
    renderAttention(attentionMix(readArtifacts(root + "/outbox"))),
    renderCrossCarrier(crossCarrier(readArtifacts(root + "/outbox"))),
    renderDialectic(dialecticStats(readChallenges(root))),
    renderLoci(artifactLoci(root, Date.now() - 3 * 3600_000)),
    renderExternal(externalUsage(readArtifacts(root + "/outbox"))),
    "★ 历史（自由文本账，只存档）：" + renderItemGap(itemGap(ledgerTextOf(root))),
    // ★★★★ 两账并排（纪律⑩：新旧不混）—— 结构化账是**新判据**，自由文本账只算历史
    "★★ 本轮判据只看**结构化账**（下面这两行）；自由文本账（235 份历史）**只存档、不参与新判据**",
    renderSeven(sevenStats(readStructured(root))),
    renderGate(convergedGate(root, readStructured(root))),
    renderDebt(convergenceDebt(root, readStructured(root))),
    renderUnsupported(
      (() => {
        try {
          return unsupportedClaims(readFileSync(root + "/outbox/CONVERGED.md", "utf8"), readStructured(root));
        } catch {
          return [];
        }
      })(),
    ),
    (() => {
      const rows = readStructured(root);
      const ex = externalUrlShare(rows);
      const pct = ex.share === null ? "未声明" : Math.round(ex.share * 100) + "%";
      const chains = projectChains(rows)
        .slice(0, 5)
        .map((c) => `${c.project} ${c.rows} 条${c.external ? `（外部 ${c.external}）` : ""}`)
        .join(" · ");
      return (
        `★★ 项目链深：${chains || "未声明"}　← ★ 链深 ≥3 的项目 **${deepProjects(rows)}** 个` +
        String.fromCharCode(10) +
        `★★ 真外部 URL（一等判据，不与「本仓:」混）：**${pct}**（${ex.n}/${ex.total}）`
      );
    })(),
    renderProvided(
      providedUsage(
        readArtifacts(root + "/outbox"),
        (await import("node:fs")).existsSync("research/docs/研究员提供的网上文章")
          ? (await import("node:fs")).readdirSync("research/docs/研究员提供的网上文章").filter((f: string) => f.endsWith(".md"))
          : [],
      ),
    ),
    renderDeadUse(deadUse(readStructured(root))),
    // ★ 集群自己的库测试有没有红灯（装置失败 ≠ 能力失败，纪律⑧）
    renderLibTests(await runLibTests(root)),
  ].join(String.fromCharCode(10)) +
    String.fromCharCode(10) +
  renderExperiments(
    stats,
    att,
    mix,
    outcomeSamples,
    ledgerConflicts.length ? `同一编号在两份账里结局不一致 ${ledgerConflicts.length} 个：${ledgerConflicts.slice(0, 6).join(" ")}（记成未声明，不悄悄挑一个）` : "",
  ),
);
