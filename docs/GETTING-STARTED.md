# 使用指导：第一次接手这个项目

面向**第一次开发本项目的人**。目标：**30 分钟内**能跑起来、能看懂、能开始研究 agent 课题。

> 如果你只想「验证这台机器能不能跑」，跳到 §2，一条命令。
> 如果你想动手改代码，从 §4 开始。

---

## 0. 这个项目是什么（一句话）

**aiteam 是一个 Agent 操控库**——基于 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，在运行期**读、改、拦截**一个 agent 的七个面：

| 面 | 管什么 |
|---|---|
| `io` | 投递（`prompt` / `queue` / `steer` / `interrupt`）、`abort`、`waitIdle`、**结算**（`RunResult`） |
| `context` | 读历史、改**这一轮发给模型的内容**、压缩、整段重置（`reset`） |
| `tools` | 有哪些工具存在（`list` / `add` / `remove`）、工具结果拦截 |
| `permissions` | 哪些工具**允许被调用**（`only` / `allow` / `deny`）、审批门 |
| `extensions` | 运行期加载 / 卸载插件，加载错误可读 |
| `skills` | 运行期按路径注入技能 |
| `model` | 换模型 / 换思考档，读当前与可用 |

**库不含任何政策。** 花名册、委派、护栏、红线都是**使用者代码**——想让 agent 拥有哪种集群形态，那是你的代码的事，不是库的字段。这不是省略，是立项理由：**这些假设必须可被替换、可被度量**，所以它们不能焊死在库里。

---

## 1. 环境准备

```bash
git clone <repo> && cd test
npm install        # 需要 Node ≥ 24（原生跑 .ts，无需构建）
```

**只需要两步。** 没有构建、没有代码生成、没有全局工具。

---

## 2. 第一件事：跑安装自检

```bash
node demo/check.ts        # 八项，不需要 API key，全程离线，零成本
```

预期结尾：

```
八项全通过 —— 本机可以开始研究 agent 课题了。
退出码=0
```

**这一步的价值**：它检查的是「**你这台机器具备研究条件**」——Node 与原生 `.ts`、pi 版本、环境可写、模型可读、能起 agent、**工具真能被模型调用**、七个面各自能读写。

失败了不要紧，输出会告诉你**哪一步 + 原始错误 + 最可能的三个原因**，例如：

```
[4/8] 用实验室起 agent                 … 失败
    原始错误：模型「nope/nope」解析失败：Model "nope/nope" not found. …
    最可能的三个原因与怎么补：
      1. 第 2 项已经告诉你 pi 版本不对（那一步先修）…
      2. 模型 ref 解析不到… ⇒ 删 `demo/run/` 再重跑
      3. `demo/work/` 不可写或被别的进程占着…
```

（**失败信息走 stderr、通过信息走 stdout**，方便你写进 CI 或脚本。）

### 想用真模型跑自检

```bash
AITEAM_DEMO_REAL=1 node demo/check.ts     # 用宿主 ~/.pi/agent 的真实凭证 + 一个免费模型
```

默认用 `opencode-go/space-bunny-free`（免费）。想换别的：`AITEAM_DEMO_MODEL=provider/id`。

**demo 用它自己的 key**（`demo/env/auth.json`，gitignored），**全程不读也不写宿主 `~/.pi/agent`**。
之所以强调这点：最初真模式直接指宿主目录，而 pi 的 auth 存储是**读-改-写整个 `auth.json`**，实测把宿主另外两个 provider 的凭证抹掉了。改过两次才对，细节见 `demo/README.md`。

---

## 3. 跑示例，看七个面长什么样

```bash
node examples/01-first-agent.ts     # 最小：起 agent、问一句、拿结果
node examples/04-tools.ts           # 运行期加一个工具，看它进模型声明
node examples/11-redline.ts         # v1 的「红线」假设，写成使用者代码
```

`examples/01`–`08` **一面一事**（最小用法）；`examples/09`–`11` 是 v1 三条假设的「**可被推翻的写法**」：

```
examples/
  01-first-agent.ts    io     起 agent、交办一件事、拿 RunResult
  02-events.ts         观测   七个事件，on 与 onAny
  03-context.ts        context 读历史 / 本轮覆盖 / 压缩 / 整段重置
  04-tools.ts          tools  运行期加工具
  05-permissions.ts    permissions 审批门 + 白名单
  06-resources.ts      extensions/skills 运行期加载
  07-model.ts          model  换模型 / 换思考档
  08-raw-escape.ts     raw    逃生口（全权、无护栏）
  09-roster.ts         【假设】预定义成员能约束 agent 的行为
  10-spawn.ts          【假设】委派给分身能扩展能力
  11-redline.ts        【假设】agent 不该能配置 agent
```

**全部可以 `node` 直接跑，离线、零成本**——它们自带一个本机假 provider。

### 09–11 怎么读

它们开头都写着：

```ts
// ⚠️ 这是一个【假设】，不是推荐做法：
//    「预定义成员能约束 agent 的行为」
//    库不提供它 —— 以下是把它作为使用者代码的一种写法。
//    要检验它，请删掉下面的花名册、让 spawn 的 role 接受任意字符串，跑同一个任务对比结果。
```

**最后那句是重点**：每条假设都给了你一个**具体的改法**。改一行、重跑、对比结果——这就是这个库存在的意义。

---

## 4. 跑完整例子：多个 agent 协作写报告

```bash
node demo/agent-team.ts                    # 离线、零成本
AITEAM_DEMO_REAL=1 node demo/agent-team.ts # 或换成真模型
```

它会起两个检索分身 + 一个写作员，跑完产出 `demo/work/report.md`。**七个面在流程里都有出场**，结尾会自证：

```
[6] 自证：七个面各自被调用了几次（数据来自计数代理，不是手写的数字）
    io            9  █████████
    context       2  ██
    tools         1  █
    permissions   1  █
    extensions    1  █
    skills        2  ██
    model         2  ██
    七面全部 ≥ 1 ✓
```

计数器是**代理拦出来的**，不是手写的数字——所以某个面悄悄没出场，这张表会红。

### 这个例子**不是**推荐架构

它每一处设计决策旁边都写着一行「**要检验这条，改成 X 再跑**」：几个 agent、怎么分工、要不要护栏、审批门拦什么。**它是你的起点，不是范本。**

### ⚠️ 真模型下有两处已知行为差异（实测）

1. **审批门可能一次都没机会拦。** 真模型读了 `role` 里的边界（「不动黑板」），**自己在会话里就拒绝了**，压根没调工具。
   这不是门坏了——它恰好展示了**护栏的顺序**：`role` 是**软约束**（靠模型配合），`gate` 是**硬约束**（靠代码，模型不配合也拦得住）。
   想看到门真的拦下：把 `role` 里的「不动黑板」删掉再跑。demo 会打印这一行提示。
2. **真模型可能自行增删小节。** 它比假 provider 灵活——你要求三节，它可能给你五节。

---

## 5. 动手改：从哪读起

```
src/index.ts          唯一导出入口（不做逻辑）：createLab + 类型
src/agent/
  lab.ts              createLab：环境所有者与唯一启动入口（agentDir / cwd / createAgent / inspectEnv）
  create-agent.ts      agent 的创建路径（只经 lab.createAgent 到达）
  bridge.ts           面 = pi 扩展钩子的分组封装（派发器、专属槽位、reload）
  types.ts            对外契约（AgentSpec / Agent / 七个 Surface）
  loader.ts           skills / extensions / role 的注入与解析
  env.ts              环境自检的实现（lab.inspectEnv，只读）
src/surfaces/         七个面的实现
docs/DESIGN.md        **宏观设计（唯一设计源）**：为什么是这样
docs/GUIDE.md         用法讲解：每个面怎么用（不贴代码，指向 snippets.ts）
docs/FACTS.md         已实测核对的 pi 行为（这个文件必须准）
```

**推荐顺序**：先 `docs/GUIDE.md`（怎么用）→ 再 `docs/DESIGN.md`（为什么）→ 有疑问查 `docs/FACTS.md`（pi 的实测事实）。

**注意 `docs/GUIDE.md` 不贴代码**——它指向 `examples/lib/snippets.ts` 里的**真函数**。那些片段是**从源文件原文切出来的**，并且会被 `tsc` 检查：库 API 一变就编译不过。手抄的代码会漂移，而**漂移的文档比没有文档更坏**。

---

## 6. 日常开发命令

```bash
npm test              # 120 例断言，本机假 provider，零 API 成本
npm run typecheck     # tsc --noEmit（含 src / test / demo / examples）

node demo/check.ts                    # 安装自检（离线）
AITEAM_DEMO_REAL=1 node demo/check.ts # 安装自检（真模型）
```

**测试不需要 API key、不联网、零成本。** 全部断言跑在本机假 provider 上（`examples/lib/faux-server.ts`）——它按提示词里的脚本约定回话：

```
[[tool:NAME]]        让模型发起一次 NAME 的工具调用
[[args:{...}]]       给 [[tool:NAME]] 指定参数
[[call:NAME {...}]]  一次回复里发多个工具调用
[[sleep:MS]]         延迟回包（制造「正忙」窗口）
[[fail]]             回 HTTP 400（验证错误路径）
[[huge:BYTES]]       回超大文本（验证上下文/用量）
```

所以要断言「模型真的调了工具」「生成期是忙的」这类事情，**不需要真模型，也不需要花钱**。

---

## 7. 三条纪律（这个项目踩过坑才有的）

**① 断言必须有判别力。** 一条在实现之前就绿的用例不是钉子，是装饰。
本项目出过 4 次假测试：恒绿的（pi 自己的文案里恰好含关键词）、空函数体的、换「它自己」与没换不可区分的、靠 pi 自带兜底满足的。

**② 凡声称的判别力，必须能被别人独立复现。**
证据失效有三种形态：**虚假**（报告里的 mutation 复现不出来）、**不可复现**（描述压缩成一个动词，按字面读方向是反的）、**说谎的文档**（「已实测核对」的文件里记了没实测的事实）。
所以：mutation 声明要写「**把什么改成了什么**」，不要压缩成一个动词。

**③ 修复本身会引入缺陷。** 本项目已发生 3 次（删了一段「看起来没用」的代码、把「静默半应用」修成「半应用 + 抛错」、把注释写得比事实绝对）。
所以**每轮修复都必须复审**——不是流程洁癖，是已验证的失效模式。

---

## 8. 常见问题

**Q：一定要有 API key 吗？**
不要。默认全部离线、零成本。只有 `AITEAM_DEMO_REAL=1` 才用真凭证。

**Q：`demo/run/` 和 `demo/work/` 是什么？**
`demo/run/faux/` 是 demo 自己写的模型配置（假 provider 模式；真模式是 `demo/run/real/`），`demo/work/` 是产物目录。**两者都不进 git**（`demo/env/` 是你给的配置源，那份 `auth.json` 可能含真实密钥，同样不进 git）。删掉它们再跑，`ensureEnv()` 会重建。

**Q：改坏了怎么办？**
`rm -rf demo/run demo/work && node demo/check.ts`——环境是幂等重建的。

**Q：`audit/` 去哪了？**
那是 v1 的能力与极限审计（208 文件），库的机制层在 v2 重写过，其结论多数不再成立，已删除。需要时从 git 历史 `043dea3` 检出。

**Q：这是一个成熟的框架吗？**
不是。它是一个**研究工具**——机制层完整（七个面），**策略层刻意留空**。它不承诺安全边界：pi 没有内置沙箱，`permissions.only` 只是工具集裁剪，扩展与 `bash` 可以绕过它。本库提供的是**能力裁剪 + 拦截**，不是权限系统。
