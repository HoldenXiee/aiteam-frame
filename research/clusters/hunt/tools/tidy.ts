// tidy_space —— ★★★★★ 集群整理**自己的空间**（2026-10-27 设计者交办）
//
// ★ 设计者原话：「hunt 集群在工作时不会自己整理文件夹里面的内容吗，一定要
//   **定时把里面废物文件删了**（尤其废弃文档），**留痕都是对上下文的污染**」。
//
// ★★ 为什么这是个工具而不是一句提示：
//   写进提示里它不动（同一规律的第 5 次实证：**做成字段/工具 + 拒收，一轮就动**）。
//   ⇒ 给它一个**能动手的入口**，并且拒收理由原样回它（纪律⑳：拦的同时必须给路）。
//
// ★★★ 护栏（`topology/tidy.ts` 的 `guard` / `referencedIn`，代码执行，不是提示）：
//   · 不许出自己空间（绝对路径 / `..`）
//   · 不许碰 `outbox/` `inbox/` `lib/` `source/` `work/runs/` 账本与日志
//   · **被账本引用过的目录不许清**（`experiments.jsonl` / `PROJECTS.md` / `CONVERGED.md`）
//   · 一次最多 3 个目录（配额：防止一口气把证据全清了）
//   · 不是真 `rm`：移进 `work/_trash/<时间戳>/`，**下一轮 tidy 才真删**（误判可回退）
//
// ★★ 判据（我机械可查）：`work/_tidy.jsonl` 里有 `tidy:moved` 行 ⇒ 它真清了。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyTidy, TIDY } from "../topology/tidy.ts";
import { LAB } from "../paths.ts";
import { logToolCall } from "./usage-log.ts";

export function makeTidySpace(lab: string = LAB) {
  return defineTool({
    name: "tidy_space",
    label: "TidySpace",
    description:
      "清掉**你自己空间里**的废物目录（scratch / 拷进来的 node_modules / 被取代的旧稿 / 大语料副本）。" +
      "★ 移进 `work/_trash/`，下一轮才真删（可回退）。" +
      "★★ 不许碰：`outbox/`（成果）· `inbox/` · `lib/` · 账本与日志 · **被账本引用过的目录**。" +
      `★ 一次最多 ${TIDY.maxPathsPerCall} 个目录。` +
      "★ 为什么该清：垃圾会**进研究员的上下文**（它要读 `work/`），还会拖慢平台期扫描（实测 15.7 万个文件）。",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: "要清的目录（相对你的空间根，如 `work/brief2`）；一次最多 3 个",
      }),
      why: Type.String({ description: "这是什么废物、为什么它不再需要（一句话，会落账）" }),
      kind: Type.Optional(
        Type.String({ description: "类别：scratch / copied-env / superseded / corpus-copy（默认 scratch）" }),
      ),
    }),
    execute: async (_id, p) => {
      const req = p as { paths: string[]; why: string; kind?: string };
      logToolCall("tidy_space", `${(req.paths ?? []).join(",")} ${req.why ?? ""}`);
      const res = applyTidy(lab, req);
      const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
      const lines: string[] = [];
      if (res.moved.length) {
        lines.push(`✔ 清掉 ${res.moved.length} 个目录（${res.moved.reduce((a, m) => a + m.files, 0)} 文件 / ${mb(res.moved.reduce((a, m) => a + m.bytes, 0))}）`);
        for (const m of res.moved) lines.push(`  · ${m.rel} — ${m.files} 文件 / ${mb(m.bytes)}`);
        lines.push("  它们在 `work/_trash/` 里，**两小时后真删**；要找回就在这一轮内说。");
      }
      for (const r of res.refused) lines.push(`⛔ 拒收 ${r.rel}：${r.reason}`);
      if (res.purged.length) lines.push(`· 顺带真删了 ${res.purged.length} 个过期批次（留痕已消失）`);
      if (!res.moved.length && !res.refused.length) lines.push("（什么都没做）");
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}
