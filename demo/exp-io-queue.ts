// 实验：io 面 · queue 一次（真模型：opencode-go/space-bunny-free）
//
// 只验一件事：queue 在**忙**的时刻投递时，是并进当前这一次运行（不谎报另起一轮），
// 结算区间里能看见它 —— 且 queue 永不因忙抛错。
//
// 跑法：node demo/exp-io-queue.ts
import { createLab } from "../src/index.ts";
import { ensureEnv } from "./env.ts";

const env = await ensureEnv();
const lab = await createLab({ agentDir: env.agentDir, cwd: env.cwd });
const a = await lab.createAgent({ id: "排队实验", model: env.model });
console.log(`[0] 环境=${env.agentDir} model=${a.model.current?.id}`);

const 事件: string[] = [];
a.onAny((e) => {
  if (e.type === "agent_start" || e.type === "agent_settled") 事件.push(`${e.type}(runId=${(e as any).runId ?? "-"})`);
});

// 1) 先起一轮「正忙」的运行：**不 await** —— 这正是 queue 存在的场景。
//    真模型的这一轮本来就要几百毫秒到几秒，不需要假服务「拖时间」那套指令。
const flying = a.io.prompt("第一问：用一句话说明这个库的 io 面能做什么。");
console.log(`[1] prompt 已投出（不等它）  isRunning=${a.io.isRunning}`);

// 2) 忙时 queue：永不抛错，并进当前这次运行。
const r = await a.io.queue("第二问：跟着第一问一起答。");
console.log(`[2] io.queue → ${JSON.stringify(r)}  isRunning=${a.io.isRunning} pending=${a.io.pending}`);

// 3) 对照：prompt 在忙时**抛错**（一次交办不该被静默丢掉）
try {
  await a.io.prompt("这一句应该被拒绝");
  console.log("[3] ⚠️ prompt 竟然没抛错（与判据不符）");
} catch (err) {
  console.log(`[3] 同一时刻 prompt 抛错：${(err as Error).message}`);
}

const first = await flying;
console.log(`[4] 第一轮结算 runId=${first.runId} text=${JSON.stringify(first.text)}`);
await a.io.waitIdle();
console.log(`[5] waitIdle 后 isRunning=${a.io.isRunning}`);

console.log(`\n[6] 事件序列：${事件.join(" → ")}`);
console.log(`[6] 结算区间 messages 数=${first.messages.length}，最后一条 user=${JSON.stringify(
  (first.messages.filter((m) => m.role === "user").at(-1) as any)?.content?.slice?.(-20) ?? "",
)}`);
console.log(`[6] history 全量：${a.context.history.length} 条`);
a.dispose();