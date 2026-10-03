// 安装自检：一条命令回答「这台机器现在可以开始研究 agent 课题了吗」。
//
// 跑法：node demo/check.ts        成功 = 七项全「通过」+ 退出码 0
//       PI_OFFLINE=1 node demo/check.ts   等价（demo 本来就离线，见 env.ts）
//
// 设计原则：**失败必须可诊断**。哪一步、原始错误、最可能的三个原因与怎么补 —— 缺一不可。
// 所以下面每一项都带三条 hints，失败时连同原始错误（含栈）一起打出来，然后 exit(1)。
//
// 两个判据值得单独说：
//   第 6 项判的是「工具的执行体真跑过」（闭包计数器），**不是** `tools.list()` 里有它 ——
//   后者只说明声明存在，工具没被调用时它照样是 active，不判别。
//   第 7 项七个面每一项都**真的调用过**（并尽可能读回写进去的值），不是「读一个属性」凑数。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgent, inspectEnv } from "../src/index.ts";
import type { Agent, AgentTool } from "../src/index.ts";
import { FAUX_MODEL_ALT_REF, FAUX_MODEL_ID, FAUX_MODEL_REF, FAUX_PROVIDER } from "../examples/lib/faux-models.ts";
import { ensureEnv } from "./env.ts";

/** 本仓库钉住的 pi 版本（package.json 的 `^0.99.1`）；示例与文档都按它写 */
const PI_VERSION = "0.99.1";
/** 原生执行 .ts 默认开启的最低 Node（v22.18+ 与 v23.6+） */
const MIN_NODE = { major: 22, minor: 18 };

interface StepResult {
  /** 拼进「通过（…）」里的证据，一句话 */
  detail: string;
  /** 附在下面缩进的补充证据（每次调用读到了什么） */
  evidence?: string[];
}

interface Step {
  name: string;
  run: () => Promise<StepResult> | StepResult;
  /** 最可能的三个原因与怎么补 */
  hints: [string, string, string];
}

// ─────────────── 打印小工具 ───────────────

/** 中文按两个字符宽度算，好让「…」对齐（brief 里的格式） */
function displayWidth(text: string): number {
  return [...text].reduce((n, ch) => n + (/[\u2e80-\ua4cf\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(1, width - displayWidth(text)));
}

function oneLine(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ─────────────── 七项自检 ───────────────

async function main(): Promise<void> {
  // 跨项共享的状态：agent 本体 + 两个「执行体真跑过」的闭包计数器
  let agent: Agent | undefined;
  let probeCalls = 0;
  let gateCalls = 0;

  const requireAgent = (): Agent => {
    if (!agent) throw new Error("agent 还没起来（应该由第 4 项建出来）");
    return agent;
  };

  /** 第 6 项要调用的那个工具：执行体每次跑都 +1，这是「工具链通」的唯一判据 */
  const probeTool: AgentTool = defineTool({
    name: "demo_probe",
    label: "Demo Probe",
    description: "自检探针：把参数里的 text 原样回显",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params) => {
      probeCalls += 1;
      return { content: [{ type: "text" as const, text: `probe 收到：${params.text}` }], details: {} };
    },
  });

  /** 第 7 项 tools 面要 add 的第二个工具 */
  const extraTool: AgentTool = defineTool({
    name: "demo_probe_extra",
    label: "Demo Probe Extra",
    description: "自检探针二号：证明 tools.add 在运行期真的加得上",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "extra" }], details: {} }),
  });

  const steps: Step[] = [
    {
      name: "Node 与原生 .ts",
      run: () => {
        const version = process.versions.node;
        const [major, minor] = version.split(".").map(Number);
        if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
          throw new Error(`Node v${version} 太旧：免开关原生执行 .ts 需要 v22.18+ / v23.6+`);
        }
        // 这条 if 能执行到，本身就是「.ts 被 node 原生执行了」的证据
        return { detail: `v${version}` };
      },
      hints: [
        "`node --version` 低于 v22.18（或 v23 系列低于 v23.6）⇒ 去 https://nodejs.org 装新的 LTS，重开终端再跑",
        "你以为在用 node，其实被 ts-node / tsx / bun 之类的包装接管了 ⇒ 原样敲 `node demo/check.ts`",
        "Node 是 22.6–22.17（原生剥类型还没默认打开）⇒ 升级到 v22.18+，不要自己加 --experimental-strip-types 老开关",
      ],
    },
    {
      name: "pi-coding-agent 可解析",
      run: () => {
        // import.meta.resolve 走 ESM 的 exports 条件（这个包只导出 import，require.resolve 解析不到）
        const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
        const pkgPath = join(dirname(entry), "..", "package.json");
        const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version;
        if (version !== PI_VERSION) {
          throw new Error(`装的是 ${version ?? "(package.json 里读不到 version)"}，本仓库钉的是 ${PI_VERSION}（读自 ${pkgPath}）`);
        }
        return { detail: version };
      },
      hints: [
        "依赖还没装 ⇒ 在仓库根目录跑 `npm install`（按 package-lock.json 会装回 0.99.1）",
        "装的是别的版本（`npm ls @earendil-works/pi-coding-agent`）⇒ `npm install @earendil-works/pi-coding-agent@0.99.1`",
        "node_modules 是别的 Node / 别的包管理器装出来的 ⇒ 删掉 node_modules 再 `npm install`，不要混用 npm 与 pnpm",
      ],
    },
    {
      name: "agentDir 可写、模型可读",
      run: async () => {
        const env = await ensureEnv();
        // 写探针：真写一个文件、读回来、再删掉
        const probePath = join(env.agentDir, ".write-probe");
        writeFileSync(probePath, "ok");
        const readBack = readFileSync(probePath, "utf8");
        rmSync(probePath);
        if (readBack !== "ok") throw new Error(`写进 ${probePath} 又读回来不是 ok：${JSON.stringify(readBack)}`);
        // 模型可读：走库自己的 inspectEnv（与 createAgent 同一套 loader / ModelRuntime）
        const report = await inspectEnv({ agentDir: env.agentDir, cwd: env.cwd, modelNetwork: false });
        const group = report.models.find((g) => g.provider === FAUX_PROVIDER);
        if (!group || !group.available.includes(FAUX_MODEL_ID)) {
          throw new Error(
            `读不到假 provider ${FAUX_PROVIDER}/${FAUX_MODEL_ID}：models=${JSON.stringify(report.models)}` +
              ` warnings=${report.warnings.join("；") || "无"}`,
          );
        }
        return {
          detail: `agentDir 可写；读到 ${group.available.length} 个模型`,
          evidence: [
            `${join(env.agentDir, "models.json")} → ${FAUX_PROVIDER}: ${group.available.join("、")}（离线，modelNetwork:false）`,
          ],
        };
      },
      hints: [
        "`demo/env/` 不可写（权限位、只读挂载、杀软拦住新建目录）⇒ 给目录写权限，或把仓库挪到可写盘",
        "磁盘满 / Windows 路径过长（MAX_PATH）⇒ 清磁盘，或把仓库挪到短路径（如 D:\\aiteam）",
        "`models.json` 被改坏或结构过时（手工编辑、上一版 demo 留下的）⇒ 删掉 `demo/env/agent/` 整个目录再重跑，ensureEnv 会重建",
      ],
    },
    {
      name: "createAgent 能起 agent",
      run: async () => {
        const env = await ensureEnv();
        agent = await createAgent({
          id: "demo-check",
          agentDir: env.agentDir,
          cwd: env.cwd,
          model: FAUX_MODEL_REF,
          modelNetwork: false, // 离线是默认，不是运气
          context: { autoCompact: false },
          tools: { custom: [probeTool] },
        });
        const me = agent;
        return {
          // tools.list() 只列**运行期 add** 的工具；创建期 tools.custom 走 pi 的 customTools，不在里面
          detail: `id=${me.id}，model=${me.model.current?.id}/${me.model.thinking}`,
          evidence: [`agentDir=${env.agentDir}`, `cwd=${env.cwd}`, `假 provider=${env.baseUrl}`],
        };
      },
      hints: [
        "第 2 项已经告诉你 pi 版本不对（那一步先修）⇒ 版本不一致时创建参数形状可能已变",
        "模型 ref 解析不到（`models.json` 被改过/被别的 demo 覆盖）⇒ 删 `demo/env/agent/` 再重跑",
        "`demo/work/` 不可写或被别的进程占着（会话要落在这里）⇒ 关掉占用它的进程，或删掉 `demo/work/` 让 demo 重建",
      ],
    },
    {
      name: "一轮 io.prompt 拿到非空文本",
      run: async () => {
        const me = requireAgent();
        const result = await me.io.prompt("自检第 5 项：请回一句话");
        if (result.error) throw new Error(`这一轮报错（pi 接受后失败不 reject，只写进 result.error）：${result.error}`);
        if (!result.text.trim()) throw new Error(`RunResult.text 是空的：${JSON.stringify(result.text)}`);
        return {
          detail: `拿到 ${result.text.length} 字符`,
          evidence: [`模型说：${oneLine(result.text)}`],
        };
      },
      hints: [
        "假 provider 没起来或端口被占 ⇒ 重跑一次；连续失败就查本机回环（127.0.0.1）是否被安全软件拦住，放行 node",
        "这一轮模型侧报错了（`result.error` 里就是原始错误）⇒ 按 error 文本查，别只看「失败」两个字",
        "pi 版本变了、SSE 解析不兼容 ⇒ 装回 0.99.1（见第 2 项）",
      ],
    },
    {
      name: "工具真被模型执行",
      run: async () => {
        const me = requireAgent();
        const before = probeCalls;
        const result = await me.io.prompt('[[tool:demo_probe]] [[args:{"text":"自检工具链"}]]');
        if (result.error) throw new Error(`这一轮报错：${result.error}`);
        const ran = probeCalls - before;
        if (ran < 1) {
          throw new Error(
            `demo_probe 的执行体一次都没跑（${before} → ${probeCalls}）：` +
              `tools.list() 里有没有它不算数，模型必须真的调用它`,
          );
        }
        return {
          detail: `demo_probe 的执行体真跑了 ${ran} 次`,
          evidence: [
            `模型这一轮回读：${oneLine(result.text)}`,
            // 这一行是对照，不判别：定义在注册表里 ≠ 执行体跑过
            `对照（不判别）：pi 注册表里有它的定义 = ${me.tools.raw.getToolDefinition("demo_probe") ? "有" : "没有"}`,
          ],
        };
      },
      hints: [
        '假 provider 的脚本约定没生效：提示里的 `[[tool:demo_probe]] [[args:{"text":"..."}]]` 被改动过 ⇒ 原样恢复（约定见 examples/lib/faux-server.ts 顶部）',
        "工具没进模型声明（白名单挡了 / `tools.custom` 没生效）⇒ 看这一项上面打印的「pi 注册表里有它的定义」那一行",
        "工具名对不上（代码里叫 demo_probe，检查里写成别的）⇒ 让两处同名",
      ],
    },
    {
      name: "七面各至少一次读写",
      run: async () => {
        const me = requireAgent();
        const env = await ensureEnv();
        const surfaces: string[] = [];

        // io：读 pending / isRunning，写 queue（+ waitIdle 等它跑完）
        const pending = me.io.pending;
        const wasRunning = me.io.isRunning;
        await me.io.queue("七面 · io：queue 一次");
        await me.io.waitIdle();
        if (me.io.pending !== 0) throw new Error(`waitIdle 之后 io.pending 应为 0，实际 ${me.io.pending}`);
        surfaces.push(`io（读 pending=${pending} / isRunning=${wasRunning}；写 queue + waitIdle）`);

        // context：读 history，写 autoCompact（读回校验）与 override（写完清除），跑一次 compact
        const historyLen = me.context.history.length;
        const autoCompactBefore = me.context.autoCompact;
        me.context.autoCompact = false;
        if (me.context.autoCompact !== false) throw new Error("context.autoCompact 写 false 之后读回来不是 false");
        me.context.autoCompact = autoCompactBefore;
        me.context.override((messages) => messages.slice(-1)); // 写：这一轮只发最后一条
        me.context.override(undefined); // 清除，否则后面每一轮都受影响
        let compactNote: string;
        try {
          await me.context.compact("自检：压一下看看");
          compactNote = `compact 成功（history ${historyLen} → ${me.context.history.length}）`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("Nothing to compact")) throw err; // 别的错误照抛
          // 会话太小、没东西可压 —— pi 的预期行为，按通过算，但要说出来
          compactNote = `compact：会话太小、无需压缩（${message}）—— 正常路径`;
        }
        surfaces.push(
          `context（读 history=${historyLen}、autoCompact=${autoCompactBefore}；写 autoCompact + override 并清除；${compactNote}）`,
        );

        // tools：读 list，写 add（再读回来确认它 active）
        const toolsBefore = me.tools.list().length;
        await me.tools.add(extraTool);
        if (!me.tools.list().some((t) => t.name === "demo_probe_extra" && t.active)) {
          throw new Error(`tools.add 之后 list() 里没有 demo_probe_extra:active=true：${JSON.stringify(me.tools.list())}`);
        }
        surfaces.push(`tools（读 list=${toolsBefore} 个；写 add=demo_probe_extra → ${me.tools.list().length} 个）`);

        // model：读 current / thinking / available，写 set + setThinking（读回），再还原
        const modelBefore = `${me.model.current?.id}/${me.model.thinking}`;
        const availableCount = me.model.available.length;
        await me.model.set(FAUX_MODEL_ALT_REF); // 换到 reasoning:true 的那个模型
        me.model.setThinking("high"); // 只有 echo-alt 有这个合法档
        if (me.model.thinking !== "high") throw new Error(`setThinking("high") 之后读回来是 ${me.model.thinking}`);
        await me.model.set(FAUX_MODEL_REF);
        me.model.setThinking("off");
        surfaces.push(
          `model（读 current=${modelBefore}、thinking、available=${availableCount} 个；写 set=echo-alt + setThinking=high，再还原为 ${me.model.current?.id}/${me.model.thinking}）`,
        );

        // extensions：读 list + errors，写 add 一个内联扩展（再读回来确认多了一个）
        const extensionsBefore = me.extensions.list().length;
        await me.extensions.add((pi) => {
          pi.registerTool(
            defineTool({
              name: "demo_ext_tool",
              label: "Demo Extension Tool",
              description: "内联扩展注册的工具：证明 extensions.add 真的加载了",
              parameters: Type.Object({}),
              execute: async () => ({ content: [{ type: "text" as const, text: "ext" }], details: {} }),
            }),
          );
        });
        const extErrors = me.extensions.errors();
        if (extErrors.length) {
          throw new Error(`扩展加载失败：${extErrors.map((e) => `${e.path}: ${e.error}`).join("；")}`);
        }
        const extensionsAfter = me.extensions.list().length;
        if (extensionsAfter <= extensionsBefore) {
          throw new Error(`extensions.add 之后 list() 没增加：${extensionsBefore} → ${extensionsAfter}`);
        }
        surfaces.push(`extensions（读 list=${extensionsBefore} 个 + errors=0；写 add → ${extensionsAfter} 个）`);

        // skills：读 list，写 add 一个真实存在的 SKILL.md 目录（再读回来确认按名字出现）
        const skillsBefore = me.skills.list().length;
        const skillName = "demo-check-skill";
        const skillDir = join(env.cwd, "skills", skillName);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\ndescription: 安装自检用的技能\n---\n\n正文\n`);
        await me.skills.add(skillDir);
        if (!me.skills.list().some((s) => s.name === skillName)) {
          throw new Error(`skills.add 之后 list() 里没有 ${skillName}：${JSON.stringify(me.skills.list().map((s) => s.name))}`);
        }
        surfaces.push(`skills（读 list=${skillsBefore} 个；写 add=${skillName}（真 SKILL.md）→ ${me.skills.list().length} 个）`);

        // permissions：写 gate（并让它真被调用一次）+ only / allow / deny 各一次，都用 tools.list() 读回。
        // 读回用 demo_probe_extra：**只有运行期 add 的工具才在 tools.list() 里**（创建期 tools.custom 走
        // pi 的 customTools，不在那张表上），所以要有一个能读回状态的工具。
        me.permissions.gate(async (call) => {
          gateCalls += 1;
          void call;
          return undefined; // 放行：这一项验的是「门活着」，不是拦不拦得住
        });
        const isExtraActive = () => me.tools.list().some((t) => t.name === "demo_probe_extra" && t.active);
        await me.permissions.only(["demo_probe_extra"]);
        if (!isExtraActive()) {
          throw new Error(`only(["demo_probe_extra"]) 之后它不是 active：${JSON.stringify(me.tools.list())}`);
        }
        await me.permissions.deny(["demo_probe_extra"]);
        if (isExtraActive()) {
          throw new Error(`deny(["demo_probe_extra"]) 之后它还是 active：${JSON.stringify(me.tools.list())}`);
        }
        await me.permissions.allow(["demo_probe_extra"]);
        if (!isExtraActive()) {
          throw new Error(`allow(["demo_probe_extra"]) 之后它仍不是 active：${JSON.stringify(me.tools.list())}`);
        }
        const gateBefore = gateCalls;
        await me.io.prompt("[[tool:demo_probe_extra]]");
        if (gateCalls <= gateBefore) {
          throw new Error(`审批门一次都没被调用（${gateBefore} → ${gateCalls}）：gate 装上 ≠ 生效`);
        }
        surfaces.push(`permissions（写 gate 且真被调用 ${gateCalls} 次；写 only/deny/allow 各一次，都用 tools.list() 读回）`);

        return { detail: `${surfaces.length} 个面各至少一次读写`, evidence: surfaces };
      },
      hints: [
        "`compact` 抛的是 busy 而不是「Nothing to compact」⇒ 有别的轮次在飞：先 `await io.waitIdle()` 再做（queue/steer 之后别漏等）",
        "`only` / `allow` / `deny` 抛 busy ⇒ 同上；它们要碰工具声明面（reload），必须在空闲时调用",
        "某个面的方法签名对不上（pi 版本变了）⇒ 装回 0.99.1，并对照 examples/01-08 里同一个面的写法",
      ],
    },
  ];

  const labelWidth = Math.max(...steps.map((s) => displayWidth(s.name))) + 2;

  for (const [index, step] of steps.entries()) {
    const label = `[${index + 1}/${steps.length}] ${pad(step.name, labelWidth)}`;
    try {
      const result = await step.run();
      console.log(`${label} … 通过（${result.detail}）`);
      for (const line of result.evidence ?? []) console.log(`        ${line}`);
    } catch (err) {
      // 失败必须可诊断：哪一步 + 原始错误（含栈）+ 最可能的三个原因与怎么补
      console.log(`${label} … 失败`);
      console.log(`    原始错误：${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        for (const line of err.stack.split("\n").slice(1, 9)) console.log(`      ${line.trim()}`);
      }
      console.log("    最可能的三个原因与怎么补：");
      step.hints.forEach((hint, i) => console.log(`      ${i + 1}. ${hint}`));
      // 退出码 1，但**不用 process.exit()**：Windows 上它在 libuv 收句柄时会触发断言
      // （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），把退出码变成 127（实测）。
      // 设 exitCode 后正常返回，让事件循环自己排空 —— 假服务是 unref 的，没有活句柄会拖住进程。
      process.exitCode = 1;
      agent?.dispose();
      return;
    }
  }

  agent?.dispose();
  console.log("");
  console.log("七项全通过 —— 本机可以开始研究 agent 课题了。");
  console.log("下一步：node examples/01-first-agent.ts（最小演示）；失败时怎么读输出见 demo/README.md。");
}

await main();
