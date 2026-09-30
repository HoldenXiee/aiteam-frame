import { createAgent, createAgentHost } from "../src/index.ts";
import { startFaux } from "../test/faux-server.ts";
import { makeFauxRuntime, FAUX_MODEL_REF } from "../test/faux-models.ts";

const faux = await startFaux();
const made = await makeFauxRuntime(faux.baseUrl);
const spec = { model: FAUX_MODEL_REF, cwd: made.cwd, agentDir: made.agentDir };
// 注意：parent 属于 deps，不属于 spec
const mk = (host: any, deps: any = {}) => createAgent(spec, { host, modelRuntime: made.runtime, ...deps });

console.log("═══ ① 跨宿主挂父（parent 正确放进 deps）═══");
{
  const hostA = createAgentHost({ members: { w: {} }, maxAgents: 8 });
  const hostB = createAgentHost({ members: { w: {} }, maxAgents: 8 });
  const alien = await mk(hostA, { member: "w" });
  const child = await mk(hostB, { member: "w", parent: alien });
  console.log(`  alien.id=${alien.id} 属于 hostA；child.id=${child.id} 属于 hostB`);
  console.log(`  child.parentId = ${child.parentId}`);
  console.log(`  hostB.get(child.parentId) = ${hostB.get(String(child.parentId)) ? "找到" : "undefined（父不在本宿主）"}`);
  console.log(`  → 跨宿主挂父${child.parentId === alien.id ? "**被接受，无人校验**" : "被拒绝"}`);
  hostA.dispose(); hostB.dispose();
}

console.log("\n═══ ② parentId 强改造环（已确认）═══");
{
  const host = createAgentHost({ members: { w: {} }, maxDepth: 10, maxAgents: 32 });
  const top = await mk(host);
  const kid = await mk(host, { parent: top });
  (top as any).parentId = kid.id;
  console.log(`  强改 top.parentId → ${top.parentId}（无报错）`);
  let problem: string | undefined;
  try { await mk(host, { parent: kid }); } catch (e) { problem = (e as Error).message; }
  console.log(`  环上再建一层：${problem ? `被拒「${problem}」` : "**建成，护栏没拦住**"}`);
  host.dispose();
}

console.log("\n═══ ③ depthOf 的代价：建 n 层深链（maxAgents 放宽）═══");
{
  for (const n of [64, 128, 256, 512]) {
    const host = createAgentHost({ members: { w: {} }, maxDepth: n + 5, maxAgents: n + 10 });
    const t0 = Date.now();
    let parent: any = undefined;
    for (let i = 0; i < n; i++) parent = await mk(host, { parent });
    const ms = Date.now() - t0;
    console.log(`  n=${String(n).padStart(3)}  总耗时 ${String(ms).padStart(5)}ms  每层 ${(ms / n).toFixed(3)}ms`);
    host.dispose();
  }
}
await faux.close();
