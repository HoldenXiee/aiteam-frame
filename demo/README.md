# demo —— 一条命令，验完「这个库在我这儿装好了吗」

```bash
npm install          # 装依赖（Node ≥ 24）
npm run demo:env     # 只准备 + 体检环境：不花模型钱
npm run demo         # 全流程：环境 → 真模型 → agent 集群 → 对账（约 $0.003）
```

`npm run demo` 通过就说明：依赖能装、环境能自建、模型能通、集群能起。
失败时它给的不是堆栈，而是「哪一步没过 + 该怎么修」，并以退出码 1 结束。

## 它验了四件事

| 步骤 | 验的是什么 |
|---|---|
| 1 自建环境 | 凭证 / 技能 / 插件都从 `demo/env/` 生效，本机 pi 的东西一个都没混进来 |
| 2 真模型连通 | 真发一次请求：读文件 + 技能暗号 + 工作目录守则的暗号，三样都回来才算通 |
| 3 agent 集群 | 主持人从花名册挑人派活，三个工人共用一块黑板，产出真落盘 |
| 4 对账 | 7 个事件成对、`agent.usage` / `host.usage` 归属正确、三道护栏还在、级联回收干净 |

## 环境在这个文件夹里，不在你的 `~/.pi`

**别人不需要装 pi 就能跑这个 demo。** 整套环境就是 `demo/env/`，它和 `~/.pi/agent` 同构：

```
demo/
  run.ts                        入口：四步走 + 结论 + 退出码
  env.ts                        自建环境的准备与体检（也能单独跑）
  cluster.ts                    集群：花名册 + 主持人派活 + 观测接线
  log.ts                        打印与检查
  env/                          ← 这个 demo 自己的 pi 环境（agentDir）
    auth.json                   凭证（不进 git；见下）
    auth.json.example           手填模板
    skills/cluster-check/       技能：暗号「环境自检技能已生效」
    extensions/env-probe.ts     插件：自动发现，注册 env_probe 工具
  work/                         ← 工作目录（cwd），全队共用的黑板就在这
    AGENTS.md                   上下文文件：暗号「工作目录守则已加载」
    blackboard.md               侦察员写、核对员读（跑出来的）
    report.md                   书记员写下的结论（跑出来的）
    facts.txt                   连通性检查的输入（跑出来的）
```

## 凭证从哪来

按这个顺序找，找到哪个用哪个，并在输出里明确告诉你用的是哪个：

1. `demo/env/auth.json` —— 这个 demo 自己带一份（**不进 git**，`.gitignore` 里写着）
2. 本机装了 pi 的话，第一次跑会自动从 `~/.pi/agent/auth.json` 拷一份到上面那个位置
3. 都没有 → 二选一：
   - 照着 `demo/env/auth.json.example` 手写 `demo/env/auth.json`
   - 设环境变量：`OPENCODE_API_KEY=sk-...`（PowerShell：`$env:OPENCODE_API_KEY="sk-..."`）

换个模型跑：`DEMO_MODEL=opencode-go/glm-5.3-flash npm run demo`

## 花费与产物

默认 `opencode-go/deepseek-v4.1-flash`，一次全程约 4 万 tokens ≈ **$0.003**，跑完会打印实际数字。
产物留在 `demo/work/`（已在 `.gitignore` 里，只有 `AGENTS.md` 进版本库）。
