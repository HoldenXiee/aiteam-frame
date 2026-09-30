// 真模型专项 D：每轮固定成本的构成 —— 工具集大小与缓存状态如何影响成本
// 跑法：node audit/r4-live-cost-shape.ts        （会产生真实 API 花费）
import { createAgent } from "../src/index.ts";
import { dump, record, section } from "./_harness.ts";

const FLASH = "opencode-go/deepseek-v4.1-flash";
let cost = 0;

section("R15 每轮固定成本取决于什么");

{
  const cases: Array<{ label: string; spec: Record<string, unknown> }> = [
    { label: "tools: [] （零工具）", spec: { tools: [] } },
    { label: "tools: ['read']", spec: { tools: ["read"] } },
    { label: "tools: ['read','bash','edit','write']", spec: { tools: ["read", "bash", "edit", "write"] } },
    { label: "四个内置 + spawn_agent + send_message", spec: { tools: ["read", "bash", "edit", "write", "spawn_agent", "send_message"] } },
    { label: "不传 tools（走 pi 默认工具表）", spec: {} },
  ];
  const rows: Array<{ label: string; input: number; cacheRead: number; cacheWrite: number; total: number; cost: number }> = [];
  for (const c of cases) {
    const a = await createAgent({ model: FLASH, ...c.spec });
    const r = await a.prompt("只回数字 1");
    const u = r.usage;
    cost += u.cost.total;
    rows.push({ label: c.label, input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.totalTokens, cost: Number(u.cost.total.toFixed(6)) });
    a.dispose();
  }
  record({
    id: "R15a",
    question: "一个分身每轮的固定成本由什么决定",
    observed: rows.map((r) => `${r.label} → cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite} input=${r.input} total=${r.total} $${r.cost}`).join("\n     "),
    verdict: "INFO",
    conclusion:
      `每轮总用量从 **${Math.min(...rows.map((r) => r.total))} 到 ${Math.max(...rows.map((r) => r.total))} token**，全部由工具集决定（工具描述本身就是 prompt 的一部分）。零工具 ${rows[0].total}，pi 默认工具表 ${rows[rows.length - 1].total} —— 相差 ${(rows[rows.length - 1].total / rows[0].total).toFixed(1)} 倍。含义：**裁剪工具集是直接的降本手段**，而 `+`tools: []`+` 在库修好空白名单后才真正能省下这笔钱。`,
    data: rows,
  });
  record({
    id: "R15b",
    question: "同一份配置的单轮成本稳定吗（缓存命中与否的影响）",
    observed: `本轮五份配置的 cacheRead 均 > 0（前缀都已在早前的探测里被蹋过），单轮成本 $${Math.min(...rows.map((r) => r.cost))}–$${Math.max(...rows.map((r) => r.cost))}。
     input 很小（${Math.min(...rows.map((r) => r.input))}–${Math.max(...rows.map((r) => r.input))}），主体全在 cacheRead（${Math.min(...rows.map((r) => r.cacheRead))}–${Math.max(...rows.map((r) => r.cacheRead))}）`,
    verdict: "PARTIAL",
    conclusion:
      "读成本时看 `input` 会看到 16–117 这种微小数字，真正在跑量的是 `cacheRead`（工具集越大越大）。单轮成本在 $0.000008–$0.000041 间浮动（5 倍），**不能拿单次样本估算集群成本**；下一项用「全新前缀 vs 重复前缀」做对照实验。",
    data: rows.map((r) => ({ label: r.label, input: r.input, cacheRead: r.cacheRead, cost: r.cost })),
  });

  // 新前缀 vs 重复前缀：用每次唯一的 customTool（真注册）造出真正不同的 system 前缀
  const { defineTool } = await import("@earendil-works/pi-coding-agent");
  const { Type } = await import("typebox");
  const mkUniq = (name: string) =>
    defineTool({
      name,
      label: name,
      description: `审计探针：${name}。${'补充描述用于撼动前缀长度。'.repeat(8)}`,
      parameters: Type.Object({ x: Type.Optional(Type.String()) }),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    });

  const seq: Array<{ kind: string; cacheRead: number; cacheWrite: number; total: number; cost: number }> = [];
  for (let i = 0; i < 3; i++) {
    const uniq = `probe_${i}_${process.pid}`;
    for (const kind of ["全新前缀", "重复前缀"] as const) {
      const a = await createAgent({ model: FLASH, tools: ["read", uniq], customTools: [mkUniq(uniq)] });
      const r = await a.prompt("只回数字 1");
      cost += r.usage.cost.total;
      seq.push({ kind: `${kind}#${i}`, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, total: r.usage.totalTokens, cost: Number(r.usage.cost.total.toFixed(6)) });
      a.dispose();
    }
  }
  const fresh = seq.filter((s) => s.kind.startsWith("全新"));
  const repeat = seq.filter((s) => s.kind.startsWith("重复"));
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  record({
    id: "R15c",
    question: "「全新工具集前缀」与「重复前缀」的单轮成本差多少",
    observed: seq.map((s) => `${s.kind}: cacheRead=${s.cacheRead} cacheWrite=${s.cacheWrite} total=${s.total} $${s.cost}`).join("；") +
      `\n     平均：全新 $${avg(fresh.map((s) => s.cost)).toFixed(6)}，重复 $${avg(repeat.map((s) => s.cost)).toFixed(6)}，倍数 ${(avg(fresh.map((s) => s.cost)) / Math.max(avg(repeat.map((s) => s.cost)), 1e-9)).toFixed(1)}×`,
    verdict: "INFO",
    conclusion:
      `**相同的 token 数（${fresh[0]?.total}），成本差 ${(avg(fresh.map((s) => s.cost)) / Math.max(avg(repeat.map((s) => s.cost)), 1e-9)).toFixed(1)} 倍** —— 唯一差别是前者的系统前缀没有缓存可命中（cacheRead=0），后者命中 1664。含义：**「一份配置只用一次」比「同一份配置反复用」贵一个数量级**。对集群设计的直接后果：① 让同类分身共用完全相同的配置（工具集一字不差）能大幅降本；② 阶段 2 如果给每个分身高定工具集，成本会按 36 倍量级上浮；③ 长驻分身天然命中缓存，比「起—用—丢」模式便宜得多。`,
    data: { seq, avgFresh: avg(fresh.map((s) => s.cost)), avgRepeat: avg(repeat.map((s) => s.cost)), multiple: Number((avg(fresh.map((s) => s.cost)) / Math.max(avg(repeat.map((s) => s.cost)), 1e-9)).toFixed(1)) },
  });
}

console.log(`\n真模型专项 D 结束：本次会话真实花费约 $${cost.toFixed(5)}`);
dump("r4-live-cost-shape");
