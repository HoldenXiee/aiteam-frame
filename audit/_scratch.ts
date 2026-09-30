// 临时探针 4：abort（已流出部分文本）的原始事件序列。用完即删。
import { makeEnv } from "./_faux.ts";
import { createAgent, createAgentHost } from "../src/index.ts";

const env = await makeEnv();
const defaults = { model: env.model, agentDir: env.agentDir, cwd: env.cwd };
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

const host = createAgentHost({ defaults, maxAgents: 100, modelRuntime: env.runtime });
const a = await createAgent({ ...defaults }, { host, modelRuntime: env.runtime });
const raw: any[] = [];
(a.session as any).subscribe((e: any) => raw.push(e));
let first = (_: string) => {};
const got = new Promise<string>((r) => (first = r));
a.on("text", (p) => first(p.delta));
const before = env.calls().length;
const p = a.prompt("[[huge:400000]] 长任务");
await Promise.race([got, sleep(4000)]);
await sleep(30);
await a.abort();
const out = await p;
console.log("calls:", env.calls().length - before);
console.log("raw seq:", raw.map((e) => e.type + (e.type === "turn_end" ? `(${e.message.stopReason},${e.message.content.map((c: any) => c.type).join("+")},${e.message.usage?.totalTokens})` : "")).join(" | ").slice(0, 1200));
console.log("run:", JSON.stringify({ textLen: out.text.length, tokens: out.usage.totalTokens, error: out.error }));
console.log("status:", a.status, "usage:", a.usage.totalTokens);
host.dispose();
await env.close();
