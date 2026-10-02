// S2：context 钩子改的是「这一轮发给模型的」还是「会写进历史的」？
// 规格 §4 的 context.override 语义全靠这条。
import { check, head, rig } from "./_pi.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

head("S2 context 钩子语义");

type Mode = "off" | "cut" | "mutate" | "replace";
let mode: Mode = "off";
let seenInHook: number[] = [];

const hook: InlineExtension = (pi) => {
  pi.on("context", (event) => {
    const messages = event.messages as any[];
    seenInHook.push(messages.length);
    if (mode === "cut") return { messages: messages.slice(-1) };
    if (mode === "replace") return { messages: messages.slice(0, 1) };
    if (mode === "mutate") {
      messages.pop(); // 原地改：如果这就是 session.messages，历史会被污染
      return undefined;
    }
    return undefined;
  });
};

const r = await rig([hook]);
try {
  await r.session.prompt("one");
  const base = r.lastCall()!.messageCount;
  await r.session.prompt("two");
  const growth = r.lastCall()!.messageCount;
  const h1 = r.session.messages.length;
  check("基线：每轮历史在增长", growth > base, `${base} → ${growth}`);

  // ── 返回 {messages} 裁剪 ──
  mode = "cut";
  await r.session.prompt("three");
  const cutCount = r.lastCall()!.messageCount;
  const h2 = r.session.messages.length;
  check("返回 {messages: slice(-1)} 生效：发给模型的条数变少", cutCount < growth, `growth=${growth} → cut=${cutCount}`);
  check("历史**没被破坏**：session.messages 仍在正常增长", h2 > h1, `history ${h1} → ${h2}`);

  // ── 关掉钩子，看是否恢复 ──
  mode = "off";
  await r.session.prompt("four");
  const back = r.lastCall()!.messageCount;
  check("下一轮恢复完整历史（说明是**每轮生效**，不是一次性改写）", back > cutCount, `cut=${cutCount} → back=${back}`);

  // ── 原地 pop：会不会污染历史 ──
  const beforeMutate = r.session.messages.length;
  mode = "mutate";
  await r.session.prompt("five");
  const afterMutate = r.session.messages.length;
  const mutated = r.lastCall()!.messageCount;
  console.log(`  原地 pop：provider 收到 ${mutated} 条；session.messages ${beforeMutate} → ${afterMutate}`);
  check(
    "原地改 event.messages **不会**污染 session.messages",
    afterMutate > beforeMutate,
    afterMutate <= beforeMutate ? "历史被吃掉了一条（会污染！）" : "历史照常增长",
  );

  mode = "off";
  await r.session.prompt("six");
  check("污染测试后历史仍可继续增长", r.session.messages.length > afterMutate, `${afterMutate} → ${r.session.messages.length}`);

  console.log(`\n  钩子里看到的 messages 长度序列：${seenInHook.join(",")}（与 provider count 相差 system 那条）`);
} finally {
  await r.close();
}