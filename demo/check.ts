// 安装自检：一条命令回答「这台机器现在可以开始研究 agent 课题了吗」。
//
// 跑法：node demo/check.ts        成功 = 八项全「通过」+ 退出码 0
//       AITEAM_DEMO_MODEL=provider/id node demo/check.ts   换模型（默认 opencode-go/space-bunny-free）
//       AITEAM_DEMO_AUTH=/path/to/auth.json node demo/check.ts   换凭证
//
// 设计原则：**失败必须可诊断**。哪一步、原始错误、最可能的三个原因与怎么补 —— 缺一不可。
// 所以下面每一项都带三条 hints，失败时连同原始错误（含栈）一起打出来，然后 exit(1)。
//
// 两个判据值得单独说：
//   第 6 项判的是「工具的执行体真跑过」（闭包计数器），**不是** `tools.list()` 里有它 ——
//   后者只说明声明存在，工具没被调用时它照样是 active，不判别。
//   第 8 项七个面每一项都**真的调用过**（并尽可能读回写进去的值），不是「读一个属性」凑数。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Agent, AgentTool } from "../src/index.ts";
import { ensureEnv, type DemoEnv } from "./env.ts";
import { under } from "../src/agent/loader.ts";
import { createLab, type Lab } from "../src/index.ts";

/**
 * 期望的 pi 版本：这里用**精确等值**（===）比较。期望值来自本仓 `package-lock.json` 钉住的
 * 0.99.1（package.json 声明的是 `^0.99.1`，将来合法升级会让这一项红）——
 * **升级 pi 时同步改这一个常量**（就一行）。
 */
const PI_VERSION = "0.99.1";

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


/** 把绝对路径缩成相对 agentDir 的短样子，方便读 */
function shortPath(p: string, base: string): string {
  const a = p.replace(/\\/g, "/");
  const b = base.replace(/\\/g, "/");
  return a.startsWith(b) ? `.${a.slice(b.length)}` : a;
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

// ─────────────── 八项自检 ───────────────

async function main(): Promise<void> {
  // 实验室：环境一旦已知（ensureEnv 幂等）就只建一个 —— agentDir / cwd 全从这里来。
  // 惰性建、不在 main 开头就建：凭证缺失时要保持「第 3 项失败 + 三条原因」那个形状。
  let labPromise: Promise<Lab> | undefined;
  const ensureLab = (env: DemoEnv): Promise<Lab> =>
    (labPromise ??= createLab({
      agentDir: env.agentDir,
      cwd: env.cwd,
      // 真模型：模型目录联网刷新（默认行为）
    }));

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

  /** 第二个探针：与 demo_probe 同构，只为了让模型「有得选」—— 见第 6 项的注释（二选一，不能选「不调」） */
  const probeToolB: AgentTool = defineTool({
    name: "demo_probe_b",
    label: "Demo Probe B",
    description: "自检探针（与 demo_probe 同构，任选一个调即可）：把参数里的 text 原样回显",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_id, params) => {
      probeCalls += 1;
      return { content: [{ type: "text" as const, text: `probe 收到：${params.text}` }], details: {} };
    },
  });

  /** 第 8 项 tools 面要 add 的第二个工具 */
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
        // 免开关原生执行 .ts 的最低版本：v22.18+、v23.6+（v24+ 都行）。v23.0–23.5 与 v22.6–22.17
        // 一样没默认开剥类型 —— 判据必须把这两个区间的低 minor 也挡掉，不能只判 major。
        if (major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6)) {
          throw new Error(`Node v${version} 太旧：免开关原生执行 .ts 需要 v22.18+ / v23.6+`);
        }
        // 这条 if 能执行到，本身就是「.ts 被 node 原生执行了」的证据
        return {
          detail: `v${version}`,
          evidence: [`node=${process.execPath}`],
        };
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
        return {
          detail: version,
          evidence: [`入口=${entry}`],
        };
      },
      hints: [
        "依赖还没装 ⇒ 在仓库根目录跑 `npm install`（按 package-lock.json 会装回 0.99.1）",
        "装的是别的版本（`npm ls @earendil-works/pi-coding-agent`）⇒ `npm install @earendil-works/pi-coding-agent@0.99.1`",
        "你是**故意**升级了 pi（package.json / lock 都跟着变了）⇒ 这一项是精确等值：改 `demo/check.ts` 顶部 `PI_VERSION` 常量（就一行）",
      ],
    },
    {
      name: "agentDir 可写、模型可读",
      run: async () => {
        const env = await ensureEnv();
        const lab = await ensureLab(env);
        // 写探针：真写一个文件、读回来、再删掉
        const probePath = join(env.agentDir, ".write-probe");
        writeFileSync(probePath, "ok");
        const readBack = readFileSync(probePath, "utf8");
        rmSync(probePath);
        if (readBack !== "ok") throw new Error(`写进 ${probePath} 又读回来不是 ok：${JSON.stringify(readBack)}`);
        // 模型可读：走实验室的 inspectEnv（与它起的 agent 同一套 loader / ModelRuntime）
        const report = await lab.inspectEnv();
        // 不假设 provider 叫什么，直接找 env.model 那一项
        const [provider, id] = env.model.split("/");
        const group = report.models.find((g) => g.provider === provider);
        if (!group || !group.available.includes(id!)) {
          throw new Error(
            `读不到 ${env.model}：providers=${report.models.map((g) => `${g.provider}(${g.available.length})`).join("、")}` +
              ` warnings=${report.warnings.join("；") || "无"}`,
          );
        }
        return {
          detail: `agentDir 可写；demo 自己的凭证下读到 ${env.model}`,
          evidence: [
            `agentDir=${env.agentDir}（凭证在 demo/agent/auth.json，或由 AITEAM_DEMO_AUTH 复制而来）`,
            `${provider}: ${group.available.length} 个可用，含 ${id}`,
          ],
        };
      },
      hints: [
        "`demo/agent/` 不可写（权限位、只读挂载、杀软拦住新建目录）⇒ 给目录写权限，或把仓库挪到可写盘",
        "磁盘满 / Windows 路径过长（MAX_PATH）⇒ 清磁盘，或把仓库挪到短路径（如 D:\\aiteam）",
        "凭证被改坏（手工编辑）⇒ 重新写一份 `demo/agent/auth.json`，或用 AITEAM_DEMO_AUTH 指一份干净的",
      ],
    },
    {
      name: "用实验室起 agent",
      run: async () => {
        const env = await ensureEnv();
        const lab = await ensureLab(env);
        agent = await lab.createAgent({
          id: "demo-check",
          model: env.model,
          context: { autoCompact: false },
          tools: { custom: [probeTool, probeToolB] },
        });
        const me = agent;
        return {
          // tools.list() 只列**运行期 add** 的工具；创建期 tools.custom 走 pi 的 customTools，不在里面
          detail: `id=${me.id}，model=${me.model.current?.id}/${me.model.thinking}`,
          evidence: [
            `agentDir=${env.agentDir}`,
            `cwd=${env.cwd}`,
            `真模型（凭证来自 demo/agent/auth.json）`,
          ],
        };
      },
      hints: [
        "第 2 项已经告诉你 pi 版本不对（那一步先修）⇒ 版本不一致时创建参数形状可能已变",
        "凭证不对 / 模型 ref 解析不到（`demo/agent/auth.json` 被改过，或 AITEAM_DEMO_MODEL 指了不存在的模型）⇒ 重写凭证，或先不设 AITEAM_DEMO_MODEL 跑默认免费档",
        "`demo/work/` 不可写或被别的进程占着（会话要落在这里）⇒ 关掉占用它的进程，或删掉 `demo/work/` 让 demo 重建",
      ],
    },
    {
      name: "一轮 io.prompt 拿到非空文本",
      run: async () => {
        const me = requireAgent();
        const result = await me.io.prompt("自检第 5 项：请回一句话（任意内容即可）");
        if (result.error) throw new Error(`这一轮报错（pi 接受后失败不 reject，只写进 result.error）：${result.error}`);
        if (!result.text.trim()) throw new Error(`RunResult.text 是空的：${JSON.stringify(result.text)}`);
        return {
          detail: `拿到 ${result.text.length} 字符`,
          evidence: [`模型说：${oneLine(result.text)}`],
        };
      },
      hints: [
        "没网 / 网络被拦 ⇒ 这一项要真的调一次 provider；查代理与防火墙，或先自查 `curl` 一下服务商域名",
        "这一轮模型侧报错了（`result.error` 里就是原始错误）⇒ 按 error 文本查，别只看「失败」两个字",
        "pi 版本变了、SSE 解析不兼容 ⇒ 装回 0.99.1（见第 2 项）",
      ],
    },
    {
      name: "工具真被模型执行",
      run: async () => {
        const me = requireAgent();
        const env = await ensureEnv();
        const before = probeCalls;
        // 判据是**执行体里的闭包计数器**：模型没调工具它永远是 0，提示词写得再漂亮也过不了。
        // “二选一 + 必须调一次”是为了避开一个**不可控**变量：模型可以拒绝调工具。
        // 让它只能选「调哪个」而不能选「调不调」，这一项才不依赖模型的心情 —— 实测 3/3 稳（spike/t-forced；
        // 没有工具可调时模型会回纯文字，那种情况下 ran=0 是合理的）。
        const result = await me.io.prompt(
          "你现在必须调用工具一次：在 demo_probe 和 demo_probe_b 里任选一个，text 参数填「自检工具链」。" +
            "直接调用，不要只用文字回答。",
        );
        if (result.error) throw new Error(`这一轮报错：${result.error}`);
        const ran = probeCalls - before;
        if (ran < 1) {
          throw new Error(
            `两个探针的执行体一次都没跑（${before} → ${probeCalls}）：` +
              `tools.list() 里有没有它不算数，模型必须真的调用；且这是「二选一」，它有得选、没得拒`,
          );
        }
        return {
          detail: `探针的执行体真跑了 ${ran} 次（二选一）`,
          evidence: [
            `模型这一轮回读：${oneLine(result.text)}`,
            // 这一行是对照，不判别：定义在注册表里 ≠ 执行体跑过
            `对照（不判别）：pi 注册表里有它的定义 = ${me.tools.raw.getToolDefinition("demo_probe") ? "有" : "没有"}`,
          ],
        };
      },
      hints: [
        "模型没配合（没调工具 / 回空的）⇒ **真模型下偶发**，先重跑一次；连续两次才怀疑环境",
        "工具没进模型声明（白名单挡了 / `tools.custom` 没生效 / 名字对不上）⇒ 看上面打印的「pi 注册表里有它的定义」那一行",
        "prompt 中途报错（rate limit / 余额 / 网络）⇒ 看原始错误；这一个项目真的会打服务商",
      ],
    },
    {
      // 这一项**不跑模型**：纯粹查「环境里到底有什么」，所以它便宜、确定、不需要 provider。
      // 存在理由：agentDir 只要没被填过东西，skills/extensions 返回空**说明不了任何事** ——
      // 空可能是隔离做对了，也可能是这条发现路径压根没被走到。所以判据要**两边都成立**：
      //   ① 看得到**自己的**（demo/agent/ 里那份真文件）⇒ 自动发现这条路是通的；
      //   ② 看不到**宿主的** ⇒ 隔离真的生效。
      // 宿主 ~/.pi/agent 里通常有技能与插件，只满足①不满足②就是「用了电脑的设置」。
      name: "环境隔离：只认自己的技能与插件",
      run: async () => {
        const env = await ensureEnv();
        // 宿主目录（用来算「哪些是别人的」）；demo 自己从没读过它，这里也只是列举，不建 agent
        const hostAgentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        // 最直白的一条：demo 的 agentDir 不许是宿主 pi 目录本身
        if (
          env.agentDir === hostAgentDir ||
          under(hostAgentDir, env.agentDir) ||   // dir 在宿主里面（含相等）
          under(env.agentDir, hostAgentDir)      // 宿主在 dir 里面（更离谱）
        ) {
          throw new Error(
            `demo 的 agentDir 就是宿主 pi 目录（${env.agentDir}）—— 那等于「用了电脑的设置」，不是自己一套环境`,
          );
        }
        const lab = await ensureLab(env);
        const report = await lab.inspectEnv();

        // 判据是「与**宿主目录**比对」，不是「与 agentDir 比对」——
        // 后者有个致命盲区：agentDir 如果**就是**宿主目录（= 用了电脑的设置），
        // 那宿主的一切都算「自己的」，这一项会**通过**。实测踩到过（mutation M2）。
        // 所以这里比的是「有没有读到 hostAgentDir 底下的东西」——那才是「别人的」的定义。
        const inHost = (p: string): boolean => under(p, hostAgentDir);
        const ownSkills = report.skills.filter((sk) => !inHost(sk.filePath));
        const alienSkills = report.skills.filter((sk) => inHost(sk.filePath));
        const ownExts = report.extensions.filter((e) => !inHost(e.path));
        const alienExts = report.extensions.filter((e) => inHost(e.path));

        // ① 自己的那份必须看得到 —— 否则「空」是假阴性
        if (!ownSkills.some((sk) => sk.name === "env-style" && under(sk.filePath, env.agentDir))) {
          throw new Error(
            `看不到 demo 自己的技能 env-style：report.skills=${JSON.stringify(report.skills.map((x) => x.name))}` +
              `（agentDir=${env.agentDir}）`,
          );
        }
        if (!ownExts.some((e) => e.path.includes("env-tools") && under(e.path, env.agentDir))) {
          throw new Error(
            `看不到 demo 自己的扩展 env-tools：report.extensions=${JSON.stringify(report.extensions.map((e) => e.path))}` +
              `（agentDir=${env.agentDir}）`,
          );
        }
        // ② 别人的那份一个都不能有 —— 这才是「隔离」
        if (alienSkills.length || alienExts.length) {
          throw new Error(
            `环境里混进了不属于 demo 目录的技能/扩展：` +
              `skills=[${alienSkills.map((x) => `${x.name}@${x.filePath}`).join("、")}] ` +
              `extensions=[${alienExts.map((x) => x.path).join("、")}]`,
          );
        }
        // ③ 而且它注册的工具也必须只是自己那个（walker 的报错是「工具名对不上」，这里一次抓全）
        const envToolNames = report.extensions.flatMap((e) => e.tools ?? []);
        if (!envToolNames.includes("env_checklist")) {
          throw new Error(`demo 自己的扩展没注册出工具 env_checklist：${JSON.stringify(envToolNames)}`);
        }
        return {
          detail: `只看得到自己的 ${ownSkills.length} 个技能、${ownExts.length} 个扩展`,
          evidence: [
            `自己的：skills=[${ownSkills.map((x) => x.name).join("、")}] extensions=[${ownExts.map((x) => shortPath(x.path, env.agentDir)).join("、")}]`,
            `宿主的（一个都没读进来）：skills=[${alienSkills.length}] extensions=[${alienExts.length}] —— 对照目录 ${hostAgentDir}`,
            `自己的扩展注册的工具：${envToolNames.join("、") || "（无）"}`,
          ],
        };
      },
      hints: [
        "看不到自己的技能/扩展 ⇒ demo/agent/ 被清过：skills/env-style/SKILL.md 或 extensions/env-tools.ts 不在磁盘上",
        "混进了宿主的技能/扩展 ⇒ agentDir 指错了（检查 demo/env.ts 的 agentDir()，或有没有别的环境变量把它带偏）",
        "技能报 ENOENT ⇒ pi 要求 filePath 指向真文件：确认 demo/agent/skills/env-style/SKILL.md 真在磁盘上",
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
        const cut = await me.io.interrupt("七面 · io：interrupt 一次");   // 空闲时 = prompt
        if (!cut.text) throw new Error("io.interrupt 空闲时应当等价 prompt 并拿到文本");
        surfaces.push(`io（读 pending=${pending} / isRunning=${wasRunning}；写 queue + waitIdle + interrupt）`);

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
          // 会话太小、没东西可压 —— pi 的预期行为，按通过算，但要说出来。
          // 注意：这里验的是 compact 在**太小的会话上**的正常路径，「真把历史压短」没被验到
          // （examples/03 用 `[[huge:200000]]` 撑大历史验那条）。自检不塞 200KB 假文本是刻意的。
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
        // 档位必须从**这个模型实际支持的**里面挑，不能写死。
        // 实测差异：假模型 echo 只支持 off，而 space-bunny-free 支持 low/medium/high/xhigh/max —— **没有 off**。
        // （写死 "off" 会让真模式的自检失败，而且失败在「库的 setThinking 太严」这个错误结论上。）
        const levels = me.model.raw.session.getAvailableThinkingLevels();
        const pickLevel = levels.includes("high") ? "high" : levels[levels.length - 1]!;
        await me.model.set(env.altModel); // 假模式换到 reasoning:true 的那个；真模式是同一个
        me.model.setThinking(pickLevel);
        if (me.model.thinking !== pickLevel) {
          throw new Error(`setThinking("${pickLevel}") 之后读回来是 ${me.model.thinking}（可用：${levels.join("、")}）`);
        }
        await me.model.set(env.model);
        const backLevel = me.model.raw.session.getAvailableThinkingLevels()[0]!;
        me.model.setThinking(backLevel);
        surfaces.push(
          `model（读 current=${modelBefore}、thinking、available=${availableCount} 个；写 set=${env.altModel.split("/")[1]} + setThinking=${pickLevel}，再还原为 ${me.model.current?.id}/${me.model.thinking}）`,
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

        // permissions：写 gate（并让它真被调用一次）+ only / allow / deny 各一次。
        // deny / allow 用 tools.list() 读回 demo_probe_extra：**只有运行期 add 的工具才在 tools.list() 里**
        // （创建期 tools.custom 走 pi 的 customTools，不在那张表上），所以要有一个能读回状态的工具。
        // only 那档**不能**这么读回：demo_probe_extra 是上面 tools.add 显式激活的（add 本身就把它并进
        // 活跃集），only 就算是彻底的 no-op 它也照样 active —— 那条断言恒绿、不判别。only 是「精确就是
        // 这些」的那一档（白名单硬过滤），验的是**别的工具消失了**：reload 后活跃集应当只剩点名的那几个。
        me.permissions.gate(async (call) => {
          gateCalls += 1;
          void call;
          return undefined; // 放行：这一项验的是「门活着」，不是拦不拦得住
        });
        const isExtraActive = () => me.tools.list().some((t) => t.name === "demo_probe_extra" && t.active);
        await me.permissions.only(["demo_probe_extra"]);
        const onlyActive = [...me.io.raw.getActiveToolNames()].sort();
        if (onlyActive.length !== 1 || onlyActive[0] !== "demo_probe_extra") {
          throw new Error(
            `only(["demo_probe_extra"]) 之后活跃集应只剩 demo_probe_extra，实际 ${JSON.stringify(onlyActive)}`,
          );
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
        const gateResult = await me.io.prompt("[[tool:demo_probe_extra]]");
        if (gateResult.error) throw new Error(`审批门那一轮报错：${gateResult.error}`);
        if (gateCalls <= gateBefore) {
          throw new Error(`审批门一次都没被调用（${gateBefore} → ${gateCalls}）：gate 装上 ≠ 生效`);
        }
        surfaces.push(
          `permissions（写 gate 且真被调用 ${gateCalls} 次；only 后活跃集只剩它，deny/allow 用 tools.list() 读回）`,
        );

        return { detail: `${surfaces.length} 个面各至少一次读写`, evidence: surfaces };
      },
      hints: [
        "思考档不被支持 ⇒ 这一项现在会自动挑该模型支持的档；仍失败就打印可用档位与模型 id 对照着看",
        "`compact` / `only` / `allow` / `deny` 抛 busy ⇒ 有别的轮次在飞：先 `await io.waitIdle()` 再做（queue/steer 之后别漏等）",
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
      // 失败必须可诊断：哪一步 + 原始错误（含栈）+ 最可能的三个原因与怎么补。
      // 失败信息走 **stderr**（通过信息走 stdout）：自检要能写进 CI / 脚本，按流分流而不是混在一起。
      console.error(`${label} … 失败`);
      console.error(`    原始错误：${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        for (const line of err.stack.split("\n").slice(1, 9)) console.error(`      ${line.trim()}`);
      }
      console.error("    最可能的三个原因与怎么补：");
      step.hints.forEach((hint, i) => console.error(`      ${i + 1}. ${hint}`));
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
  console.log("八项全通过 —— 本机可以开始研究 agent 课题了。");
  console.log("下一步：node examples/01-first-agent.ts（最小演示）；失败时怎么读输出见 demo/README.md。");
}

await main();
