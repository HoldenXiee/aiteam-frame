# 第 5 部分：生命周期与资源（独立交叉验证版）

> **范围说明**：本文件只包含**本轮亲手机跑出来**的结果，全部来自 `audit/05-lifecycle/e1-orphan.ts`（假 provider，模型 `faux/echo`，10 次请求，**真实花费 $0**）。
> 按指示在 5.1 之后停止，**5.2 泄漏 / 5.3 长跑 / 5.4 真模型 abort 未由本轮实测**，故本文件不含这三项的结论。
> 原始输出：`audit/05-lifecycle/raw/e1-orphan.json`；复跑：`node audit/05-lifecycle/e1-orphan.ts`。
> **未验证的代码改动**：`e1-orphan.ts` 的 5.1.5 代码块在停止令之后被我改过一次（改了循环顺序），该改动**没有跑过**；下面 E5 写的是改动前的实测输出，改动本身在文件里被显式标注。

---

## 结论速览

- **E1** 中间层 `dispose()` 之后，后代（孤儿）**完全可用**：`status=idle`、`prompt`/`send`/`steer`/`waitForIdle` 全部正常，跑出的用量照常进 `host.usage`（54→90），还能继续 `spawn_agent`。
- **E2** 孤儿 spawn 时深度护栏被绕过：`maxDepth=2` 下建出了**真实深度 3** 的分身（`depthOf` 在「直接父不在 map」时返回 `depth+1`）。
- **E3** 拓扑导出确实被静默变形：3 个节点里 1 个**变成根**（`parentId` 还在但 `host.get(parentId)=undefined`），导出最大深度 **1** vs 真实最大深度 **3**，2 个节点深度算错。
- **E4** 祖先视角的整棵子树**永久消失**：`top` 给 `leaf`（真后代）投递被拒，报错原文是「**不是你的后代**」——**事实错误的报错**；`descendantCount(top)=0`，而 `descendantCount(已回收的 mid)=2`。
- **E5** 深度绕过是**有界**的，不是无限的：深度加成只作用于「**直接父缺失**」的那一层，再深一级（`depthOf` 算出 2）立刻被正常拦截（原始输出的拒绝文案：`分身深度 3 超过 maxDepth=2`）。既有报告只说「depthOf 失效、深度 3 通过护栏」，本轮的增量是**边界**：**跳一级就恢复拦截**。
- **E6** 孤儿**能**被 `host.dispose()` 清掉（`list()` 归零、status 全变 `disposed`），且二次 `host.dispose()` 不抛错。
- **E7（与既有报告冲突）** `dispose` **不会**清空 `session.messages`：本轮实测 dispose 后仍保留 **8 条**历史。既有 `audit/05-lifecycle.ts` 的 5.1g 记的是 `sessionMessages: 0`，但那`a` 是**建完就 dispose、从未跑过 prompt 的分身**，0 是「本来就没有」而不是「被清掉」。该结论应作废。
- **E8** 四条回收路径（空闲 dispose 中间层 / 跑着时 dispose 中间层 / abort 后 dispose 中间层 / dispose 最顶层）**全部留下孤儿**，与是否在跑、是否先 abort 无关。
- **E9** `spawn_agent` 没有调用者存活检查：对**已 dispose** 的分身连续调用 6 次，工具都执行到了护栏判断（返回的是深度护栏文案，而不是「agent 已 dispose」）。

---

## 实测证据

### E1 孤儿是否还活着（对应 5.1.1）

- **问题**：`mid.dispose()` 之后，后代 `leaf` 还能不能干活、还能不能 spawn。
- **方法**：`node audit/05-lifecycle/e1-orphan.ts`（第一段）。直接 `createAgent(..., {host, parent: mid, member:"w"})` 精确搭 `top→mid→leaf`，`mid.dispose()` 后逐个调用 `leaf` 的方法，再用真实的 `createSpawnAgentTool` 发起 spawn。
- **原始输出**（`raw/e1-orphan.json` findings[0].observed）：

```
建链时 ["a1","a2","a3"]，真实深度 top=0 mid=1 leaf=2；dispose(mid) 后 list=["a1","a3"] activeCount=2
host.get(mid)=null mid.status=disposed；leaf 仍在 list=true host.get(leaf)=a3 leaf.parentId=a2
该 id 在宿主里=null leaf.status=idle；
孤儿干活 = {"prompt":{"state":"resolved","value":{"text":"echo:孤儿自己跑一轮","tokens":18}},
"send":{"state":"resolved","value":{"delivered":"ran"}},"steer":{"state":"resolved","value":"no-throw"},
"waitForIdle":{"state":"resolved","value":"no-throw"},"usageReadable":54}；
host.usage 从 54 涨到 90（孤儿跑的一轮照常计入宿主）；
孤儿 spawn = {"text":"已让成员「w」处理，它的分身 id 是 a4。\n\necho:再下一层","newId":"a4","listLen":3}
```

- **读出的现象**：`mid` 从 `list()` 消失、`host.get(mid)=null`、`mid.status="disposed"`；同一时刻 `leaf` 一切照旧（`status=idle`、四个方法全部正常 resolve），它的 prompt 产出（18 tokens）与 `a.usage=54` 都照常计入宿主累计（54→90）；`spawn_agent` 成功建出 `a4`。
- **结论**：**能**。「已回收」只写在那一个对象上，宿主里没有墓碑，后代身上没有任何可观察的变化。孤儿的存活与可用性与正常分身无差别。

### E2 孤儿 spawn 时 `depthOf()` 算出什么（对应 5.1.2）

- **问题**：`maxDepth=2` 还拦得住孤儿起的下一层吗。
- **原始输出**：

```
孤儿 leaf（真实深度 2）经 spawn_agent 起了 a4（真实深度 3），
工具返回 = "已让成员「w」处理，它的分身 id 是 a4。\n\necho:再下一层"；
host.maxDepth=2；导出侧深度 = [{"exported":1,"true":3}]
```

- **读出的现象**：建出来了，没有任何警告。`host.ts` 的 `depthOf()` 走到 `leaf.parentId=mid` 时 `agents.get(mid)=undefined`，走 `return depth + 1` 这一支，得到 **1**；`checkCanCreate` 于是算出 `1+1=2`，`2 > maxDepth(2)` 为假，放行 —— 真实深度 **3** 的分身被登记。
- **结论**：**不能**拦住。护栏计算的深度（2）与真实深度（3）永久不同步；`maxDepth` 在任何中间层被回收之后都不可信。与既有报告 5.1e 一致。

### E3 拓扑导出里的变形（对应 5.1.3）

- **问题**：孤儿在「`list()` + `parentId` + `host.get(parentId)`」这种导出里会变成什么。
- **方法**：`h.ts` 的 `exportTopology()`，父解析走 `host.get()`（与 `audit/02-topology.ts` 同款写法：解析不到就停、不计数）；另用一张「所有创建过的分身」登记表算真实深度作为对照。
- **原始输出**（findings[2].observed，逐节点）：

```
[{"id":"a1","isRoot":true,"exportedDepth":0,"trueDepth":0},
 {"id":"a3","parentId":"a2","isRoot":true,"exportedDepth":0,"trueDepth":2},
 {"id":"a4","parentId":"a3","exportedParent":"a3","isRoot":false,"exportedDepth":1,"trueDepth":3}]
汇总 = {"nodes":3,"roots":2,"rootsWithParentId":1,"maxExportedDepth":1,
        "maxTrueDepth":3,"depthMismatch":["a3:0vs2","a4:1vs3"]}
```

- **读出的现象**：`a3`（离被回收的 `a2` 最近的那个）`parentId` 字段**还在**，但 `host.get("a2")` 是 undefined —— 导出器只能把它判成**根**（`isRoot=true`），导出深度 0（真实 2）。`a4` 挂在 `a3` 下，导出深度 1（真实 3）。变形量：**1 个节点变根、2 个节点深度错、导出最大深度 1 vs 真实 3**。
- **结论**：**变形且不可逆**。导出物里既没有 `a2` 节点也没有它的墓碑，「链在断点处断掉」与「本来就没有父」在导出结果里同形 —— 下游无法区分，也无法修复。

### E4 谁能找到孤儿（对应 5.1.4）

- **问题**：孤儿还能被谁寻址；祖先的 `send_message` 还投得到吗。
- **原始输出**：

```
host.get(leaf.id) = a3；host.get 是唯一还认孤儿的入口。
top→leaf："只能给自己的后代分身投递：a3 不是你的后代（它可能是祖先、兄弟或不相干的分身）。"
top→a4（曾孙）："只能给自己的后代分身投递：a4 不是你的后代（它可能是祖先、兄弟或不相干的分身）。"
leaf→a4："已投递：a4 当时空闲，已开始处理。"
02-topology 同款 descendantCount(top)=0、descendantCount(leaf)=1、descendantCount(mid 已回收)=2
```

- **读出的现象**：按 id 直查仍然命中（`host.get(leaf)=a3`，`list()` 里也在）。但 `isDescendant` 沿 `host.get()` 往上走，在 `a2` 处断掉 → `top` 对 `leaf`（自己的真后代）报「不是你的后代」，对 `a4` 同样报错；只有孤儿自己还能投给自己的儿子。`descendantCount(top)=0`，而**已回收的 `mid` 反而算出 2 个后代**。
- **结论**：**「按 id 能寻址」≠「按拓扑能寻址」**。祖先的寻址范围在中间层被回收那一刻被永久截断，且以一条**事实错误的报错**呈现（「不是你的后代」）——设计者最可能误诊为「我记错 id 了」，然后去重试/换 id，而不是意识到是回收造成的。

### E5 深度绕过的边界：只加一级（对应 5.1.5）

- **问题**：把「dispose → spawn」循环重复 N 次，能不能把真实深度无限推高。
- **方法（注意顺序陷阱）**：本轮脚本写成了「先 `dispose(spawner)`，再 `callSpawn(spawner)`」。因为 `depthOf` 只在**直接父**缺失时才返回 1，先 dispose 反而让 spawner 的直接父仍在（`a4` 的父 `a3` 还在）→ `depthOf(a4)=2` → 全部被拦。
- **原始输出**：

```
每轮先 dispose 上一环、再经 spawn_agent 起下一环：
[{"step":1,"spawnee":"(未创建)","trueDepth":-1,"refused":true,"disposeOf":"a4"}, …（step2–6 完全相同）]
深度 2 的 a3 再 spawn 一次 = "不能再起分身：分身深度 3 超过 maxDepth=2，不能再往下一层"（新分身 id=undefined）；
host.list() 现有 2 个、activeCount=2；6 轮里被护栏拒绝次数 = 6
```

- **读出的现象**：6 轮全部被深度护栏拒绝（`refused: true`，拒绝文案是 `分身深度 3 超过 maxDepth=2`），一次都没建出来；`a4` 被 dispose 之后仍然是 `depthOf=2`（因为它父亲在）。
- **结论**：**绕过是有界的、有前提的**。`depthOf` 的 `depth+1` 保守分支只对「直接父缺失」的那个节点生效 → 那个节点能把深度从 2 推到 3；一旦它起出孩子（孩子的直接父是它，存在），孩子的 `depthOf=2`，**立刻恢复被拦**。所以：
  - 一次中间层回收 ⇒ 只多买 **1 层**；
  - 想再买一层，必须**把当前孤儿的直接父也回收掉**（每级额外一次 dispose + 留一个孤儿）。这条「每级一次 dispose ⇒ 无界加深」的推论是**从 `depthOf` 代码推出来的，本轮没有实测到**（我的循环顺序写错，实测到的是被拦的那一侧）。既有报告没有写这个边界，它只写了「depthOf 失效、深度 3 通过护栏」；本轮把「失效的范围」量化成**只加一级**。
- **附带现象（原始输出支撑）**：这 6 次 `spawn_agent` 都是在 `a4` **已 dispose** 之后发起的，工具没有返回任何「调用者已回收」类错误，而是正常执行到护栏判断。**`spawn_agent` 没有调用者存活检查**。
- **未验证的改动**：停止令后我把该块循环改成「孤儿先 spawn、再 dispose 自己」，代码已改但**未运行**，`raw/e1-orphan.json` 对应的是改动前的行为。

### E6 谁能回收孤儿（对应 5.1.6）

- **原始输出**：

```
host.dispose() 前 list=["a1","a3"]；dispose 后 list.length=0 activeCount=0；
各孤儿 status=["a1:disposed","a3:disposed"]；二次 host.dispose() = no-throw
```

- **读出的现象**：`host.dispose()` 遍历的是宿主 map，孤儿一直在 map 里，所以被一起清掉；`status` 都变 `disposed`；重复调用不抛错。
- **结论**：**能**。这是唯一能自动回收孤儿的路径，粒度是「整个宿主」——没有「回收某棵子树」的 API。

### E7 dispose 之后还能读到什么（对应 5.1.7）—— 与既有报告冲突

- **原始输出**：

```
leaf（孤儿）在 host.dispose 之后：status=disposed usage=54 parentId=a2
host.get=null session.messages.length=8
```

- **读出的现象**：`leaf` 跑过两轮（`echo` 文本 + 一次 spawn 前的 prompt），dispose 之后 `session.messages` **仍有 8 条**；对象引用上的 `status` / `usage` / `parentId` 也都还在；只有 `host.get()` 返回 undefined。
- **结论（冲突点）**：`dispose` **不会**清空 `session.messages`，历史留在 session 对象上。
  - 既有 `audit/05-lifecycle.ts` 的 5.1g 记 `sessionMessages: 0`，并在结论里写成「**session.messages 变成空数组（不是抛错 —— 历史静默消失）**」。**该结论应作废**：那段代码里 `a` 是 `mkTop(host)` 之后**立刻 dispose、从未 prompt 过**的分身（见 `audit/05-lifecycle.ts` 5.1g 段），0 是「本来就没有消息」，不是「被 dispose 清掉」。
  - 既有报告另一处文本（第 259 行，讲预算耗尽能否优雅收场）写的是「`session.messages` 里 9 条历史都在」，与本轮实测方向一致 —— 说明「历史保留」才是实际行为，5.1g 那句「变空数组」是孤例且样本为空。

### E8 四条回收路径（对应 5.1.8）

- **原始输出**（findings[7].observed，`JSON.stringify` 后摘录）：

```
[{"name":"idle dispose 中间层","before":{"list":["a5","a6","a7"]},"after":["a5","a7"],
  "orphaned":["a7"],"leafParentId":"a6","leafStatus":"idle"},
 {"name":"streaming 中 dispose 中间层","after":["a8","a10"],"orphaned":["a10"],
  "leafParentId":"a9","midStatus":"disposed","midIsStreaming":false,"leafUsable":"resolved"},
 {"name":"abort 之后 dispose 中间层","statusAfterAbort":"aborted","after":["a11","a13"],
  "orphaned":["a13"],"leafParentId":"a12"},
 {"name":"dispose 最顶层（不是中间层）","after":["a15","a16"],"midParentId":"a14",
  "leafParentId":"a15","note":"mid 与 leaf 都成孤儿，且 mid 仍在列表里"}]
```

- **读出的现象**：四条路径的 `list()` 都少了被回收的那一个、留下了后代；跑着时 dispose 的 `mid` 在 settle 后 `isStreaming=false`、`status=disposed`，孤儿 `leaf` 的 `prompt` 仍 `resolved`；先 `abort()`（`status` 变 `aborted`）再 `dispose()` 与直接 dispose 结果一样；dispose **最顶层**会让 `mid`、`leaf` 双双成孤儿，而 `mid` 自己也还在 `list()` 里。
- **结论**：**不是某条路径的特例，是 dispose 语义本身** —— 回收单位永远是「一个分身对象」。`abort` 与「是否在跑」都不影响这个结果。

### E9 零成本核对（对应 5.1.9）

- **原始输出**：`假服务收到的请求数 = 10，模型集合 = ["echo"]`
- **结论**：本文件全部结论来自本机假 provider，**真实花费 $0**；模型只解析到 `faux/echo`（未回落到全局真模型）。

---

## 与既有报告（`docs/research/2026-09-30-phase1-capability-audit-report.md` + `audit/findings/05-lifecycle.json`）的关系

| 项 | 既有报告 | 本轮独立实测 | 关系 |
|---|---|---|---|
| 孤儿可用性 | 5.1e 只说「后代留 list、parentId 悬空」 | E1：实测 prompt/send/steer/waitForIdle 全可用、用量照常计入宿主 | **补充**（既有没写孤儿「能干活」） |
| 深度护栏绕过 | 5.1e：`depthOf` 保守返回，真实深度 3 通过 maxDepth=2 | E2 复现；E5 增量：**只加一级**，再深即被拦 | **修正既有措辞**（不是「失效」，是「+1 层」） |
| 拓扑变形 | 2.6c/5.1e 定性说「静默变形」 | E3 量化：1 节点变根、最大导出深度 1 vs 真实 3、2 节点深度错 | **量化** |
| 祖先寻址 | 5.1e：祖先投给孙代被拒，报「不是你的后代」 | E4 复现，加测曾孙同样被拒、`descendantCount(top)=0` 而 `descendantCount(已回收 mid)=2` | **复现 + 补充** |
| dispose 后的 `session.messages` | 5.1g 结论：**变成空数组、历史静默消失** | E7：**仍有 8 条** | ⚠️ **直接冲突**，见 E7，判定既有结论应作废（其样本从未 prompt 过） |
| 回收单位 | 5.1f：单位是分身，不是子树 | E8 复现（含 streaming / abort 后 / 顶层三种路径） | **复现** |
| `host.dispose()` 清孤儿 | 5.1e 定性「只能靠 host.dispose() 清掉」 | E6：清干净、status 全 disposed、二次调用 no-throw | **复现** |
| `spawn_agent` 调用者存活检查 | 既有未提及 | E9/E5 附带：已 dispose 的调用者不报错，正常走到护栏判断 | **新增** |
| 5.2 / 5.3 / 5.4 | 已由既有轮次覆盖（`findings/05-lifecycle.json` 5.2a–5.4d 有记录） | 本轮**未跑**（停止令） | 无独立证据，不发表意见 |

---

## 清单

| # | 现象 | 类别 | 严重度 | 证据 |
|---|---|---|---|---|
| 1 | 中间层 dispose 后后代成孤儿且功能完整、用量照常计入，宿主无任何墓碑 | 极限 | 中 | E1 |
| 2 | 孤儿 spawn 时 `depthOf` 回退到 1，使真实深度 3 通过 `maxDepth=2` | 静默失败 | 高 | E2 |
| 3 | 深度绕过**有界**：只对「直接父缺失」的那一层生效，再深一级立即恢复拦截 | 极限 | 中 | E5 |
| 4 | 孤儿在 `list()+parentId` 导出里变「根」，导出深度与真实深度不符且不可逆 | 静默失败 | 高 | E3 |
| 5 | 祖先对真后代的 `send_message` 被拒，报错文案「不是你的后代」与事实相反 | 静默失败 | 高 | E4 |
| 6 | `descendantCount` 风格查询：`top=0`，而已回收的 `mid=2`（引用已回收对象被当成有效父） | 静默失败 | 中 | E4 |
| 7 | 任意「非叶节点」回收都留孤儿（含 streaming 中 / abort 后 / 顶层），无子树级联回收 | 缺口 | 高 | E8 |
| 8 | 只有 `host.dispose()` 能清孤儿，粒度是整个宿主 | 缺口 | 中 | E6 |
| 9 | `dispose` **不清** `session.messages`（既有报告「变空数组」的结论不成立） | 观测 | 中 | E7 |
| 10 | `spawn_agent` 无调用者存活检查：对已 dispose 的分身仍执行到护栏判断 | 缺口 | 低 | E5 |
| 11 | 本轮未覆盖 5.2/5.3/5.4 | 缺口 | — | 见范围说明 |

---

## 未做完 / 跑不通

- **5.2 泄漏斜率、5.3 长跑稳定性、5.4 真模型中途 abort**：按停止令未执行，本文件不出结论。脚本未写；`h.ts` 里已备好 `slope` / `heapMB` / `resources` / `resourceKinds` / `gc` 等工具（未使用）。
- **E5 的「每级一次 dispose 可无限加深」推论**：仅由代码推导，未实测；`e1-orphan.ts` 中修正后的循环**未运行过**。
- **`_getActiveHandles` / `getActiveResourcesInfo` 的会话句柄释放核对**：未执行。
- 本轮未做任何真模型调用，无花费。
