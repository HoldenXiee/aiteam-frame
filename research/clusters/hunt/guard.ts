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
 * ★★★ 段级归一（2026-10-25）—— 判「在不在某个目录之内」必须按**路径段**，不能按字符串前缀。
 *
 * ★ 为什么（D-202 W4，人造答案实测的洞）：原实现是 `norm(p).startsWith(norm(b.lab))`，
 *   而 `hunt-r2-old/` 以 `hunt-r2` 开头 ⇒ **兄弟目录被判成「内」** ⇒ 可写。
 *   同类：`libx/` 被判成 `lib/`。⇒ 一条字符串前缀判定同时放开了两个洞。
 * ★ 去尾斜杠：`<LAB>/` 与 `<LAB>` 必须同义。
 * ★ 小写：Windows 路径大小写不敏感，`d:/space/...` 与 `D:/space/...` 是同一条路 ——
 *   不归一就会**误拦**合法写入（P12 的反面：路是通的，守卫说没通）。
 */
const seg = (s: string) => norm(s).replace(/\/+$/, "").toLowerCase();

/** 段级「之内」：`/a/b` 在 `/a` 内，`/a/bc` **不**在 `/a` 内 */
const segInside = (p: string, root: string): boolean => {
  const pp = seg(p);
  const rr = seg(root);
  return pp === rr || pp.startsWith(rr + "/");
};

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
 *   hunt **就是第一集群** ⇒ 这个判断恒为 `true`，直接写死。
 *   （forge 那份对应地恒为 `false`。）
 */
function ownBounds(): Bounds {
  return { lab: LAB, sourceLab: SOURCE_LAB, isSource: true };
}

/** ★ 是不是"本集群空间之内"（段级 —— 见 `segInside` 的注释） */
function inside(p: string, b: Bounds): boolean {
  return segInside(p, b.lab);
}

/**
 * ★ 相对路径的基准（D-202 W9）。
 *
 * ★ 基准 = agent 的 cwd（`env.ts` 的 `labAt(join(LAB,"work"))`）**再叠加命令里的 `cd`**。
 * ★★ 为什么必须叠加 `cd`（2026-10-25 我自己踩出来的）：
 *   先修了一版「相对路径一律按 `work/` 解析」，然后在 `clusters/hunt/` 里跑
 *   `cp <LAB>/work/x.ts guard.ts` —— 守卫算成 `<LAB>/work/guard.ts`（内）⇒ 放行，
 *   而真实落点是一个**空间外的相对路径**。
 *   ⇒ 「基准恒为 work/」是**假设**，不是事实；不跟 `cd` 就是一条静默逃逸。
 */
const WORK_CWD = (b: Bounds): string => join(b.lab, "work");

/** 把路径相对某个基准解析成绝对路径（绝对路径原样返回） */
function toAbsFrom(p: string, base: string): string {
  const t = norm(String(p ?? "")).trim();
  if (!t) return t;
  if (/^[a-zA-Z]:\//.test(t) || t.startsWith("/")) return t;
  return norm(join(base, t));
}

/** 把路径参数解析成绝对路径（基准 = work/） */
function toAbs(p: string, b: Bounds): string {
  return toAbsFrom(p, WORK_CWD(b));
}

/**
 * ★★★ 命令里的 `cd` 会改变**后续相对路径**的基准 —— 必须跟着它算（2026-10-25）。
 *
 * ★ 只认绝对/相对两种写法；`cd -`、`cd` 无参数跳过（基准不可静态判 ⇒ 保持 work/）。
 * ★ 多个 `cd` 取最后一个：`cd a && cd b && rm x` 里 `x` 相对的是 `b`。
 */
function cwdBase(cmd: string, b: Bounds): string {
  let base = WORK_CWD(b);
  for (const m of cmd.matchAll(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) {
    const t = m[1] ?? m[2] ?? m[3];
    if (!t || t === "-") continue;
    base = toAbsFrom(t, base);
  }
  return base;
}

/**
 * ★★★ 抽出一条 bash 命令里的**写目标**（2026-10-25，D-202 B3）。
 *
 * ★ 为什么需要：原实现是「命令串里出现本空间 → 直接 `return null`」，
 *   于是 `cp <LAB>/work/a.txt /etc/x` 因为含本空间就放行 —— **第二个目标没人看**。
 * ★ 但也不能反过来「只要出现绝对路径就拦」：读操作（`cp /etc/passwd <LAB>/work/`）会全被拦（P12 教训）。
 *   ⇒ 只能**按操作符语义**取写目标：
 *     · `>` `>>` `tee` `rm` `mv` `touch` `mkdir` → 全部参数都是写
 *     · `cp` `sed -i` → **只有最后一个**参数是写（前面是源 = 读）
 * ★ 已知边界（写在这里，不假装没有）：命令内部的 `cd /tmp && echo x > y` 里 `y` 的真实位置
 *   静态判不出（它相对的是**执行时**的 cwd，不是 `work/`）⇒ 这种写法仍按 `work/` 解析。
 *   宁可选“可能漏”而不是“大量误拦”：P12 的代价是不对称的。
 */
function writeTargets(cmd: string): string[] {
  const out: string[] = [];
  // ① 重定向的目标一定是写目标
  for (const m of cmd.matchAll(/(?:^|[^0-9>])>>?\s*"?([^\s"';|&()]+)/g)) if (m[1]) out.push(m[1]);
  // ② 命令词的写目标（按语义取）
  const OPS = /\b(tee|rm|mv|cp|touch|mkdir|sed)\b/g;
  let m: RegExpExecArray | null;
  while ((m = OPS.exec(cmd))) {
    const op = m[1]!;
    const rest = cmd.slice(m.index + op.length);
    const stop = rest.search(/;|&&|\|\||\|/);
    const chunk = stop >= 0 ? rest.slice(0, stop) : rest;
    const args = chunk
      .split(/\s+/)
      .map((s) => s.replace(/^["']|["']$/g, ""))
      .filter((s) => s && !s.startsWith("-"));
    if (!args.length) continue;
    if (op === "cp" || op === "sed") {
      const last = args[args.length - 1];
      if (last) out.push(last);
    } else out.push(...args);
  }
  return out;
}

/**
 * ★★★ 是不是"那份可写的库"（2026-10-25 追加）—— `lib/` 不是"谁都能写"的地方。
 *
 * ★ 为什么要在守卫里分这一层：`env.ts` 的 `fsRoot` 已放宽到整个 `LAB`
 *   （不这么放宽，`outbox/` 与 `lib/` **读都读不到**，改库者的使命物理上不可能）。
 *   于是"写窄"必须由这里执行 —— 否则 `prompts/index.ts` 那句
 *   「只有它能写 —— 而且只能写 lib/」就变成一句空话（现在它确实是空话，只是反了一面）。
 */
const LIB_DIR = (b: Bounds): string => join(b.lab, "lib");
function isLibPath(p: string, b: Bounds): boolean {
  // ★ 段级：`libx/` 不是 `lib/`（字符串前缀会把它算进去）
  return segInside(p, LIB_DIR(b));
}
/**
 * ★ bash 用这个：命令串里"**提到**" lib/ 就算 —— 不能用 startsWith。
 * （人造答案 ①⑤ 实测：`cp work/a.ts <LAB>/lib/aiteam/b.ts` 的写目标在后面，
 *  startsWith 版本对它返回 null = 放行 = 静默漏洞。这就是"判据只看得见它被写成的形状"。）
 */
function mentionsLib(cmd: string, b: Bounds): boolean {
  return seg(cmd).includes(seg(LIB_DIR(b)));
}

/** 一个 agent 的写权限政策（★ 政策在集群代码，机制在库） */
export interface GatePolicy {
  /** 这个 agent 能不能写 `lib/` —— 只有改库者能 */
  canWriteLib?: boolean;
}

/**
 * ★★★ 是不是 `inbox/`（2026-10-25）—— **投递通道是单向的**。
 *
 * ★ 为什么必须在放宽 `fsRoot` 的同一轮里堵上：`env.ts` 的 `fsRoot` 从 `[work, …]` 放宽到 `[LAB, …]`
 *   （不这么放宽，`outbox/` 与 `lib/` 读都读不到），而 `LAB` 包含 `inbox/` ⇒
 *   **收件人突然能改写自己的投递件**（`inbox/研究手册.md` 是助手给它的输入）。
 * ★ 能改自己的输入 = 能伪造“我读到的要求” ⇒ 事后无法区分“它按手册做”与“它改了手册”。
 *   ⇒ 读开（它能读手册）、写关（它不能改手册）—— 正是“读广写窄”在 `inbox/` 上的落实。
 */
const INBOX_DIR = (b: Bounds): string => join(b.lab, "inbox");
function isInboxPath(p: string, b: Bounds): boolean {
  return segInside(p, INBOX_DIR(b));
}

/** ★ 是不是"第一集群的空间"（本集群不是它时才只读） */
function isSourcePath(p: string, b: Bounds): boolean {
  return !b.isSource && segInside(p, b.sourceLab);
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
export function outsideWrite(
  name: string,
  input: Record<string, unknown>,
  bounds = ownBounds(),
  policy: GatePolicy = {},
): string | null {
  // ① 文件工具：直接看路径参数
  if (name === "write" || name === "edit") {
    // ★★★ 先解析相对路径，再判（D-202 W9）：`write ../outbox/x.md` 是**合法成果路径**
    //   （cwd = `<LAB>/work`），原来它被当成「不以 LAB 开头」⇒ 拦；而同一个路径走 bash 却放行。
    const p = toAbs(String(input.path ?? ""), bounds);
    // ★★★ 先堵第一集群的空间（只读的对象不能被改），再看本空间
    if (isSourcePath(p, bounds)) return p;
    // ★★ 再堵 `lib/`（不是改库者就不行 —— 读了才是所有人都有权的事）
    if (isLibPath(p, bounds) && !policy.canWriteLib) return p;
    // ★★ `inbox/` 是投递通道（助手 → 你）—— 收件人不能改自己的输入
    if (isInboxPath(p, bounds)) return p;
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

    // ★★★ 写 `lib/` 且不是改库者 → **拦**（2026-10-25）：这条必须排在"出现本空间就放行"前面
    if (mentionsLib(cmd, bounds) && !policy.canWriteLib) return join(bounds.lab, "lib");

    // ★★★ 2026-10-25（D-202 B3）：先把**所有**写目标抽出来逐个判，不再「提到本空间就放行」。
    //   ★ 原实现的问题：`cp <LAB>/work/a.txt /etc/x` 含本空间 ⇒ `return null` ⇒ **第二个目标没人看**。
    //   ★ 修法只判**写目标**（不是「出现绝对路径就拦」）—— 后者会把 `cp /etc/passwd <LAB>/work/` 这类
    //     读操作全拦掉，那是 P12 那个代价（拦 59 次 → 905k token）的重演。
    const targets = writeTargets(stripped);
    // ★★ 基准跟 `cd` 走（不跟就是一条静默逃逸 —— 见 `WORK_CWD` 注释）
    const base = cwdBase(stripped, bounds);

    // ★★★ 命令行里出现第一集群的空间 → **拦**（只读对象，宁可误拦）
    if (!bounds.isSource && seg(cmd).includes(seg(bounds.sourceLab))) return bounds.sourceLab;

    // ★ 逐个判目标：相对路径按**当前基准**（work/ 叠加 cd）解析 —— 与 write 分支同语义
    for (const raw of targets) {
      const t = toAbsFrom(raw, base);
      // ★ `inbox/` 先判（它在 LAB 内，不单独判会被 `inside` 放行）
      if (isInboxPath(t, bounds)) return t;
      if (!inside(t, bounds)) return t;
    }
    if (targets.length > 0) return null;

    // 目标不明：命令里提到本空间 ⇒ 放行（保持原来的宽松，避免 P12 那种反复撞墙）
    if (seg(cmd).includes(seg(bounds.lab))) return null;
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
  // ★★★ 2026-10-25 修正：原句是「`lib/aiteam/` 和 `lib/pi/` 里各有一份**你可以随便改**的拷贝」——
  //   对**研究员**这是假的（`guard.ts` 现在拦它写 `lib/`）。给了路而路是死的，
  //   比不给路更贵（P12：拦 59 次 / 905k token 就是这么来的）。
  "· 想改库 → `lib/aiteam/` 与 `lib/pi/` 是**唯一**能改的库，但**只有改库者能写**；" +
  "你若不是改库者 → ★ 写成能力缺口报告（现象 / 卡在哪 / 期望什么形状）放进 `outbox/`\n" +
  "· 想改实验装置 → 复制到你的 `work/` 里改\n" +
  "· 想要仓库里别的东西变 → 写进 `outbox/`，研究助手去做\n" +
  "★ 不要反复试这条路，它不会通。";

/**
 * ★★★ 试图改**第一集群**的东西时给的话。
 *
 * ★ 为什么单独一句：这不是"仓库主体"那种抽象的只读 ——
 *   那是**你正在分析的对象**。改它 ⇒ **结论建立在被你修改过的证据上**。
 */
/**
 * ★★★ 拦"非改库者写 lib/"时给的话（2026-10-25）。
 *
 * ★ 与 `BLOCK_REASON` 分开的理由：这不是"你没权限"，是"**这不是你的活**"。
 *   改库是**一个人**的工作（`lib/` 只有一个修订，两个写者 = 归因不到某个修订 ——
 *   语料里实测过这个代价）。所以这里给的路是"**把缺口写成报告**"，不是"换个目录写"。
 */
export const LIB_BLOCK_REASON =
  "`lib/` 是**改库者**的地盘，对你是**只读**的。\n" +
  "· 你觉得库缺什么 → ★ **写成能力缺口报告**（一条一句：现象 / 卡在哪 / 期望什么形状），" +
  "写进 `outbox/`，改库者会读到\n" +
  "· 你要验证「是不是库的问题」→ ★ 在 `work/` 里**自己搭一个最小装置**复现它（那才是证据）\n" +
  "· 你自己那次实验想改库 → 先在 `work/` 里拷一份改（★ 只影响你这次实验，不污染所有人的修订）\n" +
  "★ 理由：`lib/` 只有一个修订号 —— 两个写者同时改，**结果归因不到任何一个修订**。";

/**
 * ★★★ 拦“写 `inbox/`”时给的话（2026-10-25）。
 *
 * ★ 为什么单独一句：这不是“你没权限”，是“**这条路的方向是反的**”。
 *   投递是助手 → 你；你写回去，下一轮的你就分不清“手册里原本这么写”与“我改成了这么写”。
 */
export const INBOX_BLOCK_REASON =
  "`inbox/` 是**投递通道**（助手 → 你）—— 对你**只读**。\n" +
  "· 你要记东西 → ★ 写 `work/`（工作区）或 `outbox/`（成果）\n" +
  "· 你觉得手册错了/缺了 → ★ 写进 `outbox/`，助手下一轮改手册\n" +
  "★ 理由：你能改自己的输入 ⇒ 事后**分不清**“它按手册做”与“它先改了手册”。";

export const SOURCE_BLOCK_REASON =
  "★ 那是**第一集群（被分析对象）**的空间 —— 对你**只读**。\n" +
  "· 要验证/推翻它的结论 → ★ **在自己的空间里重做一遍**（`work/`）——" +
  "重做的过程里你才看得出它的判据错在哪\n" +
  "· 你发现它错了 → 写进你的 `outbox/`（★ 批判本身是成果），**不要去改它**\n" +
  "· 想让它改 → 写进 `outbox/`，研究助手转达\n" +
  "★ **改掉被分析的对象 = 你的结论建在你改过的证据上** —— 它不会通。";

/** 给一个 agent 挂上守卫 */
export function attachGate(
  agent: { permissions: { gate: (fn: ToolGate) => void } },
  policy: GatePolicy = {},
): void {
  const g: ToolGate = async (call) => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const bad = outsideWrite(call.name, inp, ownBounds(), policy);
    if (!bad) return undefined;
    // ★ 第一集群那条给专门的话（拦的同时给路 —— P12）
    const reason = isSourcePath(String(bad), ownBounds())
      ? SOURCE_BLOCK_REASON
      : isInboxPath(String(bad), ownBounds())
        ? INBOX_BLOCK_REASON
        : isLibPath(String(bad), ownBounds()) && !policy.canWriteLib
          ? LIB_BLOCK_REASON
          : BLOCK_REASON;
    return { block: true as const, reason };
  };
  agent.permissions.gate(g);
}
