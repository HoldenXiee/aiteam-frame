/**
 * ★★★★★ 集群自己的库测试：**有没有红灯**
 *
 * ★ 为什么需要这个东西（2026-10-26 实测）：
 *   `research/labfirst/hunt/lib` 与 `src` 已漂 **57 处**（改过 13 · 新增 44 个文件），
 *   其中 `acceptance.test.ts` 是**集群自己写的**测试 —— 而**没有任何东西在跑它**。
 *   我随手一跑：`A13d 函数谓词的正文可读` **FAIL**。
 *
 * ★★ 意义（纪律⑧ 装置失败 ≠ 能力失败）：
 *   装置的测试红着，在这套装置上跑出来的读数**不能算它的能力**。
 *   所以这个红灯必须**出现在读数里**，不能等我想起来才跑。
 *
 * ★★★ 它只**报**，不修：修那是集群的活（失败的是它自己写的断言）。
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// ★ Windows 上 `spawn npx` 会 ENOENT（npx 是 .cmd）⇒ 用 node + tsx 的入口，别靠 shell
const NPX = "npx";

/** 找一个目录下所有 `*.test.ts`（深度封顶，跳过 node_modules）*/
export function findTests(dir: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6 || !existsSync(dir)) return acc;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const f of entries) {
    if (f === "node_modules" || f === ".git") continue;
    const p = join(dir, f);
    try {
      if (readdirSync(p).length >= 0) findTests(p, depth + 1, acc);
    } catch {
      if (f.endsWith(".test.ts")) acc.push(p);
    }
  }
  return acc;
}

export interface LibTestResult {
  files: number;
  pass: number;
  fail: number;
  /** 失败的那几条（名字 + 期望/实际）*/
  failed: string[];
  /** 跑不起来（编译错 / import 错）*/
  broken: string[];
}

export async function runLibTests(lab: string, timeoutMs = 300_000): Promise<LibTestResult> {
  const files = findTests(join(lab, "lib"));
  if (files.length === 0) return { files: 0, pass: 0, fail: 0, failed: [], broken: [] };

  const failed: string[] = [];
  const broken: string[] = [];
  let pass = 0;
  let fail = 0;
  for (const f of files) {
    const name = f.split(/[\/]/).pop()!;
    // ★ Windows：`spawn npx` 直接 ENOENT/EINVAL（npx 是 .cmd）⇒ 必须过 shell
    // ★★ 测试失败会让进程**非零退出** ⇒ 那不是"崩了"，stdout 里才是真读数
    let out = "";
    try {
      const r = await run(`${NPX} tsx --test "${f}"`, [], {
        shell: true,
        timeout: timeoutMs,
        maxBuffer: 8 << 20,
        encoding: "utf8",
      } as never);
      out = String((r as unknown as { stdout?: string }).stdout ?? "");
    } catch (e) {
      const eo = String((e as { stdout?: unknown }).stdout ?? "");
      if (eo) {
        out = eo;
      } else {
        broken.push(`${name} · ${(e as Error).message.split(String.fromCharCode(10))[0]?.slice(0, 80)}`);
        continue;
      }
    }
    const m = /^ℹ pass (\d+)$/m.exec(out);
    const mf = /^ℹ fail (\d+)$/m.exec(out);
    pass += Number(m?.[1] ?? 0);
    fail += Number(mf?.[1] ?? 0);
    for (const line of out.split(/\r?\n/)) if (/^FAIL /.test(line)) failed.push(`${name} · ${line.slice(0, 95)}`);
    if (Number(mf?.[1] ?? 0) > 0 && !failed.some((x) => x.startsWith(name))) {
      failed.push(`${name} · （有 fail 但没打出 FAIL 行）`);
    }
  }
  return { files: files.length, pass, fail, failed, broken };
}

export function renderLibTests(r: LibTestResult): string {
  if (r.files === 0) return "★ 集群的 lib 里没有测试（它没给自己造量具）";
  const head =
    r.fail === 0 && r.broken.length === 0
      ? `✔ 集群自己的库测试：${r.files} 个文件 · pass ${r.pass}`
      : `🔴 **集群自己的库测试有红灯**：${r.files} 个文件 · pass ${r.pass} · **fail ${r.fail}**` +
        (r.broken.length ? ` · 跑不起来 ${r.broken.length}` : "");
  const detail = [
    ...r.failed.slice(0, 3).map((x) => `　　✖ ${x}`),
    ...r.broken.slice(0, 2).map((x) => `　　✖（崩）${x}`),
  ];
  return [head, ...detail].join("\n") + (r.fail > 0 ? `\n　　★ 装置红着 ⇒ **它在这套装置上跑出的读数不能算它的能力**（纪律⑧）` : "");
}

if (process.argv[1]?.includes("libtest")) {
  const lab = process.argv[2] ?? "research/labfirst/hunt";
  const r = await runLibTests(lab);
  console.log(renderLibTests(r));
}
