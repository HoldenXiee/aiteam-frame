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
 */
// @ts-expect-error 包在 agentDir 的 npm/ 下，不在本仓库的类型图里
export { default } from "../npm/node_modules/pi-web-access/index.ts";
