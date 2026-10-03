// 优质代码片段：**GUIDE.md 的唯一真源**。
//
// 每个面一小段「正确用法」，两件事同时成立：
//   1. 它们是**真函数**，会被 `tsc` 检查 —— 库的 API 一变，这里立刻编译不过；
//   2. `snippets` 的值是这些函数**自己的源码**（`fn.toString()`），不是手抄的字符串。
//      改函数体 ⇒ 字符串跟着变。手抄两份等于把「文档漂移」换个地方发生，那样本文件就白做了。
//
// 注释讲的是「为什么这样写」，不是「这行做了什么」——复述代码的注释不增加信息量。
// 这里**不导出**任何库没提供的东西：它是「正确用法的浓缩」，不是工具库。
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Agent, ThinkingLevel } from "../../src/index.ts";

// ─────────────── io：驱动与结算 ───────────────

/** 起一个 agent 之后，用 prompt 交办一件事并拿到结果。 */
export async function ioPrompt(agent: Agent): Promise<string> {
  // prompt 在 agent_settled 之后才 resolve —— 所以 `result.messages` 恰好是**本次运行**的区间，
  // 重叠投递也不会串台（不像「排干共享消息池再取最后一条」）。
  const result = await agent.io.prompt("用一句话说明你能做什么");
  // 失败分两种：接受之前失败会 reject（由调用方接住）；**接受之后**失败不 reject、只写进 result.error。
  // 所以 error 必须显式看：光读 text 会把一轮失败读成「空回复」。
  if (result.error) throw new Error(`这一轮失败了：${result.error}`);
  return result.text;
}

/** 目标可能正忙时，用 queue 投递 —— 它永不因忙而抛错。 */
export async function ioQueue(agent: Agent): Promise<void> {
  // prompt 撞上「正忙」会抛错，这是刻意的：一次交办不该被静默丢掉。
  // queue 的语义是「排进去」：忙则并进当前这轮，闲则起一轮但**不 await**。
  // 代价是拿不到 RunResult，结果只能从事件里看 —— 所以紧接着 waitIdle 是最常见的写法。
  await agent.io.queue("补充一句：先说结论");
  await agent.io.waitIdle();
}

/** 改动声明面（工具 / 权限 / 扩展 / 技能）之前，先等它闲下来。 */
export async function ioWaitIdle(agent: Agent): Promise<number> {
  // tools.add / permissions.only / extensions.add 都要走 pi 的 reload，而 pi 在运行中 reload
  // 会**静默不生效**（在飞那轮照常跑完，改动毫无痕迹）。库因此把这几档改成「忙时抛错」，
  // 并要求你先 waitIdle —— 它不是可选礼貌，是这些操作的固定前奏。
  await agent.io.waitIdle();
  return agent.context.history.length;
}

// ─────────────── 观测：on 按名收窄，onAny 全量 ───────────────

/** 只关心一种事件时用 on：事件名收窄 handler 的参数类型。 */
export async function eventsOn(agent: Agent): Promise<string[]> {
  const roles: string[] = [];
  // on 的 event 参数是**按名字收窄**过的（这里就是 MessageEndEvent），不需要自己 cast。
  // 只要收集信息就**必须写成块体**：`(e) => roles.push(e.message.role)` 返回的是数组长度（真值），
  // 会被 pi 当成「变换结果」用，后果是本次载荷被整体替换（表现为空回复、长时间重试、且没有任何报错）。
  const off = agent.on("message_end", (event) => {
    roles.push(event.message.role);
  });
  await agent.io.prompt("说一句话");
  off(); // 返回的是退订函数：长寿命 agent 上忘了退订，监听器会一轮轮攒下去
  return roles;
}

/** 横切观测（trace / 日志）用 onAny：不挑事件，全都要。 */
export async function eventsOnAny(agent: Agent): Promise<string[]> {
  const types: string[] = [];
  // onAny 拿到的是**判别的联合**，先看 event.type 再取字段 —— 这正是 trace / 日志要的形状。
  const off = agent.onAny((event) => {
    types.push(event.type);
  });
  await agent.io.prompt("说一句话");
  off();
  return types;
}

// ─────────────── context：历史 / 本轮覆盖 / 压缩 ───────────────

/** 读会话历史（只读快照）。 */
export function contextHistory(agent: Agent): { role: string; text: string }[] {
  // history 与 RunResult.messages 是**同一视角**：不含 system —— system 每轮由 pi 重建，
  // 它不属于对话历史。要看会话原样（含 system）走 context.raw.session.messages。
  // 拿到的是快照：之后再跑几轮，手里这份不会跟着变。
  return agent.context.history.map((message) => {
    // 不是每种消息都有 content（例如 bashExecution），所以先问有没有再取 —— 这也解释了
    // 为什么 history 的元素类型是个联合，而不是统一的「有 content 的消息」。
    const content = "content" in message ? message.content : undefined;
    return {
      role: message.role,
      text: typeof content === "string"
        ? content
        : (content ?? [])
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join(""),
    };
  });
}

/** 只把**最近几条**发给模型：改的是这一轮，不是历史。 */
export function contextOverride(agent: Agent): void {
  // 函数形式拿到的是**不含 system** 的消息数组（与 history 同一视角），返回什么就发什么；
  // pi 传进去的是副本 ⇒ 随手 slice / filter 都不会写坏 session.messages。
  // 它是逐轮生效的：设一次，之后**每一轮**都按这个规则裁剪，直到 override(undefined) 清除。
  // 一个不值当省心的细节：别只删 toolResult 却留下带工具调用的 assistant —— 不配对的工具调用
  // 会被 pi 修回来（工具结果被重新补上），比你预期多发。要裁就按**整轮**裁。
  agent.context.override((messages) => messages.slice(-2));
}

/** 压缩历史（要求 idle）。 */
export async function contextCompact(agent: Agent): Promise<void> {
  // 压缩前必须空闲：pi 的 session.compact() **首行就是 abort()**，运行中调用会静默打断在飞那轮，
  // 然后抛「Nothing to compact」这类错。库因此加了守卫，忙时直接拒绝 —— 要自己承担打断才走 raw。
  await agent.io.waitIdle();
  // 参数是给「怎么压」的提示；不传就用默认策略。压完 history 变短是正常的，不是消息丢了。
  // 历史太短时 pi 会抛「Nothing to compact」——它认为没东西可压，这不是出错了。
  await agent.context.compact("保留结论与待办，压掉中间过程");
}

// ─────────────── tools：运行期加工具 ───────────────

/** 运行期加一个工具：加完立刻生效，模型下一轮就看得见它。 */
export async function toolsAdd(agent: Agent): Promise<string[]> {
  // add 碰的是**声明面**，要走 reload ⇒ 只有空闲时能改（忙时抛错，先 io.waitIdle()）。
  // 好处是脏活它替你做了：白名单会自动补上这个名字、同名 deny 会解除、reload 之后还会显式激活。
  // 所以你不需要再动 permissions，也不该怀疑 `tools.list()` 里的 active。
  await agent.tools.add(
    defineTool({
      name: "word_count",
      label: "Word Count",
      description: "数一段文本有多少个词",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text" as const, text: String(params.text.split(/\s+/).filter(Boolean).length) }],
        details: {},
      }),
    }),
  );
  return agent.tools.list().filter((t) => t.active).map((t) => t.name);
}

/**
 * 「工具真的进了给模型的声明」怎么看 —— 先加工具再发一轮。
 *
 * 这个顺序**不是讲究，是必要条件**：pi 只在「工具集相对上一次请求有变化」时才把声明带上；
 * 而声明的首个锚点是**建会话时那次请求**的 system 消息。所以创建期就存在的工具，只算在初始
 * 请求里、在**后续**请求里不再重复声明（这是历史里一贯的约定，不是丢东西）。
 * 要验证某个工具进了声明，就按「先起、后加、再看下一轮」来测。
 */
export async function toolsAddThenInspect(sentTools: () => string[]): Promise<string[]> {
  return sentTools().filter((name) => name === "word_count");
}

/** 工厂式工具：工具需要 agent 句柄时用它。 */
export async function toolsAddFactory(agent: Agent): Promise<void> {
  // 工厂在**声明时**被调用一次，ctx.agent 就是本 agent —— 把要用的能力在那一刻取好、存进闭包。
  // 别在 execute 里去 capture 一个「模块级变量」，它可能在声明发生时还没赋值；
  // 也别每次 execute 都重新找 agent：ctx 给的就是最终那个句柄，不是占位空壳。
  await agent.tools.add((ctx) => {
    const owner = ctx.agent;
    return defineTool({
      name: "my_history_size",
      label: "My History Size",
      description: "报出本 agent 当前的历史条数",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text" as const, text: String(owner.context.history.length) }],
        details: {},
      }),
    });
  });
}

// ─────────────── permissions：审批门与白名单 ───────────────

/** 审批门：每次工具调用前先问一句，能拦能改。 */
export function permissionsGate(agent: Agent): void {
  // gate 是**只写不读的同步单槽位**：后设的覆盖先设的，没有「读回来」的机会 —— 判定逻辑一次写清。
  // 返回 {block:true, reason} 挡下这次调用；reason 会作为工具结果回到模型面前，
  // 写清「为什么」远比单纯拒绝有用：模型据此改道，而不是反复撞同一堵墙。
  agent.permissions.gate(async (call) => {
    const command = String((call.input as { command?: string }).command ?? "");
    if (call.name === "bash" && command.includes("rm -rf")) {
      return { block: true, reason: "这条命令看起来会删我的东西，换个方式" };
    }
    return undefined;
  });
}

/** 精确白名单：「就这几个」。 */
export async function permissionsOnly(agent: Agent): Promise<string[]> {
  // only 是**精确**语义：允许的集合就是给的这个（与 allow 的并集语义不同，别混）。
  // 白名单是硬过滤：集合外的工具连注册表都进不去，模型完全看不到 —— 所以它同时是最省 token 的一档。
  // 它碰声明面 ⇒ 要求 idle。
  await agent.io.waitIdle();
  await agent.permissions.only(["read", "bash"]);
  return agent.tools.list().map((t) => `${t.name}:${t.active}`);
}

// ─────────────── extensions / skills：运行期加载 ───────────────

/** 运行期加载一个扩展（内联工厂或路径）。 */
export async function extensionsAdd(agent: Agent): Promise<number> {
  // 内联工厂是「就地注册工具 / 钩子」的扩展：pi 把 ExtensionAPI 交给它。
  // 它注册的工具名会被库自动并进白名单 —— 不并的话，在白名单下会被 pi 静默硬过滤掉（工具人间蒸发）。
  await agent.extensions.add((pi) => {
    pi.registerTool(
      defineTool({
        name: "shout",
        label: "Shout",
        description: "把文本变成大写",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, params) => ({
          content: [{ type: "text" as const, text: params.text.toUpperCase() }],
          details: {},
        }),
      }),
    );
  });
  // 加载失败不静默：路径不存在 / 扩展抛错都在这里读得到（运行期钩子抛错另走 console.error）。
  const errors = agent.extensions.errors();
  if (errors.length) throw new Error(`扩展加载失败：${errors.map((e) => e.path).join("、")}`);
  return agent.extensions.list().length;
}

/** 运行期加一个技能。 */
export async function skillsAdd(agent: Agent, skillPath: string): Promise<string[]> {
  // 只接受**路径**（技能目录或 SKILL.md）或 Skill 对象：技能是被环境发现的 —— pi 从目录里读 SKILL.md，
  // 所以 skills.add("my-skill") 这种按名字注册没有意义，会直接抛错（避免「写了却什么都没发生」）。
  // 路径没能加载出任何技能也会抛错并把注入撤掉：不静默降级。
  await agent.skills.add(skillPath);
  return agent.skills.list().map((skill) => skill.name);
}

// ─────────────── model：换模型 / 换思考档 ───────────────

/** 换模型：错的模型名会抛错，不会静默用回原模型。 */
export async function modelSet(agent: Agent): Promise<string> {
  // ref 是 "provider/id"，还可带思考档后缀 "provider/id:high"（后缀会一并兑现，不是被忽略的装饰）。
  // set 可以在运行中调用：它不打断在飞那轮，改动从**下一次请求**起生效 —— 这正是「换模型」的语义。
  await agent.model.set("faux/echo-alt:high");
  // current 是 pi 的 Model 对象（不是字符串 ref）；要 ref 自己拼。
  return agent.model.current?.id ?? "";
}

/** 换思考档：非法档位会抛错，不会被静默钳到最近的档。 */
export function modelSetThinking(agent: Agent, level: ThinkingLevel): ThinkingLevel {
  // setThinking 是同步的（不碰声明面、不 reload），运行中也能调，同样是「下一次请求」生效。
  // 与 pi 的差别在这里：pi 对非法档位会**静默钳**（very-high → off，连抛都不抛），
  // 库先按会话的可用档校验，不在里面就抛错 —— 「以为开了高思考档、实际跑在 off」比报错昂贵得多。
  agent.model.setThinking(level);
  return agent.model.thinking;
}

// ─────────────── raw：各面的逃生口（全权，无护栏） ───────────────

/** io 的逃生口就是 pi 的 AgentSession 本身。 */
export function rawIo(agent: Agent): string[] {
  // 逃生口 = **全权、无护栏**：绕过库的忙判据与结算，直接操作 pi 的会话。
  // 例：reload() 在库这边要求 idle（忙时抛错），raw 路径没有这道守卫 —— 用之前自己想清楚代价。
  const session = agent.io.raw;
  return session.messages.map((message) => message.role); // 这里能看到 system（history 看不到）
}

/** context 的逃生口是 { session, sessionManager }。 */
export function rawContext(agent: Agent): { id: string; roles: string[] } {
  const { session, sessionManager } = agent.context.raw;
  // session 是会话本体：messages 含 system；compact() 也能直通（库的 idle 守卫不在这一层）。
  // sessionManager 管持久化与会话账本，库不包装它 —— 要读会话文件 / 会话 id 就来这里。
  return { id: sessionManager.getSessionId(), roles: session.messages.map((message) => message.role) };
}

/** tools 的逃生口：拿 pi **真正持有**的那份工具定义。 */
export function rawTools(agent: Agent, name: string): string[] {
  // tools.list() 只给「名字 + active」；要对参数 schema / description 的**实际注册结果**，
  // 只有这里看得到 —— 库的表是经 reload 注册进 pi 的，raw 读的是注册之后的那一份。
  const definition = agent.tools.raw.getToolDefinition(name);
  return definition ? [definition.name, definition.description] : [];
}

/** extensions 的逃生口是 { loader, session }。 */
export function rawExtensions(agent: Agent): string[] {
  // loader 是 pi 的资源加载器本体：库只在「我显式加进来的路径 / 工厂」那张表上工作，
  // 而 loader 看到的是**真实加载结果**，含环境自动发现、不归库管的那些扩展。
  return agent.extensions.raw.loader
    .getExtensions()
    .extensions.map((extension) => extension.path);
}

/** skills 的逃生口直接就是 loader。 */
export function rawSkills(agent: Agent): string[] {
  // 技能只有「被环境发现」这一种来路，所以没有额外的包装对象：raw 就是 loader。
  // 用它的理由不是绕开库，而是拿 pi 的其它读取面（这里只演示最直白的一处）。
  return agent.skills.raw.getSkills().skills.map((skill) => skill.name);
}

/** model 的逃生口是 { session, modelRuntime }。 */
export function rawModel(agent: Agent): number {
  // 两个对象职责不同：
  //   - session 上是**会话当前**的模型与思考档（model 面读的就是它）；
  //   - modelRuntime 是宿主级共享的目录 + 凭证（同一个 agentDir 只建一份），model.available 取自它。
  // 直接读 runtime 能拿到更细的视图（如「按凭证过滤前后」），model 面只给一个稳定快照。
  return agent.model.raw.modelRuntime.getAvailableSnapshot().length;
}

// ─────────────── 片段文本：从函数自己派生，零漂移 ───────────────

/** 片段名 → 该片段的真函数。名字是 GUIDE.md 引用片段用的键。 */
const pieces: Record<string, (...args: never[]) => unknown> = {
  "io.prompt": ioPrompt,
  "io.queue": ioQueue,
  "io.waitIdle": ioWaitIdle,
  "events.on": eventsOn,
  "events.onAny": eventsOnAny,
  "context.history": contextHistory,
  "context.override": contextOverride,
  "context.compact": contextCompact,
  "tools.add": toolsAdd,
  "tools.addThenInspect": toolsAddThenInspect,
  "tools.addFactory": toolsAddFactory,
  "permissions.gate": permissionsGate,
  "permissions.only": permissionsOnly,
  "extensions.add": extensionsAdd,
  "skills.add": skillsAdd,
  "model.set": modelSet,
  "model.setThinking": modelSetThinking,
  "raw.io": rawIo,
  "raw.context": rawContext,
  "raw.tools": rawTools,
  "raw.extensions": rawExtensions,
  "raw.skills": rawSkills,
  "raw.model": rawModel,
};

/**
 * 片段名 → 源码文本。值来自上面的真函数（`fn.toString()`），**不是手抄的字符串**。
 * 所以「函数体改了、文档没改」这件事不可能发生：两者是同一份东西。
 */
export const snippets: Record<string, string> = Object.fromEntries(
  Object.entries(pieces).map(([name, fn]) => [name, fn.toString()]),
);
