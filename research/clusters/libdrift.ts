// ★★★★★ 三份 lib 的漂移（2026-10-21）
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么要这个读具
//
//   AGENTS.md 的裁定是：**「集群的使命是使用者代码，不是库」**
//   ⇒ 两个集群各有自己的一份 `lib/` 副本，**可以改**。这是设计如此。
//
//   ★★★ 但实测（2026-10-21）：
//
//     `hunt/lib`  vs `src/`        4+ 个文件不同（hunt 改过，从没回到 src/）
//     `hunt/lib`  vs `forge/lib`   **14 个文件不同**（两份副本已经漂移）
//     最近 3 天改 lib 的          **只有 hunt**（forge 的 `libsmith` 是闲的）
//
//   ⇒ 后果：**集群在一份会漂的分支上开发能力，而仓库本体永远拿不到。**
//     我在 `hunt跑一轮-改了9个库文件` 里记了这件事，然后**没有下一步**。
//
// ══════════════════════════════════════════════════════════════════════════
// ★ 为什么这是**我的**活，不是集群的
//
//   · 集群**不能**改 `src/`（那是仓库本体，AGENTS「边界」）
//   · 所以「集群改出来的东西要不要进 src/」**只能我来判断并执行**
//   · 而我一直没做 ⇒ 这笔账**从来没人算**
//
//   ★★ 这个读具不判"该不该合"（那是内容判断，硬规则①），
//      它只把**欠账清单**摆出来：哪些文件不同、差多少行。
// ══════════════════════════════════════════════════════════════════════════

export type DiffEntry = { file: string; kind: "differ" | "only-left" | "only-right" };

export type LibDrift = {
  /** 左/右各是谁（用于读数） */
  left: string;
  right: string;
  differ: DiffEntry[];
  onlyLeft: DiffEntry[];
  onlyRight: DiffEntry[];
  /** ★ 总计（= 三栏之和） */
  total: number;
};

/**
 * ★ 纯函数：把 `diff -rq` 式的原始行归成三栏（纪律⑦：可离线重判）
 *
 * 认三种输入（git 和 diff 两种写法都收）：
 *   `Files A and B differ`            → differ
 *   `Only in A: name`                 → only-left
 *   `Only in B: name`                 → only-right
 *
 * ★ 不认的行走 `ignore` —— **不许静默丢**（纪律：失败要响）。
 */
export function parseDrift(lines: string[], left: string, right: string): { drift: LibDrift; ignore: string[] } {
  const differ: DiffEntry[] = [];
  const onlyLeft: DiffEntry[] = [];
  const onlyRight: DiffEntry[] = [];
  const ignore: string[] = [];
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m1 = /^Files (.+?) and (.+?) differ$/.exec(line);
    if (m1) {
      // ★ 取相对左根的名字；左根不匹配时退回右根
      const a = norm(m1[1]!);
      const b = norm(m1[2]!);
      const rel = a.startsWith(norm(left) + "/") ? a.slice(norm(left).length + 1) : b;
      differ.push({ file: rel, kind: "differ" });
      continue;
    }
    const m2 = /^Only in (.+?): (.+)$/.exec(line);
    if (m2) {
      const dir = norm(m2[1]!);
      const name = m2[2]!;
      // ★ 判是左还是右：看 dir 是否以左根开头
      const isLeft = dir === norm(left) || dir.startsWith(norm(left) + "/");
      const rel = dir.startsWith(norm(left) + "/")
        ? dir.slice(norm(left).length + 1) + "/" + name
        : dir.startsWith(norm(right) + "/")
          ? dir.slice(norm(right).length + 1) + "/" + name
          : name;
      if (isLeft) onlyLeft.push({ file: rel, kind: "only-left" });
      else onlyRight.push({ file: rel, kind: "only-right" });
      continue;
    }
    ignore.push(line);
  }

  differ.sort((x, y) => x.file.localeCompare(y.file));
  onlyLeft.sort((x, y) => x.file.localeCompare(y.file));
  onlyRight.sort((x, y) => x.file.localeCompare(y.file));
  return {
    drift: { left, right, differ, onlyLeft, onlyRight, total: differ.length + onlyLeft.length + onlyRight.length },
    ignore,
  };
}

/** ★ 渲染成读数（★ 要能看出"该不该合"之前先看得见"有多少"） */
export function renderDrift(d: LibDrift): string {
  if (d.total === 0) return `✔ ${d.left} 与 ${d.right} 完全一致`;
  const L: string[] = [];
  L.push(`★★ ${d.left} 与 ${d.right}：**${d.total} 处不同**（改过 ${d.differ.length} · 只在左 ${d.onlyLeft.length} · 只在右 ${d.onlyRight.length}）`);
  for (const x of d.differ.slice(0, 12)) L.push(`   ≠ ${x.file}`);
  if (d.differ.length > 12) L.push(`   … 还有 ${d.differ.length - 12} 个`);
  for (const x of d.onlyLeft.slice(0, 6)) L.push(`   +只左 ${x.file}`);
  for (const x of d.onlyRight.slice(0, 6)) L.push(`   -只右 ${x.file}`);
  return L.join(String.fromCharCode(10));
}
