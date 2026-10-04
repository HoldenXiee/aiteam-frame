// demo 环境自带的扩展：只在这个 agentDir 里，因此能证明「环境自动发现」这条路是通的。
// 它注册的工具名**不会**被并入 `permissions.only` 白名单（R41）—— 所以只在没写 only 的
// agent 上可见。demo 里的写作员正是没写 only 的那个，它用这个工具给报告加一份「交付清单」。
//
// 类型注解不是装饰：这个文件在 tsconfig 的 include 范围内（demo/），无注解的 (pi) 在 strict 下编译不过。
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "env_checklist",
      label: "Env Checklist",
      description: "给报告追加一份交付清单（由环境扩展提供，不在 spec 里声明）。参数 items 是要列出的条目。",
      parameters: Type.Object({ items: Type.Array(Type.String()) }),
      execute: async (_id, p) => ({
        content: [
          {
            type: "text",
            text: [
              "交付清单：",
              ...p.items.map((x, i) => `  ${i + 1}. ${x}`),
              "（这一份由环境扩展 env-tools.ts 提供 —— 它不在 spec 的 extensions 里）",
            ].join("\n"),
          },
        ],
        details: {},
      }),
    }),
  );
}
