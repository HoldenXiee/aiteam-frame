// ①+② 冗余系统：跑 N 遍独立求解，再按交集合并
//
// ★ 为什么这个系统同时回答两个问题 ★
//
//   ② 丙类（DESIGN.md：因为有什么特性，所以可以怎么利用）
//        「智力便宜」最直接的开法就是：**同一个问题跑好几遍**。
//        这是第一条真正"利用"类的做法，而不是"避开坑"。
//
//   ① 投入-质量曲线
//        横轴 = 遍数 N（0 遍不做，1/3/5 遍…）—— **可连续调**，比"给多少上下文"干净。
//        纵轴 = quality.ts 的质量分。
//
// ★ 设计要点 ★
//
//   · N 份独立解答必须**互不干扰** —— 每一份在**自己的子目录**里工作（work/r1、work/r2…）。
//     若共用一处，后跑的会把先跑的产物覆盖，那就不是"独立多份"了。
//   · 合并用**交集**：N 份都说是重复的，才算重复。
//   · ★ 同时记录**并集**与**两两一致性** ——
//       交集/并集=1 说明 N 遍完全一致（错误是系统的，不是随机的）
//       交集小而并集大 说明它每次都在猜（B4 采样随机）
//     ⇒ 这直接回答 ② 的判别："取交集有用吗？" 靠的就是这三个量。
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { Meter } from "./measure.ts";
import type { Task } from "./tasks.ts";

type Group = string[];

/**
 * 从产物 JSON 里抽出「断言集合」。
 *
 * 返回 key → 原有条目（T-E 需要保留 `what` 描述，否则判据报“没说清”）。
 *
 * ★ 两种任务的产物形状不同，必须都支持：
 *   T-A：{"duplicates":[["M1","M2"], ...]}      → key = "M1+M2"
 *   T-E：{"findings":[{"file":"src/a.js",...}]} → key = "src/a.js"
 *
 * 实测踩到两次：
 *   ① 只读 `duplicates` → T-E 全是“产物不存在或不是合法 JSON”
 *   ② 只留 key、丢掉 `what` → T-E 全是“说清了 0/4 条”
 * **合并规则是通用的，但断言带的信息不能丢。**
 */
function assertionsOf(parsed: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const o = parsed as { duplicates?: unknown; findings?: unknown } | null;
  const dup = o?.duplicates;
  if (Array.isArray(dup)) {
    for (const g of dup) {
      if (Array.isArray(g) && g.length >= 2) {
        out.set([...g].map(String).sort().join("+"), [...g].map(String).sort());
      }
    }
  }
  const find = o?.findings;
  if (Array.isArray(find)) {
    for (const f of find) {
      const file = (f as { file?: unknown })?.file;
      if (file) out.set(String(file), f);
    }
  }
  return out;
}

function readAssertions(cwd: string, artifact: string): Map<string, unknown> {
  const p = join(cwd, artifact);
  if (!existsSync(p)) return new Map();
  try {
    const t = readFileSync(p, "utf8");
    const s = t.indexOf("{");
    const e = t.lastIndexOf("}");
    if (s < 0 || e <= s) return new Map();
    return assertionsOf(JSON.parse(t.slice(s, e + 1)));
  } catch {
    return new Map();
  }
}

export function redundantSystem(deps: {
  lab: { createAgent: (spec: Record<string, unknown>) => Promise<any>; cwd: string };
  MODEL: string;
  READ_WRITE: string[];
}) {
  const { lab, MODEL, READ_WRITE } = deps;

  return {
    id: "redundant",
    what: "①+② 冗余：同一任务跑 N 遍（各自子目录），按交集合并",
    async run(task: Task, params: Record<string, unknown>, cwd: string, progress?: { step: string; meter?: Meter }) {
      const meter = new Meter();
      if (progress) progress.meter = meter;
      if (progress) progress.step = "开始（redundant：建 root）";
      const N = Math.max(1, Number(params.copies ?? 1));

      // ── N 份独立解答，各自在自己的子目录里 ──
      const perCopyMaps: Map<string, unknown>[] = [];
      let crashed: string | undefined;

      for (let i = 1; i <= N; i++) {
        const sub = join(cwd, `r${i}`);
        mkdirSync(sub, { recursive: true });
        // 每份解答看到的是**同一份语料**，但产物路径指向自己的子目录。
        // ★ 用「相对本目录」的写法，让 agent 自然地在子目录里落盘。
        const role = "你独自完成整个任务。用 read 看材料，用 write 写产物。";
        // ★ 路径必须说死 ★
        // 实测踩到：写成 `work/r1/…` 时，agent 有时理解为 cwd/work/r1、有时 cwd/r1，
        // 于是产物落到两个不同地方，合并时读到空集。
        // 改成给它一个**相对于 cwd 的、不含歧义的**路径，并在结尾再强调一次。
        const outPath = `r${i}/${task.artifact}`;
        const prompt =
          `${task.brief}\n\n` +
          `⚠ 你与其他 ${N - 1} 位同事在**互不相通**地做同一道题 —— 不要去找他们的产物，也不要互相参照。\n` +
          `你的产物必须写到**当前目录下**的 \`${outPath}\`（就这个路径，不要另加前缀）。`;

        const agent = await lab.createAgent({
          id: `redundant-r${i}-${Date.now()}`,
          model: MODEL,
          role,
          permissions: { only: READ_WRITE },
        });
        meter.watch(agent, { role: `copy${i}`, depth: 1 });
        if (progress) progress.step = `prompt 中（第 ${i}/${N} 份）`;
        try {
          const res = await agent.io.prompt(prompt);
          if (res.error) crashed = `第 ${i} 份失败：${res.error}`;
        } catch (e) {
          crashed = `第 ${i} 份崩了：${(e as Error).message}`;
        }
        if (progress) progress.step = `第 ${i}/${N} 份完成`;
      }

      meter.settle();
      if (progress) progress.step = "合并中";
      for (let i = 1; i <= N; i++) {
        perCopyMaps.push(readAssertions(join(cwd, `r${i}`), task.artifact));
      }
      const perCopyGroups = perCopyMaps.map((m) => new Set(m.keys()));

      // ── 交集 / 并集 / 一致性 ──
      const intersection = new Set<string>(perCopyGroups[0] ?? []);
      for (const s of perCopyGroups.slice(1)) {
        for (const g of [...intersection]) if (!s.has(g)) intersection.delete(g);
      }
      const union = new Set<string>();
      for (const s of perCopyGroups) for (const g of s) union.add(g);

      // 两两一致率：任两份之间共享的组数 / 并集大小
      let pairAgree = 0;
      let pairTotal = 0;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const a = perCopyGroups[i];
          const b = perCopyGroups[j];
          const u = new Set([...a, ...b]);
          const inter = [...a].filter((g) => b.has(g)).length;
          pairAgree += u.size ? inter / u.size : 1;
          pairTotal++;
        }
      }
      const consistency = pairTotal ? pairAgree / pairTotal : 1;

      // ── 写成"合并产物"（判据读的就是它）──
      // ★ 形状必须与任务一致（T-A 是 duplicates，T-E 是 findings）★
      // 实测踩到：T-E 上硬写 duplicates → 判据报“产物不存在或不是合法 JSON”。
      // T-E 的断言是文件名，不能带 "+" 拆组（一个文件就是一条断言）。
      const isFindings = /findings/i.test(task.brief) || task.artifact !== "answer.json";
      const merged: Record<string, unknown> = isFindings
        ? {
            // ★ 把原文的 `what` 带回来 ★
            // 实测踩到：只写占位字符串，判据报“说清了 0/4 条” ——
            //   判据要的不只是“报了哪个文件”，还包括“说清了是什么缺陷”。
            findings: [...intersection].map((k) => {
              for (const m of perCopyMaps) if (m.has(k)) return m.get(k);
              return { file: k, what: "" };
            }),
          }
        : { duplicates: [...intersection].map((k) => k.split("+")), irrelevant: [] };
      writeFileSync(join(cwd, task.artifact), JSON.stringify(merged, null, 2));

      // ── ★ 三个判别量写进 structured，供分析用 ──
      const structured = {
        merged,
        _redundancy: {
          copies: N,
          perCopy: perCopyGroups.map((s) => s.size),
          intersection: intersection.size,
          union: union.size,
          consistency,
        },
      };

      meter.dispose();
      // ★ 每份的原始答案要存下来 ★
      // 实测踩到：只看 `perCopy` 的**个数**时，看到 [8,8,8] 会以为“三份都对了”，
      // 但实际每份找的是**不同的组**，交集因此误杀。
      // 个数看不出这一点 —— 必须把每份的组原样记下来。
      const perCopyDetail = perCopyGroups.map((s) => [...s].sort());
      return {
        meter,
        text: JSON.stringify(merged, null, 2),
        structured: { ...structured, _redundancy: { ...structured._redundancy, perCopyDetail } },
        crashed,
      };
    },
  };
}
