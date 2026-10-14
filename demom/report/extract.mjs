// 把实验数据抽成画图用的 JSON（判据用当前版重判，不重跑）
import fs from "node:fs";
import { judgeText } from "../bench/task.ts";

const RUNS = "demom/runs";
const files = fs.readdirSync(RUNS).filter((f) => f.endsWith(".jsonl") && !/-pre-|-pre2-/.test(f));
const runs = [];
for (const f of files) {
  for (const l of fs.readFileSync(`${RUNS}/${f}`, "utf8").split("\n").filter((x) => x.trim())) {
    const r = JSON.parse(l);
    const v = judgeText(r.reportText ?? null);
    const judgeRole = r.lab === "A-cluster" ? "root" : "S2-去重";
    const judgeAgent = r.agents.find((a) => a.role === judgeRole);
    runs.push({
      lab: r.lab,
      variant: r.variant || "base",
      ok: v.ok,
      deduped: v.deduped,
      covered: v.covered,
      distractorClean: v.distractorClean,
      contradictionPaired: v.contradictionPaired,
      idsValid: v.idsValid,
      tokens: r.totalTokens,
      secs: r.secs,
      agentCount: r.agentCount,
      delegations: r.delegations,
      toolCalls: r.toolCalls,
      reportChars: v.reportChars,
      judgeReads: judgeAgent ? (judgeAgent.calls || []).filter((c) => c === "read").length : null,
      // S4（写手）读了几份 —— 黑板有没有真的替代「重读」
      s4Reads: (() => {
        const s4 = r.agents.find((a) => a.role === "S4-成文" || a.role === "writer");
        return s4 ? (s4.calls || []).filter((c) => c === "read").length : null;
      })(),
      notes: r.workbench ? Object.keys(r.workbench.state.notes).length : null,
      workbench: r.workbench ?? null,
      steered: r.steered ?? null,
      dedupDetail: v.dedupDetail.map((d) => ({ group: d.group.join("≡"), ok: d.ok })),
    });
  }
}
fs.writeFileSync("demom/report/data.json", JSON.stringify(runs, null, 1));
const byV = {};
for (const r of runs) {
  const k = `${r.lab === "A-cluster" ? "A" : "B"}/${r.variant}`;
  (byV[k] ??= []).push(r);
}
console.log("记录数:", runs.length);
for (const [k, rs] of Object.entries(byV)) {
  const ok = rs.filter((r) => r.ok).length;
  console.log(`  ${k.padEnd(18)} n=${String(rs.length).padEnd(3)} ok=${ok}/${rs.length}  tok=${Math.round(rs.reduce((s, r) => s + r.tokens, 0) / rs.length / 1000)}k`);
}
