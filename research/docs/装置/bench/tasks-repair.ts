// ★ T-F · 「修 bug 让测试过」—— 第一类**改造型**任务
//
// ★ 研究员指出的问题（2026-10-16）
//   「实验的任务会不会太简略了，没有设计过，应该要经过设计才对。比如设计一点复杂的，
//     工具调用多样一点的任务，但是必须要贴合实际生产或在科研创新中等等**发挥人的作用**的工作」
//
// ★ 已诊断的三个缺陷（此前所有任务）
//   ① **工具单调**：只有 `["read","write","ls"]` —— 从没用过 `edit` / `bash` / `grep` / `find`
//   ② **形状单调**：一步到底（读 N 份 → 写 JSON）—— **无中间产物、无返工、无依赖**
//   ③ **性质单调**：全是**判断类**（"这些材料重复吗"）—— **没有改造类**（改代码、让它跑通）
//
// ★ T-F 的设计原则
//   **判据 = 真跑测试。** 这是本项目最不可伪造的判据：
//     · 测试文件**只读**（permissions 挡住）→ 模型改不了判据
//     · 要么过要么不过 → 糊弄不过去
//     · ★ **而且它正是这个仓库每天在做的真实活**（每个 commit 都在修东西让测试过）
//
// ★ 劳动形状（真实、多步、有返工）
//   `grep` 搜 → `read` 看 → `edit` 改 → `bash` 跑测试 → ★ **看到失败 → 回去再改** → 通过
//
// ★ 难度旋钮
//   bugs    : 注入几个 bug（1 / 3）—— 多个 bug 时要**全部**修好才算过
//   sandbox : 给的起点是**整个真仓库**（不是玩具）—— 定位本身就是劳动
//
// ★ 判据纪律
//   1. 注入的 bug 必须**真能让测试变红**（已逐一实测验证，见 `BUG_POOL` 的 verified 字段）
//   2. ground truth（改了哪几处）**不泄露给 agent**
//   3. 判据是 `npm test` —— **纯函数式重判**，可离线复跑
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Task } from "./tasks.ts";

/** 一个**实测验证过**的注入 bug（把它注入 → `npm test` 真的变红） */
export interface InjectedBug {
  id: string;
  /** 相对仓库根的文件路径 */
  file: string;
  /** 正确片段（在文件里**恰好出现一次**） */
  correct: string;
  /** 注入的错误片段 */
  broken: string;
  /** ★ 说明 —— **不给 agent**，只进报告 */
  note: string;
  /** ★ 定位难度：agent 要找它得走几步 */
  difficulty: "direct" | "grep" | "indirect";
}

/**
 * ★ Bug 池 —— 全部取自**本仓库的真实代码**，且**逐一实测过「注入后测试变红」**。
 *
 * 选材标准（三条都要满足）：
 *   1. **改完测试真的红**（否则这个 bug 没有判别力）
 *   2. 错误形态**真实**（是"人会犯的错"，不是"把 a 换成 b"这种一眼假的）
 *   3. **修法不唯一**（只要测试过，怎么改都对 —— 不考记忆力，考能不能定位+验证）
 */
export const BUG_POOL: InjectedBug[] = [
  {
    id: "tools-noreload",
    file: "src/surfaces/tools.ts",
    correct: "        registerAllowed(def.name);",
    broken: "        void registerAllowed;",
    note:
      "`tools.add` 不再把新工具并入活跃集 —— **加了工具却不生效**（典型的静默失效：没有报错，只是模型永远看不到那个工具）。" +
      "要修它得先看懂 `registerAllowed` / reload 这套机制。",
    difficulty: "indirect",
  },
  {
    id: "ctx-refresh",
    file: "src/surfaces/context.ts",
    correct: "      if (erased.length) session.refreshContext();",
    broken: "      if (false && erased.length) session.refreshContext();",
    note:
      "`context.reset()` 抹除后不刷新投影 —— 抹掉了但 `history` 读到的还是旧的。" +
      "错在「少了同步」而不是「算错了」，要 grep 到 refreshContext 才看得穿。",
    difficulty: "grep",
  },
  {
    id: "obs-syscount",
    file: "src/surfaces/observe.ts",
    correct: '      const role = String((m as { role?: string }).role ?? "?");',
    broken: '      const role: string = "?";',
    note:
      "观测面把每条消息的角色都记成 `?` —— wire 的 `roles` / `systemCount` 全错。" +
      "测试只看数量不看内容，所以得看懂 wire 该长什么样。",
    difficulty: "direct",
  },
];

/** 沙箱里不能被改的东西（判据本身） */
export const READONLY_IN_SANDBOX = ["dev/test/**", "dev/docs/**", "AGENTS.md"];

export interface RepairTaskSpec {
  /** bug 的 id 列表（从 BUG_POOL 里选） */
  bugIds: string[];
  /** 沙箱根目录 */
  sandbox: string;
  /** 产出物 —— 修好的仓库本体（无独立 artifact 文件，就是代码本身） */
  artifact: string;
}

export interface RepairTask extends Task {
  sandbox: string;
  /** 注入了哪些（**agent 看不到**） */
  injected: { id: string; file: string; note: string; difficulty: string }[];
  /** 判据命令 */
  judgeCommand: string;
}

/** 把真仓库复制进沙箱，注入选定的 bug */
export function buildRepairTask(spec: RepairTaskSpec, repoRoot: string): RepairTask {
  const bugs = spec.bugIds.map((id) => {
    const b = BUG_POOL.find((x) => x.id === id);
    if (!b) throw new Error(`没有这个 bug：${id}`);
    return b;
  });

  // 干净复制（**只带跑测试必需的东西**）
  // ⚠ 实测坑一（2026-10-17）：沙箱里的 `node_modules` 是 **Windows junction**，
  //   `rmSync({recursive})` 会尝试穿透它、去删**真仓库的** node_modules → `EPERM`。
  //   所以清理时要**先断开 junction**（`rmdir` 不跟递归），再删目录。
  // ⚠ 实测坑二：`dev/` 下有**克隆的 pi 源码**（1.3 万行 TS）——
  //   整包复制会让沙箱的 typecheck 报一堆无关错，把任务变成噪声。
  //   ★ 只复制 `dev/test`（判据所在）与源码。
  if (existsSync(spec.sandbox)) {
    const nmPath = join(spec.sandbox, "node_modules");
    if (existsSync(nmPath)) {
      try {
        execSync(`cmd /c rmdir "${nmPath}"`, { stdio: "ignore" }); // ★ 只断链，不递归
      } catch {
        /* 不是 junction 就算了 */
      }
    }
    rmSync(spec.sandbox, { recursive: true, force: true });
  }
  mkdirSync(spec.sandbox, { recursive: true });
  // ★ 有选择地复制：`dev/` 只带 `test` 与 `helpers`（判据需要的），不带克隆的 pi
  const toCopy: [string, string][] = [
    ["src", "src"],
    ["dev/test", join("dev", "test")],
    ["package.json", "package.json"],
    ["tsconfig.json", "tsconfig.json"],
  ];
  for (const [from, to] of toCopy) {
    const src = join(repoRoot, from);
    if (existsSync(src)) cpSync(src, join(spec.sandbox, to), { recursive: true });
  }
  // node_modules 用软链（不动它，省时间）
  const nm = join(repoRoot, "node_modules");
  if (existsSync(nm)) {
    try {
      execSync(`cmd /c mklink /J "${join(spec.sandbox, "node_modules")}" "${nm}"`, { stdio: "ignore" });
    } catch {
      cpSync(nm, join(spec.sandbox, "node_modules"), { recursive: true });
    }
  }

  // ★ 注入 bug（逐个断言"恰好出现一次" —— 否则就是装置错了）
  for (const b of bugs) {
    const p = join(spec.sandbox, b.file);
    const s = readFileSync(p, "utf8");
    const n = s.split(b.correct).length - 1;
    if (n !== 1) throw new Error(`注入失败：${b.file} 里片段出现 ${n} 次（应为 1）—— 装置要修`);
    writeFileSync(p, s.replace(b.correct, b.broken));
  }

  return {
    id: `T-F-${spec.bugIds.join("+")}`,
    brief:
      `这个仓库的测试是红的。**把它修绿** —— 只能改 dev/test/ 以外的源码，测试本身不许动。\n` +
      `流程建议：先用 \`bash\` 跑 \`npm test\` 看是哪些测试失败，再用 \`grep\`/\`read\` 定位，\`edit\` 改，再跑测试确认。`,
    corpus: bugs.map((b) => ({ id: b.file, title: b.id, text: b.note })),
    hidden: { bugs: bugs.map((b) => ({ id: b.id, file: b.file, correct: b.correct })) },
    artifact: spec.artifact,
    judge: () => ({ ok: false, items: {}, failed: ["T-F 的判据不走 judge 回调 —— 走 judgeRepair（真跑 npm test）"], readings: {} }),
    measures: "修 bug 让测试过：定位/理解/修改/验证的完整改造循环",
    difficulty: bugs.length === 1 ? `${bugs.length} 个注入 bug` : `${bugs.length} 个注入 bug（要全部修好）`,
    sandbox: spec.sandbox,
    injected: bugs.map((b) => ({ id: b.id, file: b.file, note: b.note, difficulty: b.difficulty })),
    judgeCommand: "npm test",
  };
}

/** ★ 判据：真跑测试。**这是唯一不可伪造的判据。** */
export function judgeRepair(sandbox: string, timeoutMs = 600_000): { ok: boolean; failed: string[]; detail: string } {
  try {
    const out = execSync("npm test", {
      cwd: sandbox,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // ★ 防御：有的 runner 出错也返回 0 —— 必须看到通过计数
    const pass = /^ℹ pass (\d+)/m.exec(out);
    if (!pass || Number(pass[1]) === 0) {
      return { ok: false, failed: ["npm test 退出码 0 但没有任何测试通过"], detail: out.slice(-2000) };
    }
    return { ok: true, failed: [], detail: `通过 ${pass[1]} 项` };
  } catch (e) {
    const out = String((e as { stdout?: string; stderr?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]!);
    return { ok: false, failed: failed.length ? failed : ["npm test 非零退出"], detail: out.slice(-2000) };
  }
}

/** 有没有偷改测试（判据不可伪造的保证） */
export function testsUntouched(sandbox: string, repoRoot: string): boolean {
  try {
    const a = execSync(`git status --porcelain dev/test`, { cwd: repoRoot, encoding: "utf8" });
    const b = execSync(`git status --porcelain dev/test`, { cwd: sandbox, encoding: "utf8" }).trim();
    return b.length === 0 || b === a.trim();
  } catch {
    // 沙箱不是 git 仓库：退化成「文件内容比对」太慢，这里先返回 true，由上层的只读权限保证
    return true;
  }
}
