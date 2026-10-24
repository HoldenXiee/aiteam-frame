/**
 * 离线读数：hunt 的实验账（0 token，纪律⑦ 可离线重判）
 *
 * ★ 用法：`npm run exp`（默认读 research/labfirst/hunt）
 */
import { readExperiments, renderExperiments } from "../hunt/topology/experiments.ts";

const root = process.argv[2] ?? "research/labfirst/hunt";
const { stats, att, mix, outcomeSamples, ledgerConflicts } = readExperiments(root);
console.log(
  renderExperiments(
    stats,
    att,
    mix,
    outcomeSamples,
    ledgerConflicts.length ? `同一编号在两份账里结局不一致 ${ledgerConflicts.length} 个：${ledgerConflicts.slice(0, 6).join(" ")}（记成未声明，不悄悄挑一个）` : "",
  ),
);
