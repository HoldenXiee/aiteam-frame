// S4b：变换类钩子（context）挂两个 handler 时，谁的结果生效？第二个能不能看到第一个的输出？
// 直接决定 permissions.gate 与用户的 on("context") 会不会互相踩。
import { check, head, rig } from "./_pi.ts";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

head("S4b 变换类钩子的合并");

let seenBySecond = -1;
const ext: InlineExtension = (pi) => {
  pi.on("context", (event) => {
    const n = (event.messages as any[]).length;
    console.log(`   handler1 看到 ${n} 条，裁到 1 条`);
    return { messages: (event.messages as any[]).slice(0, 1) };
  });
  pi.on("context", (event) => {
    seenBySecond = (event.messages as any[]).length;
    console.log(`   handler2 看到 ${seenBySecond} 条，不返回（不干预）`);
    return undefined;
  });
};

const r = await rig([ext]);
try {
  await r.session.prompt("one");
  await r.session.prompt("two");
  const count = r.lastCall()!.messageCount;
  console.log(`   最终 provider 收到 ${count} 条（system 另算）`);
  check("handler1 裁剪生效了（发给模型的变少）", count <= 3, `count=${count}`);
  check("handler2 **仍然被调用**（不短路，除非返回 block）", seenBySecond >= 0, `seenBySecond=${seenBySecond}`);
  check(
    "handler2 看到的是 handler1 之后的消息（链式传递）",
    seenBySecond === 1,
    seenBySecond === 1 ? "链式：看到了裁后的 1 条" : `看到了 ${seenBySecond} 条（若是 3+ 则是原始消息，不链式）`,
  );
} finally {
  await r.close();
}