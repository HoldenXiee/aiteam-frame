# 第 1 轮补测 · 干净上下文自审

被审：人的产能线-上限还是指标-补测.md + 提案-并发集群共用工作区会互相删数据.md

审查完成。我逐条核实了源码、site 产物、jsonl、salvage 快照与 git 历史。结论如下。

---

## ① 站得住的结论（我亲自复算/读源码）

**1. (a) `judgeVoucher` 的 ok 定义（`bench/tasks-voucher.ts:110-150`，逐字读）**
- `ok = 无漏推 ∧ 无误推 ∧ (handled∪escalated 的 id 数 ≥ 24)`。
- `precision = (esc.size − wrongEsc)/esc.size`；`wrongEsc = shouldSelfHandle ∩ escalated`；`humanQueue = esc.size`。
- 判据**只看路由（哪些 id 放哪边），完全不校验 `verdict` 是"通过"还是"驳回"**。所以文中 §3 的"18/18 驳回"是判据之外的东西。
- 对 `budgetrem-10-r3` 我离线重判：`ok=false, Q=8, missed=1, wrong=3, precision=0.625` —— 与 jsonl 落盘一致（我用 site 产物独立重判了全部 21 条，`mismatches=0`）。

**2. (b) `budgetrem r3` 的 3 次误推确为同一张单的副本 —— 成立**
`site-round1/budgetrem-10-r3/vouchers/V3.txt = V7.txt = V23.txt`，三者逐字相同（`餐饮费 12800 元，2026-03-01，团队聚餐`）。去重后 `wrongDistinct=1`。文中的"1 个错误决定，不是 3 个"是对的。

**3. (c) 大部分数字可复算**
- Q 逐轮、wrong、recall、`ok`：全部可由 site 复算，与 jsonl 一致。
- token 合计 **3,146,119**：budget10(52,788+871,103+233,868+237,045) + budgetrem(241,757+428,265+89,738) + none(481,317+259,321+250,917) = 精确命中。
- budget10 `53k/871k/234k/237k = 16.4×`：✓（871/53=16.4）。
- `Fisher p≈0.2`（0/12 vs 1/3）：✓，我复算 two-sided = 0.200。
- §3 表"静默放行 0/4、1/8、3/12、0/18"：✓ 逐条复算一致（通过项只出现在 budget4-r1 的 V4 与 budget2-r4 的 V4/V8/V24）。
- none `18/18 驳回、静默放行 0`：✓（r1/r2 的 site 重判 + r3 的 jsonl 均如此）。
- "全库唯一一次 precision<1 = budgetrem r3"：✓（在册记录里其余全 1.00）。

**4. 提案的装置缺陷 —— 源码逐条核实成立**
- `bench/lab-1.ts`：`const cwd = join(LAB1, "work")`（硬编码共享）；
- `work/run-round1.ts`：`outFile` 固定文件名 + `if (arg("fresh") !== "0") writeFileSync(outFile,"")`（默认清空）+ `armSpec ?? "queue:4,budget:4,budget:2"`（默认 arms）；
- `research/demox/env.ts`：`agentDir` 单份共享；
- `src/agent/lab.ts`：`createLab` 只有 `agentDir`/`cwd`，无 per-instance scratch / claim。
事故现场也自洽：`SALVAGE-now.jsonl` = 2 行（none-r3、queue-4-r1）；`SALVAGE-before-restore…jsonl` = 3 行；`runs/mine/jsonl-snapshot-0002.jsonl` = 16 行（=salvage + git 回填 12 + budget10-r2）；现 jsonl 21 条，恰好缺 `budget10 r1 / none r1 / none r2` 3 条。**"装置换一个实例就复现"这条站得住**。

---

## ② 有问题的结论（逐条，说为什么）

**1. ★ `budgetrem` 的 precision=0.85 是错的。** `judgeVoucher` 给的是 **0.625**（Q=8, wrong=3）；按"不同单据"去重才 0.875。既不是 0.85，也不是"判据一字未改"该产出的数。文中表格和 JOURNAL 都写了 0.85 —— 一个声称用同一判据的读数，报了判据不产生的值。

**2. ★ §做法4「15 轮里唯一的质量事故就是误推，只盯 precision 就够」自相矛盾且失实。**
- 只算 `budget4+2+10+budgetrem` 这 15 轮，`ok=false`（漏推）的有 **9 轮**：budget4 4/4、budget2 r1/r2/r4、budget10 r1、budgetrem r3。
- 补测自己的 §3 正是拿"漏推软单"算的静默放行率 —— 用 precision 根本看不到这块。主成果也把漏推当作 cap 的核心代价（H2）。所以"唯一事故=误推"是丢掉 recall 后的自我安慰。

**3. 「约 1,900s」高估。** 10 轮 secs 实为 **≈1,560s**（jsonl 逐条 + log 补的 budget10 r1=36、none r1=307、none r2=136）。差 22%。

**4. 「queue 中位 105k」不是中位。** queue-0 四轮中位 **156k**；含两条 queue-4 的 6 条中位 98k；105,377 只是 queue-0-r4 的单值。主成果报的 queue 均值 151k 反而对得上。

**5. 「Pearson 0.854，n=18」样本标注过期/含糊。** 我在当前 21 条上算 = **0.853**；只有"剔除全部 3 条 budgetrem"的 18 条子集才 = 0.8543。也就是说这个统计是在 budgetrem 还没进 jsonl 之前算的，写文时没更新；而"全库"现在其实有 21 条（还含 2 条来自**默认 arms 的 queue-4 外来记录**，被并入同一文件）。

**6. ★ 「打破/证伪放行率随额度收紧上升」越界。** `none` 是**另一套提示**（明令"所有单放 handled、escalated 留空"，recall 构造为 0），不是同一条剂量轴的端点。"18/18 驳回"不能证伪 budget 臂内的 0%→12.5%→25%。要证伪需要**同一 budget 提示、quota=0/1** 的对照——没做。

**7. 标题「它是上限」过强。** `budget2 r3` 在额度=2 时推了 6（超发），`budget10 r1` 又只推 5。所以是"额度≥需求时不凑数"的**软上限**，不是"上限"。正文/主成果都说"不是硬约束"，标题与正文自相矛盾（纪律③应适用于自己的标题）。

**8. ★ 最关键：「需求=6」与 cap 结论被 V12 语料缺陷污染，补测完全没做剔除。**
- `budget10 r1`（Q=5）唯一漏的就是 **V12**；`budgetrem r3` 漏的也是 V12。V12 正是自家《考卷缺陷-V12软硬混杂污染路由判据.md》定性为"语料把正确驳回记成漏推"的那张单，该文并明确要求"引用本批数据前先做剔除敏感性"。
- 补测既没剔除、也没引用该文，就把 Q=5 当成纯"cap/需求≈5–6"的证据。
- 另外"6 张软单"实为 6 个 id、**只有 5 个不同文本**（V8=V24 逐字相同）。所以 §做法5 要求"报错误数前按不同单据去重"，却**没有对 Q/需求做同样去重**。

**9. 「3 张是不该推的硬规则违规单」定性不干净。** `RULES.md` 里根本没有"餐饮费"这个科目（只有"业务招待费"），模型"未列入规则科目、无法确定限额"的推理**是可辩护的**。其余 4 个臂都把 12800 直接驳回了，所以确有措辞差异线索；但把一次可辩护判断当成"明确的误推"，与 V12 是同一类"规格/映射缺口"，不能算干净的模型错误。

**10. 「单变量、只换措辞」不严格。** `budget10` 与 `budgetrem` 的提示不止额度句不同：budgetrem 多了一句"你判不了的单据放 `escalated` 推给人"，budget10 模板里没有。所以不是单变量对照（`round1c.md` §3 声称"只差一句话的方向"）。

---

## ③ 它漏了什么

1. **没做 V12 剔除后的复算**（sister 产物已经给了 recall* 数，补测零引用）。
2. **没有同提示的低额度端点**（quota=0/1），拿结构不同的 `none` 充当端点。
3. **`budgetrem` 没有复现**（n=3，只有 1 个异常轮，Fisher 不显著），却已写进 ★★ 级"做法"。
4. **没有第二任务形状**（纪律要求≥2 形状）。
5. **没自查判据漏洞**：`ok` 不校验 verdict 对错；往 `escalated` 塞**不存在的 id** 只会轻微稀释 precision、**永远不会被判错**（Q 反而变大）；`产出完整`用的是 `hnd.size+esc.size≥24`，同一 id 两边都写也不会露。补测只用 precision/Q，没测这些可被糊弄的路径。
6. **主/补测两处"V12 被漏推 8 次"实为 9 次**（12 轮逐条复算：queue-0 r1/r4 + budget4×4 + budget2 r1/r2/r4）。
7. **jsonl 重建未披露**：现文件 = salvage + git 回填 + 后续追加，**时间序被打乱**，且混入 2 条非本实验（默认 arms）记录，却仍被当"全库"统计；"逐条一致"只在册记录成立。
8. **提案缺格式合规**：`env-style` 要求每小节末一行 `依据：`，提案只在最末 §6 有一行，§1–§5 全缺；§5.2 的 diff 里 `runId` 未定义。

---

## ④ 一句话总评

**补实验再定**：装置缺陷提案站得住、可直接收（补齐逐节 `依据：` 与证据出处即可）；补测的"cap 方向"我认，但核心读数（precision 0.85、1900s、queue 中位 105k、Pearson n=18）有硬错，且主结论被 V12 语料缺陷与"非严格单变量"污染 —— 请先做 V12 剔除复算、补同提示 quota=0/1 端点、改正数字后重交。
