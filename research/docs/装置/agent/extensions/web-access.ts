/**
 * hunt 的外部材料通道 —— 把 `pi-web-access` 的全部能力装进这个环境。
 *
 * ★ 设计裁定（2026-10-21）：hunt 是"灵感无限、天马行空的实验员"，
 *   它必须能自由看外面的世界（网上 / 论坛 / 前沿 / 论文 / 仓库）。
 *
 * ★★ 为什么不改库：`pi-web-access` 的默认导出本来就是 pi 扩展工厂
 *   （`export default (pi: ExtensionAPI) => …`），而本库的 `extensions/` 是一等公民。
 *
 * ★★★ 为什么不靠 `settings.json` 的 `packages`：本库用**内存 settings**
 *   （实测警告：「本实验室用内存 settings…这些文件不会生效」），且库里
 *   **完全不认 `packages` 字段** ⇒ 装包不会被加载，只有扩展会被加载。
 *
 * ★ 路径：包装在 `../npm/node_modules/`（由 `pi install npm:pi-web-access` 生成，
 *   已 gitignore）。这里用相对路径引，因为扩展文件的模块解析起点是 `extensions/`。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★★★★ 2026-10-26 · **加一层使用账**（否则"搜了多少次"永远量不到）
 *
 * ★ 起因：评估"能不能大量从网上取灵感"时，我能说"多少灵感进了账"（40/91 实验引了真外部），
 *   但**不能说"它搜了多少次"** —— 我的工具使用账只记我自己造的 5 个工具，
 *   而这 4 个（`web_search` / `fetch_content` / `get_search_content` / `source_check`）
 *   是 pi-web-access 的，**没有日志**（纪律㉔：量具记的字段必须能回答想问的问题）。
 * ★★ 做法：不改包，**在这层包一个 `tool_call` 钩子**，把它们每次调用记一行
 *   `tool:<名字>` 到集群空间的 `work/_topology.log` —— 与自定义工具同一本账，
 *   读数脚本一次读全（`toolUsageFromLog`）。
 * ★★★ 只**记**、不拦、不改参数：`tool_call` 里返回 `undefined` 就是不干预。
 *   写日志失败也绝不 block（记不上账不许影响功能）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error 包在 agentDir 的 npm/ 下，不在本仓库的类型图里
import realExtension from "../npm/node_modules/pi-web-access/index.ts";

/** ★ 哪几个工具要记（= DESIGN §3 通道③ 的四个工具）*/
const WEB_TOOLS = new Set(["web_search", "fetch_content", "get_search_content", "source_check"]);

/**
 * 记到哪：集群空间由 `HUNT_LAB` 决定（与 `paths.ts` 同源）。
 * ★ 这里**不 import paths.ts**：扩展的模块图与集群是两套，跨图 import 会让扩展加载失败。
 */
function logPath(): string {
  const lab = process.env.HUNT_LAB || "research/labfirst/hunt";
  return join(lab, "work", "_topology.log");
}

function logTool(name: string): void {
  try {
    const p = logPath();
    mkdirSync(join(p, ".."), { recursive: true });
    appendFileSync(p, `${new Date().toISOString()}  tool:${name}\n`, "utf8");
  } catch {
    // ★ 静默：使用账是观测，不是功能
  }
}

export default function webAccessWithUsage(...args: unknown[]): unknown {
  const pi = args[0] as {
    on?: (ev: string, fn: (e: { toolName?: string }) => Promise<undefined>) => void;
  };
  // ① 先装真正的能力（参数可能不止 pi，原样透传）
  const out = (realExtension as unknown as (...a: unknown[]) => unknown)(...args);
  // ② 再挂使用账
  try {
    pi.on?.("tool_call", async (event) => {
      const name = event?.toolName ?? "";
      if (WEB_TOOLS.has(name)) logTool(name);
      return undefined; // ★ 不拦、不改
    });
  } catch {
    // 挂不上也不影响能力本身
  }
  return out;
}
