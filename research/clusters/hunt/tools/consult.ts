// consult —— ★ agent 触发：研究员**主动**请一位专家
//
// ★★★ 为什么是「角色 + 处境 + 地盘」而不是「role + question」：
//   问一句话**达不到干净上下文的效果**（设计者指出）。
//   ★ 专家的力量来自**它自己去读** —— 所以 tool 只传"为什么叫你来 + 要你看什么"，
//     真正的材料由专家**自己**去 `outbox/` `work/` 里读。

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 能通过 consult 请的专家（★ 不含 libsmith —— 改库由拓扑触发，不是它随手能叫的） */
const CONSULTABLE = ["inspector", "archivist", "inspirer", "watchdog"] as const;
type Consultable = (typeof CONSULTABLE)[number];

export function makeConsult(fire: (role: Consultable, why: string, focus?: string) => Promise<string>) {
  return defineTool({
    name: "consult",
    label: "Consult",
    description:
      "请一位专家来帮你。★ 它的上下文是**干净的**（看不到你的推导过程），它会**自己去读**你指定的地盘。" +
      "你要写清：为什么叫它来、要它看什么。它的结论会作为工具结果回到你这里。",
    parameters: Type.Object({
      role: Type.Union(
        CONSULTABLE.map((r) => Type.Literal(r)),
        { description: "请谁：inspector(审查+鼓励) / archivist(重审目标) / inspirer(跨学科) / watchdog(看有没有转圈)" },
      ),
      why: Type.String({ description: "为什么叫它来 —— 你的处境、你卡在哪、你想知道什么" }),
      focus: Type.Optional(Type.String({ description: "要它特别看什么（路径 / 具体问题）" })),
    }),
    execute: async (_id, p) => {
      const text = await fire(p.role as Consultable, `[研究员主动求助] ${p.why}`, p.focus ?? "");
      // ★★ execute 的返回值**自动进它的上下文** —— 这就是"意见回流"
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
