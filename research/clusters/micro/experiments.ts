/**
 * 离线读数：hunt 的实验账（0 token，纪律⑦ 可离线重判）
 *
 * ★ 用法：`npm run exp`（默认读 research/labfirst/hunt）
 */
import {
  conjectures,
  artifactLoci,
  externalUsage,
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

const root = process.argv[2] ?? "research/labfirst/hunt";
const { stats, att, mix, outcomeSamples, ledgerConflicts } = readExperiments(root);
const cj = conjectures(readArtifacts(root + "/outbox"));
const pj = readProjects(root);
console.log(
  [renderProjects(pj.stats, pj.mode), `★ 猜想（明写标记）：${cj.total} 条 · 其中标了「未验证」${cj.unverified} 条`,
    renderGeneralizability(generalizability(readArtifacts(root + "/outbox"))),
    renderAttention(attentionMix(readArtifacts(root + "/outbox"))),
    renderCrossCarrier(crossCarrier(readArtifacts(root + "/outbox"))),
    renderDialectic(dialecticStats(readChallenges(root))),
    renderLoci(artifactLoci(root, Date.now() - 3 * 3600_000)),
    renderExternal(externalUsage(readArtifacts(root + "/outbox"))),
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
