// ★★★★★ 「发现」有没有进状态表（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 这个文件要量的事
//
//   实测（2026-10-21）：hunt 做出了 **11 份手段审查**，其中
//
//     INSPIR-7 → CONVERGED 提及 1 次
//     INSPIR-8 / INSPIR-9 → **0 次**
//     手段IV / 手段V → 各 1 次
//     ★ 手段VI / 手段VII / 手段续 → **0 次**
//
//   ★★★ 而这三份恰恰是**最新、且含纠正**的：
//     · `手段VI`：出生后未封口的 3 批**不存在**（两次快照拼的）
//     · `手段VII`：**seal 自己的洞** —— 窗口内别人写的行会被签成自己的
//     · `手段续`：43/101 是错的，逐字节可核的只有 **7/101**
//
//   ★★ 后果可数：`CONVERGED` 的 `O27` 现在写着「**装置已证**」——
//      而 `手段VII` 已经证明它有洞。**状态表偏乐观了。**
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么这是 hunt 的核心问题（而不是"又一条没接上"）
//
//   hunt 的价值不是"产出多少份"，是**它维护的那张状态表**：
//     「哪些 claim 还成立 / 哪些被取代 / 哪些降级」
//   ★ 如果新发现**不进状态表**，那这张表就会**越来越像真的、实际越来越旧** ——
//     比没有表更危险（没有表时人会去查原始产物；有表时会信表）。
//
//   ★★ 所以这个读具量的不是"产能"，是**知识的吸收率**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 口径（★ 我前三次修量具的教训：写清分母和判据）
//
//   · 「手段审查类产物」= 文件名以 `INSPIR` 或 `手段` 开头的 `.md`
//   · 「进了状态表」= `CONVERGED.md` 里**出现过它的文件名主干**
//   · ★ 不用 mtime（那是"现在"，不是"当时"）
//   · ★ 分母是**这一类产物**，不是全部 129 份（否则比例永远很小）
// ══════════════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const NL = String.fromCharCode(10);

export type Absorption = {
  /** 手段审查类产物总数 */
  total: number;
  /** ★ 其中在状态表里出现过的 */
  absorbed: number;
  /** ★★★ 没进状态表的（含文件名） */
  missing: { name: string; chars: number }[];
};

/**
 * ★ 纯函数：算吸收率（纪律⑦：可离线重判）
 *
 * @param products 产物文件名清单（不带目录）
 * @param converged 状态表全文
 * @param charOf  取某份产物的字数（用于"长的优先"排序，不判好坏）
 */
/**
 * ★ 取短代号（状态表里实际用的写法）
 *   `INSPIR-7-手段审查-…` → `INSPIR-7`
 *   `手段VII-seal的…`     → `手段VII`
 *   `手段续-我上一条…`    → `手段续`
 *   `手段-判据冻结…`      → `手段`（★ 这类代号本身有歧义，见 render 的说明）
 */
export function shortCode(file: string): string {
  const stem = file.replace(/\.md$/, "");
  const m = /^(INSPIR-\d+|手段[IVX]+|手段续)/.exec(stem);
  return m ? m[1]! : stem.split("-")[0]!;
}

export function absorption(
  products: string[],
  converged: string,
  charOf: (name: string) => number,
): Absorption {
  // ★ 手段审查类：文件名以 INSPIR 或 手段 开头
  const mine = products.filter((f) => /^(INSPIR|手段)/.test(f) && f.endsWith(".md"));

  const missing: { name: string; chars: number }[] = [];
  let absorbed = 0;

  for (const f of mine) {
    // ★★★ 判据：用**短代号**（`INSPIR-7` / `手段VII` / `手段续`）。
    //
    //   ★ 为什么不用全名（2026-10-21 我自己先犯的错）：
    //     全名有 40+ 字，状态表里**从不**写全名 ⇒ 用全名判会得 1/11（9%），
    //     而实际状态表里写的是 `手段IV`、`INSPIR-7` 这种短代号。
    //     ★★ 这正是纪律㉞：**口径里混进了不属于这个问题的东西**（把"引用格式"当成了"有没有被吸收"）。
    const code = shortCode(f);
    const hit = converged.includes(code);
    if (hit) absorbed++;
    else missing.push({ name: f, chars: charOf(f) });
  }

  // ★ 长的排前面（★ 长的通常是主产物，短的多是续篇）
  missing.sort((a, b) => b.chars - a.chars);
  return { total: mine.length, absorbed, missing };
}

/** ★ 从盘上读 */
export function readAbsorption(outboxDir: string): Absorption {
  const convergedPath = join(outboxDir, "CONVERGED.md");
  const converged = existsSync(convergedPath) ? readFileSync(convergedPath, "utf8") : "";
  let products: string[] = [];
  try {
    products = readdirSync(outboxDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { total: 0, absorbed: 0, missing: [] };
  }
  return absorption(products, converged, (f) => {
    try {
      return readFileSync(join(outboxDir, f), "utf8").length;
    } catch {
      return 0;
    }
  });
}

/** ★ 渲染成一行读数 */
export function renderAbsorption(a: Absorption): string {
  if (!a.total) return "（还没有手段审查类产物）";
  const pct = Math.round((a.absorbed / a.total) * 100);
  const miss = a.missing.length;
  return (
    `手段审查 ${a.total} 份 · ★ 进了状态表 ${a.absorbed} 份（${pct}%）` +
    (miss ? ` · ★★ 未进 ${miss} 份 ${a.missing.map((m) => shortCode(m.name)).join("/")}` : " · 全部已进 ✔") +
    // ★★ 诚实说明这个判据的弱点
    (a.missing.some((m) => shortCode(m.name) === "手段")
      ? "（★ 注意：`手段` 是通用词，可能误命中 —— 这个代号本身有歧义）"
      : "")
  );
}
