#!/usr/bin/env bash
# 收集数据：两边各跑 N 次，顺序执行。
#
# ★ 为什么**不能**并行 ★：A 与 B 共用 demom/work（cwd），
#   并行跑会让两边的 report.md / draft/ 互相覆盖 —— 数据就废了。
#
# 跑法：bash demom/collect.sh [N]
set -u
cd "$(dirname "$0")/.." || exit 1

N="${1:-5}"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
LOG="demom/runs/collect-${STAMP}.log"
mkdir -p demom/runs

{
  echo "═══ 数据收集开始 $(date) ═══"
  echo "跑量：每边 ${N} 次"
  echo
  echo "───── 铺现场 ─────"
  node demom/bench/prep.ts
  echo
  echo "───── 实验室 A：自由集群 × ${N} ─────"
  node demom/labA-cluster/run.ts --repeat "${N}" --tag main
  echo
  echo "───── 实验室 B：固定流程 × ${N} ─────"
  node demom/labB-workflow/run.ts --repeat "${N}" --tag main
  echo
  echo "───── 对照表 ─────"
  node demom/bench/compare.ts
  echo
  echo "═══ 数据收集结束 $(date) ═══"
} >> "${LOG}" 2>&1

echo "日志：${LOG}"
