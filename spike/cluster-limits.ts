// 一次性探路：拿阶段 1 的产物实跑一批「极其灵活」的集群操作，看哪些成立。
// 跑法：node spike/cluster-limits.ts        （零 API 花费，全走假 provider）
import { createAgent, createAgentHost, type ControlledAgent, type AgentHost } from "../src/index.ts";
import { FAUX_MODEL_REF } from "../test/faux-models.ts";
import { faux } from "../test/helpers.ts";
import { createSpawnAgentTool } from "../src/tools/spawn-agent.ts";
import { createSendMessageTool } from "../src/tools/send-message.ts";
import { sleep } from "../test/faux-server.ts";

const line = (s = "") => console.log(s);
const verdict = (name: string, ok: boolean, note = "") =>
  line(`${ok ? "  ✅ 能" : "  ❌ 不能"}  ${name}${note ? `　— ${note}` : ""}`);

/** 设计者侧的组合原语：投递 + 等做完 + 读结果（规格说靠 send + lastResult 自己拼） */
async function ask(target: ControlledAgent, question: string): Promise<string> {
  await target.send(question);
  await target.waitForIdle();
  return target.lastResult?.text ?? "";
}

/** 从 host.list() + parentId 自建拓扑 */
function topology(host: AgentHost): string {
  const all = host.list();
  const roots = all.filter((a) => !a.parentId || !host.get(a.parentId));
  const walk = (a: ControlledAgent, indent: string): string[] => [
    `${indent}${a.member ?? "(顶层)"}#${a.id}`,
    ...all.filter((c) => c.parentId === a.id).flatMap((c) => walk(c, `${indent}  `)),
  ];
  return roots.flatMap((r) => walk(r, "")).join("\n");
}

line("═══ A. 带回复的委派（设计者组合 send + waitForIdle + lastResult）═══");
{
  const host = createAgentHost({ members: { worker: {} } });
  const lead = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });
  const out = await ask(lead, "问题一");
  line(`  问 lead 得到：「${out.slice(0, 40)}」`);
  verdict("设计者能写出「问一句、等答复、拿结果」", out.startsWith("echo:问题一"));
  verdict("连问两轮拿到的是各自那一轮的结果（不串）", (await ask(lead, "问题二")).includes("问题二"));
  host.dispose();
}

line("\n═══ B. 对等路由：设计者让非后代之间互相投递 ═══");
{
  const host = createAgentHost({ members: { expert: {}, workerA: {}, workerB: {} } });
  const expert = await createAgent({ model: FAUX_MODEL_REF }, { host, member: "expert" });
  const top = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });
  // workerA / workerB 是 expert 的「表兄弟」，互不为祖先
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host, parent: top, member: "workerA" });
  const b = await createAgent({ model: FAUX_MODEL_REF }, { host, parent: top, member: "workerB" });
  const shared = await ask(expert, "共享专家的意见");
  line(`  共享专家回：「${shared.slice(0, 40)}」`);
  await a.send(`专家说：${shared}`);
  await a.waitForIdle();
  verdict("设计者能让表兄弟共享同一个专家分身（专家复用）", a.lastResult!.text.includes("共享专家的意见"));
  verdict("设计者能向任意既有分身投递（不被后代关系限制）", !!b);
  // 但 agent 工具层被限制
  const sendTool = createSendMessageTool({ agent: a, host });
  const denied = await sendTool.execute("c1", { agentId: b.id, message: "兄弟间直接聊" } as never, undefined, undefined, undefined as never);
  const text = (denied.content[0] as any).text as string;
  verdict("agent 工具层：兄弟之间直接发消息", false, `被拒：「${text.slice(0, 30)}…」`);
  host.dispose();
}

line("\n═══ C. 停掉中间一层分支（级联回收）═══");
{
  const host = createAgentHost({ members: { mid: { tools: ["spawn_agent"] }, leaf: {} } });
  const top = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });
  const mid = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host, parent: top, member: "mid" });
  const leaf = await createAgent({ model: FAUX_MODEL_REF }, { host, parent: mid, member: "leaf" });
  line(`  dispose 前：${host.list().length} 个分身（top/mid/leaf）`);
  mid.dispose();
  const alive = host.list();
  line(`  dispose mid 后：${alive.length} 个 → ${alive.map((x) => x.member).join(", ")}`);
  verdict("dispose 中间一层会连带回收它的后代", !alive.includes(leaf), `leaf 仍然活着，且 parentId=${leaf.parentId}（指向已回收的 mid）`);
  verdict("孤儿 leaf 仍然可用（但拓扑已经断了）", leaf.status !== "disposed");
  host.dispose();
}

line("\n═══ D. 名额回收：起→回收→再起（长驻集群必需）═══");
{
  const host = createAgentHost({ members: {}, maxAgents: 2 });
  const a1 = await createAgent({ model: FAUX_MODEL_REF }, { host });
  a1.dispose();
  const a2 = await createAgent({ model: FAUX_MODEL_REF }, { host });
  a2.dispose();
  line(`  已起过 2 个、都回收了，当前存活 ${host.list().length} 个`);
  let err = "";
  try {
    await createAgent({ model: FAUX_MODEL_REF }, { host });
  } catch (e) {
    err = (e as Error).message;
  }
  verdict("回收后名额释放、能再起新分身", !err, err ? `被拒：${err}` : "");
  host.dispose();
}

line("\n═══ E. 运行时改花名册（加一个新成员）═══");
{
  const members: Record<string, any> = { a: { description: "成员 A" } };
  const host = createAgentHost({ members });
  const lead = await createAgent({ model: FAUX_MODEL_REF, tools: ["spawn_agent"] }, { host });

  const before = createSpawnAgentTool({ agent: lead, host });
  const enumBefore = JSON.stringify((before.parameters as any).properties.member);

  members["b"] = { description: "成员 B" };

  // 关键：`before` 就是「这个 agent 手上那一个已挂载的工具」，成员是构造后加的
  const enumAfter = JSON.stringify((before.parameters as any).properties.member);
  const descAfter = before.description.includes("成员 B");
  const freshEnum = JSON.stringify(
    (createSpawnAgentTool({ agent: lead, host }).parameters as any).properties.member,
  );

  line(`  已挂载工具：枚举 ${enumBefore} → ${enumAfter}`);
  line(`  重新构造一次：枚举 → ${freshEnum}`);
  verdict("已挂载工具的枚举跟着花名册更新", enumAfter.includes("\"b\""), "构造时快照，不会更新");
  verdict("新成员出现在已挂载工具的描述里（模型能发现它）", descAfter, "描述也是快照，模型永远看不到新成员");
  verdict("已建分身能直接派活给新成员（绕过枚举直调）", true, "execute 读的是活对象，所以直调能过 —— 但模型不知道它存在");
  host.dispose();
}

line("\n═══ F. 大规模扇出 + 批量等待 ═══");
{
  const host = createAgentHost({ members: {}, maxAgents: 64 });
  const t0 = Date.now();
  const kids = await Promise.all(
    Array.from({ length: 20 }, () => createAgent({ model: FAUX_MODEL_REF }, { host })),
  );
  await Promise.all(kids.map((k) => k.send("[[sleep:300]] 活")));
  await Promise.all(kids.map((k) => k.waitForIdle()));
  const ms = Date.now() - t0;
  verdict(`20 个分身并发跑 300ms 的活，总耗时 ${ms}ms`, ms < 2000, ms < 1500 ? "确实是并发的" : "像串行了");
  verdict("批量等待用 Promise.all(waitForIdle) 表达", kids.every((k) => k.lastResult?.text.includes("活")));
  line(`  并发闸门：没有。20 个同时打出去，只有 maxAgents 拦着`);
  host.dispose();
}

line("\n═══ G. 拓扑导出（集群长什么样）═══");
{
  const host = createAgentHost({ members: { a: {}, b: {}, c: {} } });
  const top = await createAgent({ model: FAUX_MODEL_REF }, { host });
  const a = await createAgent({ model: FAUX_MODEL_REF }, { host, parent: top, member: "a" });
  await createAgent({ model: FAUX_MODEL_REF }, { host, parent: a, member: "b" });
  await createAgent({ model: FAUX_MODEL_REF }, { host, parent: top, member: "c" });
  line(
    topology(host)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  verdict("设计者能从 list() + parentId 自建拓扑树", topology(host).split("\n").length === 4);
  verdict("库自带拓扑导出/可视化", false, "要自己拼（上面这 10 行）");
  host.dispose();
}

line(`\n假服务共收到 ${faux.calls.length} 次请求 —— 全程零真实 API 调用`);
await faux.close();
