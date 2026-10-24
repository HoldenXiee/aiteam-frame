// ★★★ 离线读数器（2026-10-20）
//
//   ★ 为什么要有这个文件：所有读数都能**离线重算**（纪律⑦：判据纯函数、可离线重判）。
//   不依赖那一轮的日志，只看落盘数据 ⇒ 事后可以按任何时间窗重判。
//
//   用法：
//     npx tsx research/clusters/forge/micro/readout.ts            # 本轮/各日/全库
//     npx tsx research/clusters/forge/micro/readout.ts --since=2026-10-22T18:00
//
// ★★ 纪律⑩：**永远先看 `--since` 的窗口**，不要看全库累积去判断现在的病。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadVotes, usabilitySummary, normQuestion, type Vote } from "../tools/judge.ts";

const LAB = join(import.meta.dirname, "..", "..", "..", "labfirst", "forge");

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function signoffStats(since?: string) {
  const p = join(LAB, "work", "signoffs.jsonl");
  if (!existsSync(p)) return null;
  const table = new Map<string, Map<string, { verdict: string; dislodge?: string }>>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as {
        at: string;
        artifact: string;
        by: string;
        verdict: string;
        dislodge?: string;
      };
      if (since && r.at < since) continue;
      if (!table.has(r.artifact)) table.set(r.artifact, new Map());
      table.get(r.artifact)!.set(r.by, { verdict: r.verdict, dislodge: r.dislodge });
    } catch {
      /* 坏行跳过 */
    }
  }
  const cnt: Record<string, number> = {};
  let arts = 0;
  let resv = 0;
  let endo = 0;
  for (const [, signs] of table) {
    arts++;
    let hasResv = false;
    for (const [, rec] of signs) {
      cnt[rec.verdict] = (cnt[rec.verdict] ?? 0) + 1;
      if (rec.verdict === "有保留") hasResv = true;
      if (rec.verdict === "认可保留") endo++;
    }
    if (hasResv) resv++;
  }
  return { arts, cnt, resv, endo };
}

function voteStats(votes: Vote[]) {
  const byQ = new Map<string, Set<string>>();
  for (const v of votes) {
    const k = normQuestion(v.question);
    if (!byQ.has(k)) byQ.set(k, new Set());
    byQ.get(k)!.add(v.by);
  }
  const dist: Record<number, number> = {};
  for (const [, w] of byQ) dist[w.size] = (dist[w.size] ?? 0) + 1;
  return { questions: byQ.size, tickets: votes.length, dist };
}

const since = arg("since");
const all = loadVotes(join(LAB, "work", "votes.jsonl"));
const win = since ? all.filter((v) => v.at >= since) : all;

const out: string[] = [];
out.push(`# 读数${since ? `（since ${since}）` : "（★ 全库，纪律⑩：别拿它判断现在的病）"}`);
out.push("");

// ① 票
const vs = voteStats(win);
out.push(`## 观众票`);
out.push(`题目 ${vs.questions} · 票 ${vs.tickets}`);
out.push(`票数分布 ${JSON.stringify(vs.dist)}（★ 4 = 观众人数，齐了）`);

// ② 可用性
const us = usabilitySummary(win);
out.push("");
out.push(`## 可用性`);
out.push(`被评 ${us.total} · **可用 ${us.usable}** · 卡住 ${us.blocked}（★ 没人问过 ${us.neverAsked}）`);
if (Object.keys(us.blockers).length) {
  out.push(`说「都不够」的：${Object.entries(us.blockers).map(([k, v]) => `${k}×${v}`).join(" ")}`);
}

// ③ 签字
const so = signoffStats(since);
out.push("");
out.push(`## 共识门签字`);
if (!so) out.push("（没有 signoffs.jsonl）");
else {
  out.push(`产物 ${so.arts} 份 · 带保留 ${so.resv} 份 · 认可保留 ${so.endo} 张`);
  out.push(`签字分布 ${JSON.stringify(so.cnt)}`);
}

process.stdout.write(out.join("\n") + "\n");
