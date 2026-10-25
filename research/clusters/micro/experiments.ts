/**
 * 离线读数：hunt 的实验账（0 token，纪律⑦ 可离线重判）
 *
 * ★ 用法：`npm run exp`（默认读 research/labfirst/hunt）
 */
import {
  conjectures,
  generalizability,
  readArtifacts,
  readExperiments,
  renderExperiments,
  renderGeneralizability,
} from "../hunt/topology/experiments.ts";
import { readProjects, renderProjects } from "../hunt/topology/projects.ts";

const root = process.argv[2] ?? "research/labfirst/hunt";
const { stats, att, mix, outcomeSamples, ledgerConflicts } = readExperiments(root);
const cj = conjectures(readArtifacts(root + "/outbox"));
const pj = readProjects(root);
console.log(
  [renderProjects(pj.stats, pj.mode), `★ 猜想（明写标记）：${cj.total} 条 · 其中标了「未验证」${cj.unverified} 条`,
    renderGeneralizability(generalizability(readArtifacts(root + "/outbox")))].join(String.fromCharCode(10)) +
    String.fromCharCode(10) +
  renderExperiments(
    stats,
    att,
    mix,
    outcomeSamples,
    ledgerConflicts.length ? `同一编号在两份账里结局不一致 ${ledgerConflicts.length} 个：${ledgerConflicts.slice(0, 6).join(" ")}（记成未声明，不悄悄挑一个）` : "",
  ),
);
