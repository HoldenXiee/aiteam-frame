# 第 1 部分：配置能力（独立复测，范围 1.1 字段生效性）

**状态**：调研被中止。本文件**只写我亲手跑出原始输出的部分**。
- ✅ 已实跑：`e1-fields.ts`（1.1 的 12 个字段 × 13 条断言）→ `data/e1-fields.json` → `data.json`
- ⏸️ 未执行（脚本已写好但按要求停止，无原始输出，故本文件不写结论）：`e2-priority.ts`（1.2 三层优先级 / 数组替换 / 显式 undefined 陷阱 / spawn 共享引用），以及 1.3–1.9 与全部真模型项。
- 花费：**$0.00**（全部走本地假 provider；真模型项未执行）

跑法：`cd /d/space/aiteam/test && node audit/01-config/e1-fields.ts`

**方法说明**：ground truth 不是库的 API 返回值，而是 `_cap.ts` 包 `globalThis.fetch` 抓到的**原始请求体**（`model` / `tools` / `messages` / `reasoning_effort` 等），比 `test/faux-server.ts` 记录的字段更全。`cwd` 一项用的是「真实 read 工具读到哪个目录的文件」。

---

## 结论速览

- **E1** `description` 不进自己的 system，只出现在 `spawn_agent` 的工具描述里（生效，用途正确）。
- **E2** `cwd` 生效：相对路径的 `read` 真的落到 `spec.cwd`（读到 A 目录内容、读不到 B 目录）。
- **E3** `agentDir` 生效：换目录后请求里的 `model` 变成另一份 `models.json` 的模型（按 agentDir 各一份 runtime）。
- **E4** `role` 生效：pi 默认提示词保留，role 追加在 `<tools>` 之后（偏移 171 vs 2610），是 system 的最后一段。
- **E5** `skills` 四种写法（名字 / 目录 / `SKILL.md` / Skill 对象）全部进 system；**技能正文不预载**，system 里只有 name+description（正文要不要读由模型自己决定）。
- **E6** `extensions` 路径与内联工厂都生效（不给 `tools` 时两把工具都进请求）。
- **E7** `tools` 白名单并入规则复测成立：并入 customTools ✅、设计者声明的扩展工具 ✅、agentDir 里自动发现的**用户级**扩展 ❌。
- **E8** 只给 `excludeTools` 不给 `tools` 时剔除生效；但**不给白名单时 agentDir 里的用户级扩展工具会静默进入默认工具集**（实测 `user_ext_probe` 出现在请求里）。
- **E9** `customTools` 静态与工厂都生效，但**工厂在创建期读 `ctx.agent` 会抛错**（`工具上下文里的 agent 尚未构造完成`）；只有 `execute` 内惰性读才拿得到。类型签名不提示这个时序限制。← 未见于既有报告
- **E10** `model` 生效；`"faux/echo:high"` 的后缀被正确拆掉（请求 `model=echo`）。
- **E11** `thinking` 生效：不只落到 session，**请求体里真的出现 `reasoning_effort:"low"/"high"`**，`off` 时该字段完全不存在。← 既有报告只核了 session 属性
- **E12** `thinking` 在 `reasoning:false` 的模型上被静默夹回 `off`（不报错）。
- **E13** `onToolCall` 生效：拿到真实 `{name,input}`，拦截后工具以错误结果结束且**未执行**（对话里无 read 的真实输出）。

---

## 实测证据

### E1 `description`
- **问题**：是否只进花名册、不污染自己的 system？
- **方法**：`e1-fields.ts` F1；对比 `spawn_agent` 的 `description` 字符串。
- **原始输出**：
  ```
  ✓ OK [1.1-F1] description 生效吗（是否只进花名册、不污染 system）
       现象：system 含标记=false；spawn_agent 工具描述含标记=true
  ```
- **读出的现象**：成员自己的 system 里没有标记；`spawn_agent` 的工具描述里有。
- **结论**：**能**。`description` 的唯一通道是上级 agent 看到的花名册文本。

### E2 `cwd`
- **问题**：只是改了 `sessionManager` 的字段，还是工具真的按它解析相对路径？
- **方法**：两个目录各放 `probe-cwd.txt`（内容 `CWD-MARK-999-in-A` / `CWD-MARK-888-in-B`），`tools:["read"]`，让模型调 `read "probe-cwd.txt"`，再看下一轮请求里的 tool 结果。
- **原始输出**：
  ```
  ✓ OK [1.1-F2] cwd 生效吗（相对路径的工具真的落到那个目录吗）
       现象：session.getCwd()=C:\Users\Holder\AppData\Local\Temp\aiteam-audit-NXEzFV\cwd-A；
             read "probe-cwd.txt" 拿到 A 目录内容=true、B 目录内容=false
  ```
- **读出的现象**：工具结果里出现了 A 目录文件的内容，没有出现 B 的。
- **结论**：**能**，且是真的生效（不只是 API 值）。

### E3 `agentDir`
- **原始输出**：
  ```
  ✓ OK [1.1-F3] agentDir 生效吗（决定读哪份 models.json / auth.json / skills）
       现象：主环境模型 id=echo；换成第二个 agentDir 后请求 model=another-model
  ```
- **结论**：**能**。换 `agentDir` 真的换了 provider/models 来源（按目录缓存 runtime）。

### E4 `role`
- **原始输出**：
  ```
  ✓ OK [1.1-F4] role 生效吗（追加到 system 的什么位置、默认提示词还在不在）
       现象：含角色标记=true（偏移 2610）；含 <tools>=true（偏移 171）；system 长度=2710
       数据：{"iRole":2610,"iTools":171}
  ```
- **读出的现象**：`<tools>` 在 171，role 在 2610，system 末尾。
- **结论**：**能**。走 `appendSystemPrompt`，默认 pi 提示词整段保留，role 是最后追加，**不能替换**默认提示词。

### E5 `skills`
- **方法**：四种写法各注入一个技能；另在一个技能正文里写 `SKILL-BODY-SECRET-5150`，看它是否出现在 system。
- **原始输出**：
  ```
  ✓ OK [1.1-F5] skills 生效吗（名字 / 目录 / SKILL.md / Skill 对象四种形式）
       现象：system 含 by-name=true by-dir=true by-file=true；含技能正文 SKILL-BODY-SECRET-5150=false；system 长度=3665
  ```
- **读出的现象**：三种命名的技能名都进了 system；**正文一个字都没进**。
- **结论**：**能**（四种写法）。但要知道代价与语义：注入的是「目录」（name+description），正文是**按需读**——这直接决定了 1.7（真模型会不会真的用上技能）不能靠 system 断言，必须看模型有没有去读文件。

### E6 `extensions`（路径 + 内联工厂）
- **原始输出**：
  ```
  ✓ OK [1.1-F6] extensions 生效吗（路径 / 内联工厂，且不给 tools 白名单时）
       现象：模型收到的工具 = ["read","bash","edit","write","ext_path_probe","ext_inline_probe"]
  ```
- **结论**：**能**，两种形式都在不给 `tools` 时自动挂上。

### E7 `tools` 白名单的并入规则
- **方法**：`tools:["read"]` + `customTools:[ct_merged]` + `extensions:[declared_ext_probe]`，同时在 `agentDir/extensions/` 放一个自动发现的 `user_ext_probe`。
- **原始输出**：
  ```
  ✓ OK [1.1-F7] tools 白名单的并入规则（customTools? 设计者声明的扩展? 用户级扩展?）
       现象：tools=["read"] + customTools=[ct_merged] + extensions=[declared_ext_probe] + agentDir 里有 user_ext_probe
             → 实际 = ["read","ct_merged","declared_ext_probe"]
  ```
- **读出的现象**：`user_ext_probe` 不在请求里。
- **结论**：**能**，决策 #4 的规则成立：只在 `tools` 非空时并入 customTools 与**设计者声明的**扩展工具名；环境碰巧存在的扩展撑不开白名单。

### E8 `excludeTools`
- **原始输出**（两次运行，同一条配置，唯一差别是 agentDir 里有没有 `extensions/user-ext.ts`）：
  ```
  # 干净 agentDir（无 extensions 目录）
  ✓ OK [1.1-F8] excludeTools 生效吗（只在给 excludeTools、不给 tools 时）
       现象：excludeTools=["write","edit"] → ["read","bash"]

  # 同一配置，但 agentDir/extensions/ 里有一个自动发现的 user-ext.ts
  ✓ OK [1.1-F8] excludeTools 生效吗（只在给 excludeTools、不给 tools 时）
       现象：excludeTools=["write","edit"] → ["read","bash","user_ext_probe"]
  ```
- **读出的现象**：`write`/`edit` 两次都被剔除；但**agentDir 里自动发现的扩展工具会进入默认工具集**。
- **结论**：**部分能**。剔除本身生效；但「不写 tools」≠「只有内置四把工具」——环境里的扩展会静默参与。要做可预测的能力裁剪，必须显式写 `tools` 白名单。

### E9 `customTools`（静态 vs 工厂）—— 新增边界
- **方法**：一个静态工具、一个在工厂**体内同步**读 `ctx.agent.id` 的工厂、一个在 `execute` 内惰性读的工厂。
- **原始输出**：
  ```
  ✓ OK [1.1-F9] customTools 生效吗（静态对象 vs 工厂函数；工厂在创建期能不能读 ctx.agent）
       现象：工具 = ["read","bash","edit","write","ct_static","ct_eager","ct_lazy"]；
             工厂创建期读 ctx.agent 抛错=["工具上下文里的 agent 尚未构造完成"]；
             execute 里读到的 agent.id=["a10"]（真实 id=a10）
  ```
  未修正前的原始崩溃（保留了现场）：
  ```
  Error: 工具上下文里的 agent 尚未构造完成
      at get agent (file:///D:/space/aiteam/test/src/agent/create-agent.ts:104:32)
      at factory (file:///D:/space/aiteam/test/audit/01-config/e1-fields.ts:214:26)
      at createAgent (file:///D:/space/aiteam/test/src/agent/create-agent.ts:113:51)
  ```
- **读出的现象**：工厂函数在 `createAgent` 内部被调用（`create-agent.ts:113`），此时 `holder.agent` 还没赋值；`ctx.agent` 的 getter 直接抛错。`execute` 时 agent 已就绪，能拿到 `a10`。
- **结论**：**部分能**。类型 `AgentToolFactory = (ctx: AgentToolContext) => ToolDefinition` 里 `ctx.agent` 是非可选的 `ControlledAgent`，但创建期访问它必然抛错——类型不提示这个时序，写工厂时容易踩。**未见于既有报告**（既有 1.1l 只说「两种都生效」）。

### E10 `model`（含 `:thinking` 后缀）
- **原始输出**：
  ```
  ✓ OK [1.1-F10] model 生效吗（含 `:thinking` 后缀的写法）
       现象：model="faux/smart" → 请求 model=smart；model="faux/echo:high" → 请求 model=echo；session.thinkingLevel=off
  ```
- **读出的现象**：带 `:high` 的写法没有把 `echo:high` 当成模型 id 发出去。
- **结论**：**能**。后缀被正确识别并消费。注意 `thinkingLevel=off` 是 E12 的能力位夹取，不是后缀没解析。

### E11 `thinking` —— 请求体 ground truth
- **方法**：同一 `reasoning:true` 模型，`thinking: off / low / high`，抓原始请求体。
- **原始输出**：
  ```
  ✓ OK [1.1-F11] thinking 生效吗（session 档位 + 是否真的改变了请求体）
       现象：{"off":{"session":"off","bodyFields":{}},
             "low":{"session":"low","bodyFields":{"reasoning_effort":"low"}},
             "high":{"session":"high","bodyFields":{"reasoning_effort":"high"}}}
  ```
- **读出的现象**：`low`/`high` 时请求体出现 `reasoning_effort`；`off` 时 `reasoning_effort`/`thinking`/`enable_thinking` **三个键都不存在**。
- **结论**：**能**，且是真的改了下发给 provider 的参数（不只是 session 上的一个属性）。这是既有 1.1n 的加强证据（既有只读了 `session.thinkingLevel`）。

### E12 `thinking` 的能力位夹取
- **原始输出**：
  ```
  ~PART [1.1-F11b] thinking 在 reasoning:false 的模型上会怎样
       现象：reasoning:false 模型 + thinking=high → session.thinkingLevel=off
  ```
- **结论**：**不能（但静默）**。模型能力位是天花板，超出的档位被夹回 `off`，构造不抛错、运行不报错。

### E13 `onToolCall`
- **原始输出**：
  ```
  ✓ OK [1.1-F12] onToolCall 生效吗（能拿到 name/input、拦截是否真的阻止执行）
       现象：门收到=[{"name":"read","input":{"path":"probe-cwd.txt"}}]；tool_end=["read:true"]；
             拦截理由出现在对话里=true；read 的真实输出出现在对话里=false
  ```
- **结论**：**能**。门拿到真实 `name` 与解析后的 `input`；拦截后工具未执行，目标以错误结果结束，理由可进入对话。

---

## 与既有报告的关系（交叉验证）

既有报告：`docs/research/2026-09-30-phase1-capability-audit-report.md` + `audit/findings/01-config.json`（另一轮，1.1a–1.4d 共 31 条）。

**独立复现且数字一致**：
- `role` 偏移量完全一致：`<tools>`=171、role=2610（既有 1.1d）。两次独立运行的 system 提示词长度稳定，说明 system 前缀是确定的。
- `description` 不进 system（1.1a）、`cwd` 生效（1.1b）、`agentDir` 生效（1.1c）、白名单并入规则、`excludeTools` 生效、`tools:[]`/模型名解析抛错等 —— 与我 E1/E3/E4/E7/E8 同向。
- `thinking` 被能力位夹取（既有 1.1n，我 E12）一致。

**我这边的新增（既有报告未覆盖）**：
1. **E9**：工厂式 customTool **在创建期读 `ctx.agent` 必抛错**，只有 execute 内惰性读可用；类型不提示。
2. **E11**：`thinking` 的 ground truth 是**请求体里的 `reasoning_effort`**；`off` 时该键不存在。（既有只核 session 属性。）
3. **E5**：技能**正文不预载**——system 里只有 name+description。这决定了「技能是否被用上」必须看文件读取行为，不能看 system。
4. **E8**：不给 `tools` 时，`agentDir` 自动发现的扩展工具会进入默认工具集（`user_ext_probe` 出现在请求里）。既有 1.1k 的观测里没有这一项。

**与既有报告冲突**：**未发现**。在我实际跑过的 13 条上，与既有 11 条重叠项全部同向，无相反结论。

**未能交叉验证/未执行**：
- 既有 1.3c 称「`extensions` 路径不存在 → 构造成功、静默忽略」，与 `loader.ts` 里 `additionalExtensionPaths` 的用法有关，但**我这轮没有跑**（`e2-priority.ts` 也含此计划项），故不表态。
- 既有 1.2e 称 spawn 子分身不继承父的 `cwd`/`agentDir`/`model`（实测打到真实 provider 拿了 402）。我**没跑** 1.2，不表态。

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | 工厂式 customTool 在创建期 `ctx.agent` 抛「工具上下文里的 agent 尚未构造完成」；类型不提示 | 极限 / 静默陷阱 | 中 | E9 |
| 2 | 不给 `tools` 时，agentDir 自动发现的扩展工具静默进入默认工具集 | 静默失败 | 中 | E8 |
| 3 | `thinking` 档位被模型能力位夹掉，不报错 | 静默失败 | 低 | E12 |
| 4 | 技能只注入 name+description，正文不预载；「用没用上技能」无法从 system 判断 | 能力（需知边界） | 低 | E5 |
| 5 | `role` 只能追加在 system 末尾，无法替换/前置默认提示词 | 能力 | 低 | E4 |
| 6 | `tools:[]` / `:thinking` 后缀 / 白名单并入规则均按设计生效 | 能力 | — | E7/E10 |

> 1.2（三层优先级、数组整体替换、显式 `undefined` 覆盖上层、spawn 共享引用）与 1.3–1.9、真模型部分：脚本 `e2-priority.ts` 已就绪但**未执行**，本文件不出结论。
