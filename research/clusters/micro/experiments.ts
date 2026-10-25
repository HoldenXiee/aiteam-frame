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
    renderItemGap(itemGap(ledgerTextOf(root))),
    renderProvided(
      providedUsage(
        readArtifacts(root + "/outbox"),
        (await import("node:fs")).existsSync("research/docs/研究员提供的网上文章")
          ? (await import("node:fs")).readdirSync("research/docs/研究员提供的网上文章").filter((f: string) => f.endsWith(".md"))
          : [],
      ),
    )].join(String.fromCharCode(10)) +
    String.fromCharCode(10) +
  renderExperiments(
    stats,
    att,
    mix,
    outcomeSamples,
    ledgerConflicts.length ? `同一编号在两份账里结局不一致 ${ledgerConflicts.length} 个：${ledgerConflicts.slice(0, 6).join(" ")}（记成未声明，不悄悄挑一个）` : "",
  ),
);
