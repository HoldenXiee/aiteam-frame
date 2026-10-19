// ★★★ 平台期判据 —— 这是**全项目最反复的一条**，所以单独一个文件
//
// ══════════════════════════════════════════════════════════════════
// ★★★ 三次定义，两次被实测推翻（完整历史，别只记住最后一版）
// ══════════════════════════════════════════════════════════════════
//
// 【v1】"有没有动作" = outbox 变多 **或** work/ 有 mtime 变化
//   ✗ 被推翻：它**几乎一直在动** ⇒ 连续 15 分钟"什么都不动"几乎不可能
//     实测 `roundsSinceNew` 到过 2 **但从未到 3** ⇒ `inspirer` 从不触发
//
// 【v2】"有没有进展" = outbox 变多 **或** CONVERGED.md 更新
//   ✗ 被推翻（★ 是**研究员自己**发现的，见 `outbox/装置缺陷-平台期判据只数outbox不数work造成假阳性.md`）：
//     **在研究员最忙的时候误判"原地打转"，连发专家**
//     实测反证：触发窗口内 `work/runs/line-input.jsonl` 在逐轮追加、
//     `exp-line-input/*/corpus/` 批量落盘（新建文件数以千计），而判据说"无进展"
//     ★ 它的归因精准：「这与 O6/O8 同族 —— **这里「活动信号」也从 outbox 逃出观测**」
//
// 【v3】（本文件）—— ★★★ 把两个信号**合起来**，各治一半：
//     · 光看"动作" ⇒ 它跑同一条线的第 20 轮永远判为健康（v1 的病）
//     · 光看"产物" ⇒ 它跑实验的 15 分钟被判为卡住（v2 的病）
//     ⇒ **"在动" 要能**区分"健康的动"与"原地打转的动"
//
// ══════════════════════════════════════════════════════════════════
// ★ 怎么区分？—— 用**产出的体量**，不是"有没有动"
// ══════════════════════════════════════════════════════════════════
//
//   ★ 关键观察：**跑实验**会产出**大批量**文件（corpus、runs、每一轮的产物）；
//     **原地打转**（反复改同一个脚本）只产出**零星几个**文件。
//   ⇒ 判据："最近一段时间内，`work/` 里**新出现/被改动的文件数**够不够多"
//
// ★★ 这仍然是**读磁盘**（不读它的自述），且**不跨时钟域**（数文件数，不比较时间戳）。
// ★★★ 而且它**天然满足 P12**（拦的同时给路）：判为卡住时，理由里会写明
//     "你最近只动了 N 个文件" —— 它看得见这个数，能自己判断该不该换路。

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LAB } from "../paths.ts";

/** 集群自己的文件 —— ★ 不算研究员的活（微实验 D：观察者效应） */
export const CLUSTER_OWN_FILES = new Set([
  "_topology.log",
  "_lib-state.md",
  "_cluster.lock",
  "deliveries.jsonl",
  "audits",
]);

/** 递归数 `work/` 里（排除集群自己的）mtime 晚于 `since` 的文件数 */
export function countFreshFiles(dir: string, since: number, acc = { n: 0 }): number {
  if (!existsSync(dir)) return acc.n;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc.n;
  }
  for (const f of entries) {
    if (CLUSTER_OWN_FILES.has(f)) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        countFreshFiles(p, since, acc);
      } else if (st.mtimeMs > since) {
        acc.n++;
      }
    } catch {
      /* 竞态 */
    }
  }
  return acc.n;
}

/** `work/` 的最新 mtime（★ 排除集群自己的文件）—— 给 trace 用 */
export function workLatestMtime(): number {
  const d = join(LAB, "work");
  if (!existsSync(d)) return 0;
  let latest = 0;
  for (const f of readdirSync(d)) {
    if (CLUSTER_OWN_FILES.has(f)) continue;
    try {
      const st = statSync(join(d, f));
      if (st.isFile() && st.mtimeMs > latest) latest = st.mtimeMs;
    } catch {
      /* 竞态 */
    }
  }
  return latest;
}

/** `CONVERGED.md` 的 mtime（★ 它自己写的"我推进了"声明） */
export function convergedMtime(): number {
  try {
    return statSync(join(LAB, "outbox", "CONVERGED.md")).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * ★★★ v3 判据本体：这一段时间算不算"有进展"？
 *
 * @param since 上一次检查的时刻（★ 用挂钟，但只做**区间**用，不比较文件时间戳的大小）
 */
export function hasProgress(since: number, freshThreshold: number): { ok: boolean; fresh: number } {
  const fresh = countFreshFiles(join(LAB, "work"), since);
  return { ok: fresh >= freshThreshold, fresh };
}
