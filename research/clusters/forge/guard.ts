// 写边界守卫 —— ★ 用代码立规矩（不是提示）
//
// ★★ 本项目实测（P12）：**只拦不给路，它会反复撞墙** ——
//    `gate` 只给一句 reason 时拦了 59 次、判断提交 0 次、905k token；
//    配上"路"之后 0 次拦截、6 次提交、93k token（成本差 10 倍）。
//    ⇒ 所以 BLOCK_REASON 里**必须写明三条路**。

import { join } from "node:path";
import type { ToolGate } from "../../../src/index.ts";
import { LAB, CLUSTER, REPO } from "./paths.ts";
import { SOURCE_CLUSTER } from "./prompts/missions.ts";

/** 归一化路径：统一分隔符，便于前缀比较 */
const norm = (s: string) => s.replace(/\\/g, "/");

/**
 * ★★★ 第一集群的空间 —— 对本集群**只读**（2026-10-19 实测发现的洞）。
 *
 * ★ 为什么必须堵：守卫原来只知道**自己的** `LAB` ⇒
 *   第二集群分析第一集群时，`write lab-3b/outbox/P44.md` 会被**放行** ——
 *   而那是它正在分析的对象。**改掉被分析的对象 = 数据被污染且无声无息**。
 * ★★ 堵法与「仓库主体只读」同一条：**拦，但给路**（`P12`）。
 */
const SOURCE_LAB = join(REPO, "research/labfirst", SOURCE_CLUSTER);

/**
 * ★★★ 写边界的**纯函数核心**（2026-10-19 提取）。
 *
 * ★ 为什么抽出来：路径是模块级求值的，而"第二集群读得到 lab-3b、写不了 lab-3b"
 *   这两件事要能**单独测**（不靠子进程 + 环境变量 + npx 缓存路径）。
 *   ⇒ 把三个目录当参数传进来，测试里直接给假路径。
 */
export interface Bounds {
  /** 本集群可写的空间 */
  lab: string;
  /** 第一集群的空间（本集群不是它时只读）*/ 
  sourceLab: string;
  /** ★ 本集群**就是**第一集群吗（是 ⇒ sourceLab 不适用，自己写自己放行）*/
  isSource: boolean;
}

/**
 * 用当前集群的真实配置造一份 Bounds
 *
 * ★★★ 2026-10-20 拆分：原来是 `isSource: CLUSTER === SOURCE_CLUSTER`。
 *   forge **永远不是第一集群** ⇒ 这个判断恒为 `false`，直接写死。
 *   （hunt 那份对应地恒为 `true`。）
 */
function ownBounds(): Bounds {
  return { lab: LAB, sourceLab: SOURCE_LAB, isSource: false };
}

/** 是不是"本集群空间之内" */
function inside(p: string, b: Bounds): boolean {
  return norm(p).startsWith(norm(b.lab));
}

/** ★ 是不是"第一集群的空间"（本集群不是它时才只读） */
function isSourcePath(p: string, b: Bounds): boolean {
  return !b.isSource && norm(p).startsWith(norm(b.sourceLab));
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
export function outsideWrite(name: string, input: Record<string, unknown>, bounds = ownBounds()): string | null {
  // ① 文件工具：直接看路径参数
  if (name === "write" || name === "edit") {
    const p = String(input.path ?? "");
    // ★★★ 先堵第一集群的空间（只读的对象不能被改），再看本空间
    if (isSourcePath(p, bounds)) return p;
    return inside(p, bounds) ? null : p;
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

    // 命令行里出现本空间 → 放行（★ 但第一集群的空间例外 —— 下面单独拦）
    if (norm(cmd).includes(norm(bounds.lab))) return null;

    // ★★★ 命令行里出现第一集群的空间 → **拦**
    if (!bounds.isSource && norm(cmd).includes(norm(bounds.sourceLab))) return bounds.sourceLab;

    // 看写操作的目标路径
    const m = stripped.match(
      /(?:>|>>|\btee\b\s+|\brm\s+|\bmv\s+|\bcp\s+|touch\s+|mkdir\s+)\s*"?([^\s"';|]+)/,
    );
    if (m) {
      const t = norm(m[1]!);
      // 相对路径 = 它的 cwd（自己的 work/）→ 放行
      if (!/^[a-zA-Z]:\//.test(t) && !t.startsWith("/")) return null;
      return inside(t, bounds) ? null : t;
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

/**
 * ★★★ 试图改**第一集群**的东西时给的话。
 *
 * ★ 为什么单独一句：这不是"仓库主体"那种抽象的只读 ——
 *   那是**你正在分析的对象**。改它 ⇒ **结论建立在被你修改过的证据上**。
 */
export const SOURCE_BLOCK_REASON =
  "★ 那是**第一集群（被分析对象）**的空间 —— 对你**只读**。\n" +
  "· 要验证/推翻它的结论 → ★ **在自己的空间里重做一遍**（`work/`）——" +
  "重做的过程里你才看得出它的判据错在哪\n" +
  "· 你发现它错了 → 写进你的 `outbox/`（★ 批判本身是成果），**不要去改它**\n" +
  "· 想让它改 → 写进 `outbox/`，研究助手转达\n" +
  "★ **改掉被分析的对象 = 你的结论建在你改过的证据上** —— 它不会通。";

/** 给一个 agent 挂上守卫 */
export function attachGate(agent: { permissions: { gate: (fn: ToolGate) => void } }): void {
  const g: ToolGate = async (call) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const bad = outsideWrite(call.name, inp);
    if (!bad) return undefined;
    // ★ 第一集群那条给专门的话（拦的同时给路 —— P12）
    const reason = isSourcePath(String(bad), ownBounds()) ? SOURCE_BLOCK_REASON : BLOCK_REASON;
    return { block: true as const, reason };
  };
  agent.permissions.gate(g);
}
