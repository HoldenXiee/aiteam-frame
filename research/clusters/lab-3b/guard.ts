// 写边界守卫 —— ★ 用代码立规矩（不是提示）
//
// ★★ 本项目实测（P12）：**只拦不给路，它会反复撞墙** ——
//    `gate` 只给一句 reason 时拦了 59 次、判断提交 0 次、905k token；
//    配上"路"之后 0 次拦截、6 次提交、93k token（成本差 10 倍）。
//    ⇒ 所以 BLOCK_REASON 里**必须写明三条路**。

import type { ToolGate } from "../../../src/index.ts";
import { LAB } from "./paths.ts";

/** 归一化路径：统一分隔符，便于前缀比较 */
const norm = (s: string) => s.replace(/\\/g, "/");

/** 是不是"本集群空间之内" */
function inside(p: string): boolean {
  return norm(p).startsWith(norm(LAB));
}

/**
 * 判断一次调用是不是"写到空间之外"。
 * ★ 返回越界的路径（或标记字符串）；没越界返回 null。
 *
 * ★ 两条历史教训（都吃过亏）：
 *   ① **裸子串匹配**会把 `/dev/null` 里的 `dev` 当成受保护路径（P24 抓到）；
 *      真根因是「设备路径 `/dev/` 与受保护 token `dev` 同名」。
 *   ② `2>/dev/null` **一个字符串同时含 `dev` 和 `>`** → 任何含它的命令无条件被拦。
 *      修法是**先剥只读重定向，再判真写**。
 */
export function outsideWrite(name: string, input: Record<string, unknown>): string | null {
  // ① 文件工具：直接看路径参数
  if (name === "write" || name === "edit") {
    const p = String(input.path ?? "");
    return inside(p) ? null : p;
  }

  // ② bash：先剥只读重定向，再只认"真写"
  if (name === "bash") {
    const cmd = String(input.command ?? "");
    const stripped = cmd
      .replace(/2\s*>\s*\/dev\/null/g, "")
      .replace(/2\s*>&\s*1/g, "");

    // ★ 只认真写：>、>>、tee、sed -i、rm/mv/cp/touch/mkdir
    const writes = /(^|[^0-9])>(?!>)|>>|\btee\b|\bsed\s+-i|\brm\s|\bmv\s|\bcp\s|\btouch\b|\bmkdir\b/.test(
      stripped,
    );
    if (!writes) return null;

    // 命令行里出现本空间 → 放行
    if (norm(cmd).includes(norm(LAB))) return null;

    // 看写操作的目标路径
    const m = stripped.match(
      /(?:>|>>|\btee\b\s+|\brm\s+|\bmv\s+|\bcp\s+|touch\s+|mkdir\s+)\s*"?([^\s"';|]+)/,
    );
    if (m) {
      const t = norm(m[1]!);
      // 相对路径 = 它的 cwd（自己的 work/）→ 放行
      if (!/^[a-zA-Z]:\//.test(t) && !t.startsWith("/")) return null;
      return inside(t) ? null : t;
    }
    return "(bash 写操作，目标不明)";
  }

  return null;
}

/**
 * ★★★ 拦下时给的话 —— **必须包含"路"**（P12）。
 * 改这句话之前先读 P12。
 */
export const BLOCK_REASON =
  "这个路径只读（仓库主体不归你改）。★ 但**路是有的**：\n" +
  "· 想改库 → `lib/aiteam/` 和 `lib/pi/` 里各有一份**你可以随便改**的拷贝，" +
  "改完在 `lib/PATCHES.md` 记「改了什么 / 带来什么好处」\n" +
  "· 想改实验装置 → 复制到你的 `work/` 里改\n" +
  "· 想要仓库里别的东西变 → 写进 `outbox/`，研究助手去做\n" +
  "★ 不要反复试这条路，它不会通。";

/** 给一个 agent 挂上守卫 */
export function attachGate(agent: { permissions: { gate: (fn: ToolGate) => void } }): void {
  const g: ToolGate = async (call) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const bad = outsideWrite(call.name, inp);
    return bad ? { block: true as const, reason: BLOCK_REASON } : undefined;
  };
  agent.permissions.gate(g);
}
