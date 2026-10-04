// 实验：io 面 · interrupt 一次（真模型：opencode-go/space-bunny-free）
//
// 只验一件事：interrupt 在**忙**的时刻 = abort 掉在飞那轮 + 立即投递这句，并拿到新那轮的 RunResult；
// 它永不因忙抛错（这是它与 prompt 的本质区别），而且**不吞掉**已排队的 queue 消息。
//
// 跑法：node demo/exp-io-interrupt.ts
import { createLab } from "../src/index.ts";
import { ensureEnv } from "./env.ts";

const env = await ensureEnv();
const lab = await createLab({ agentDir: env.agentDir, cwd: env.cwd });
const a = await lab.createAgent({ id: "打断实验", model: env.model });
console.log(`[0] 环境=${env.agentDir} model=${a.model.current?.id}`);

const 事件: string[] = [];
a.onAny((e) => { if (e.type === "agent_start" || e.type === "agent_settled") 事件.push(e.type); });

// 1) 在飞那轮：随即被 3) 的 interrupt abort 掉。不等它。
const flying = a.io.prompt("这一轮会被下一句 interrupt 砍掉。请详细回答一个需要较长时间的问题：逐条说明 io 面的五个成员。").catch((e) => ({ 被拒: String(e) }));
console.log(`[1] prompt 已投出  isRunning=${a.io.isRunning}  status=${a.status}`);

// 2) 顺手排一句 queue —— 用来验「interrupt 不吞掉已排队的消息」
await a.io.queue("排队的那句");

// 3) 中断并立即投递。interrupt 会把 1) 那轮 abort 掉。
const t0 = Date.now();
const r = await a.io.interrupt("换成这句：用一句话回答即可。");
console.log(`[2] io.interrupt → runId=${r.runId} text=${JSON.stringify(r.text)}  耗时=${Date.now() - t0}ms（没等满被砍那轮）`);
console.log(`[3] status=${a.status}  isRunning=${a.io.isRunning}`);

// 4) 排队的消息在这一轮里被投递了吗？
const users = r.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content)).join(" | ");
console.log(`[4] 这一轮结算区间里的 user：${users}`);

// 5) 被砍掉的那轮以 abort 结算 —— 它的 promise 会 reject（调用方该 catch）
const 被砍 = await flying;
console.log(`[5] 被中断那轮：${JSON.stringify(被砍)}`);

// 6) 中断之后可以正常继续
const next = await a.io.prompt("下一句");
console.log(`[6] 中断后继续：${JSON.stringify(next.text)}  status=${a.status}`);

console.log(`\n[7] 事件序列：${事件.join(" → ")}`);
console.log(`[7] 累计 tokens=${a.usage.totalTokens}  history=${a.context.history.length} 条`);
a.dispose();