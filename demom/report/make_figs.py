# -*- coding: utf-8 -*-
"""把实验数据画成报告用的图。

变体名一律用**中文**（括号里留代号，方便对照 JSONL 的 variant 字段）：
  A 基线(base) / A 断视野(nodup) / A 可互问(talk) / A 已读清单(ledger)
  B 基线(base) / B 指令保真(preserve) / B 代码保真(mechanical) / B 核对原文(verify)
  B 轨迹共享(share) / B 中途纠正(steer) / B 共享工作台(board)

数据来自 demom/report/data.json（extract.mjs 用**当前判据**重判 55 条记录生成）。
"""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch, Patch
from matplotlib.lines import Line2D
import numpy as np

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 200
plt.rcParams["savefig.bbox"] = "tight"
plt.rcParams["axes.edgecolor"] = "#cccccc"

OUT = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(OUT, "data.json"), encoding="utf-8"))

C = dict(cluster="#2E86AB", workflow="#E4572E", good="#2A9D8F", bad="#C1121F",
         neutral="#8D99AE", accent="#F4A261", purple="#7B2CBF", grid="#E8E8E8")

# ── 变体中文名 ──
NAME = {
    ("A-cluster", "base"):        "A 基线",
    ("A-cluster", "nodup"):       "A 断视野",
    ("A-cluster", "talk"):        "A 可互问",
    ("A-cluster", "ledger"):      "A 已读清单",
    ("B-workflow", "base"):       "B 基线",
    ("B-workflow", "preserve"):   "B 指令保真",
    ("B-workflow", "mechanical"): "B 代码保真",
    ("B-workflow", "verify"):     "B 核对原文",
    ("B-workflow", "share"):      "B 轨迹共享",
    ("B-workflow", "steer"):      "B 中途纠正",
    ("B-workflow", "board"):      "B 共享工作台",
}
def nm(lab, var):
    return NAME[(lab, var)]

def agg(lab, variant):
    rs = [r for r in D if r["lab"] == lab and r["variant"] == variant]
    n = len(rs)
    return dict(n=n, ok=sum(r["ok"] for r in rs),
                rate=sum(r["ok"] for r in rs) / n if n else 0,
                tok=int(np.mean([r["tokens"] for r in rs])) if n else 0,
                secs=int(np.mean([r["secs"] for r in rs])) if n else 0,
                dedup=sum(r["deduped"] for r in rs))

def clean(ax, grid=True):
    if grid:
        ax.grid(axis="y", color=C["grid"], zorder=0); ax.set_axisbelow(True)
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)

# ══════════════════════════════════════════════════════════════
# 图 1：B 的七轮改进
# ══════════════════════════════════════════════════════════════
def fig1():
    seq = [("base", "B 基线", "自由文本交接"),
           ("preserve", "B 指令保真", "提示词要求保留分组"),
           ("mechanical", "B 代码保真", "结构化+代码强制\n但判断者没视野"),
           ("verify", "B 核对原文", "S2 读 45 份原文"),
           ("share", "B 轨迹共享", "context.override\n注入轨迹"),
           ("steer", "B 中途纠正", "io.steer 拉回来"),
           ("board", "B 共享工作台", "自造构件")]
    st = [agg("B-workflow", s[0]) for s in seq]
    rates = [s["rate"] * 100 for s in st]
    toks = [s["tok"] / 1000 for s in st]
    xs = np.arange(len(seq))

    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(12.4, 8.8), sharex=True,
                                  gridspec_kw={"height_ratios": [1.5, 1], "hspace": 0.14})

    colors = [C["bad"] if r == 0 else (C["good"] if r >= 73 else C["accent"]) for r in rates]
    b = ax.bar(xs, rates, color=colors, width=0.6, zorder=3, edgecolor="white", linewidth=1.2)
    for bar, s in zip(b, st):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 2.2,
                f"{s['ok']}/{s['n']} = {s['rate']*100:.0f}%", ha="center", va="bottom",
                fontsize=11, fontweight="bold", color="#333")
    ax.set_ylabel("通过率（5 项判据全过）", fontsize=11.5)
    ax.set_ylim(0, 104); clean(ax)
    ax.annotate("接口造好了，但判断者\n没有全局视野 → 全挂",
                xy=(2, 2), xytext=(2, 30), ha="center", fontsize=9.5, color=C["bad"],
                arrowprops=dict(arrowstyle="->", color=C["bad"], lw=1.5))
    ax.set_title("固定流程（B）的七轮改进：通过率一路升到 86%", fontsize=15, fontweight="bold", pad=14)

    ax2.bar(xs, toks, color=C["cluster"], width=0.6, zorder=3, edgecolor="white", linewidth=1.2, alpha=0.85)
    for i, t in enumerate(toks):
        ax2.text(i, t + 22, f"{t:.0f}k", ha="center", va="bottom", fontsize=10.5,
                 fontweight="bold", color=C["cluster"])
    ax2.set_ylabel("平均 token 消耗", fontsize=11.5)
    ax2.set_ylim(0, max(toks) * 1.22); clean(ax2)
    ax2.set_xticks(xs)
    ax2.set_xticklabels([f"{a}\n({v})\n{c}" for v, a, c in seq], fontsize=9.0)
    ax2.set_title("但成本不是单调下降：核对原文最贵（1004k），中途纠正最省（457k）",
                  fontsize=10.5, color="#555", pad=8)
    fig.savefig(os.path.join(OUT, "fig1_b_improvement.png"))
    plt.close(fig)

# ══════════════════════════════════════════════════════════════
# 图 2：成本 vs 准确率 + B 的改进路径
# ══════════════════════════════════════════════════════════════
def fig2():
    pts = [("A-cluster", "base"), ("A-cluster", "nodup"), ("A-cluster", "talk"), ("A-cluster", "ledger"),
           ("B-workflow", "base"), ("B-workflow", "preserve"), ("B-workflow", "mechanical"),
           ("B-workflow", "verify"), ("B-workflow", "share"), ("B-workflow", "steer"),
           ("B-workflow", "board")]
    fig, ax = plt.subplots(figsize=(11.8, 7.8))
    pos = {}
    for lab, var in pts:
        s = agg(lab, var); x, y = s["tok"] / 1000, s["rate"] * 100
        pos[(lab, var)] = (x, y)
        col = C["cluster"] if lab == "A-cluster" else C["workflow"]
        ax.scatter(x, y, s=170 + s["n"] * 24, color=col, alpha=0.8, zorder=3,
                   edgecolor="white", linewidth=1.6)
    path = [("B-workflow", v) for v in
            ["base", "preserve", "mechanical", "verify", "share", "steer", "board"]]
    for a, b_ in zip(path, path[1:]):
        ax.add_patch(FancyArrowPatch(pos[a], pos[b_], arrowstyle="-|>", mutation_scale=13,
                                     color=C["workflow"], lw=1.5, alpha=0.45,
                                     linestyle=(0, (5, 3)), zorder=2, shrinkA=16, shrinkB=18))
    off = {("B-workflow", "base"): (0, -38), ("B-workflow", "preserve"): (0, 24),
           ("B-workflow", "mechanical"): (0, -42), ("B-workflow", "verify"): (0, -42),
           ("B-workflow", "share"): (0, 24), ("B-workflow", "steer"): (-14, 26),
           ("B-workflow", "board"): (0, 24), ("A-cluster", "base"): (0, -38),
           ("A-cluster", "nodup"): (0, 24), ("A-cluster", "talk"): (0, 24),
           ("A-cluster", "ledger"): (0, 24)}
    for lab, var in pts:
        s = agg(lab, var)
        col = C["cluster"] if lab == "A-cluster" else C["workflow"]
        ax.annotate(f"{nm(lab,var)}\n({var}, n={s['n']})", pos[(lab, var)],
                    textcoords="offset points", xytext=off[(lab, var)],
                    ha="center", fontsize=9.0, fontweight="bold", color=col)
    ax.set_xlabel("平均 token 消耗（越低越好）", fontsize=11.5)
    ax.set_ylabel("通过率 %（越高越好）", fontsize=11.5)
    ax.set_title("所有变体：成本 vs 准确率\n虚线 = 固定流程（B）的七轮改进路径",
                 fontsize=14.5, fontweight="bold", pad=14)
    ax.grid(color=C["grid"], zorder=0); ax.set_axisbelow(True)
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)
    ax.set_ylim(-12, 114)
    ax.legend(handles=[
        Line2D([], [], marker="o", color="w", markerfacecolor=C["cluster"], markersize=11, label="A 自由集群"),
        Line2D([], [], marker="o", color="w", markerfacecolor=C["workflow"], markersize=11, label="B 固定流程"),
        Line2D([], [], ls=(0, (5, 3)), color=C["workflow"], alpha=0.6, label="B 的改进路径"),
    ], loc="lower right", frameon=False, fontsize=10)
    ax.text(0.02, 0.02, "【注意】A 可互问（n=2）与 A 已读清单（n=4）样本量小，不能当结论",
            transform=ax.transAxes, fontsize=8.8, color="#888")
    fig.savefig(os.path.join(OUT, "fig2_cost_vs_accuracy.png"))
    plt.close(fig)

# ══════════════════════════════════════════════════════════════
# 图 3：交接的三种实现
# ══════════════════════════════════════════════════════════════
def fig3():
    groups = [("合流\n（共享同一份上下文）",
               [("A-cluster", "base"), ("B-workflow", "share"), ("B-workflow", "board")], C["good"]),
              ("重建\n（下游重读原文自己推）", [("B-workflow", "verify")], C["accent"]),
              ("断流\n（只传自由文本）",
               [("A-cluster", "nodup"), ("B-workflow", "base")], C["bad"])]
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(14.5, 6.6), gridspec_kw={"width_ratios": [1.3, 1]})
    xs, labels, rates, cols, ns = [], [], [], [], []
    i = 0
    for gname, items, col in groups:
        for lab, var in items:
            s = agg(lab, var)
            xs.append(i); labels.append(f"{nm(lab,var)}\n({var})")
            rates.append(s["rate"] * 100); cols.append(col); ns.append(s["n"]); i += 1
        i += 0.55
    ax.bar(xs, rates, color=cols, width=0.72, zorder=3, edgecolor="white", linewidth=1.2)
    for x, r, n in zip(xs, rates, ns):
        ax.text(x, r + 2.5, f"{r:.0f}%\nn={n}", ha="center", va="bottom", fontsize=9.8, fontweight="bold", color="#333")
    ax.set_xticks(xs); ax.set_xticklabels(labels, fontsize=9.2)
    ax.set_ylim(0, 106); ax.set_ylabel("通过率 %", fontsize=11.5); clean(ax)
    ax.set_title("交接机制决定成败（不是「集群 vs 流程」）", fontsize=13, fontweight="bold", pad=12)
    x0 = 0
    for gname, items, col in groups:
        ax.text(x0 + (len(items) - 1) / 2, -24, gname, ha="center", va="top",
                fontsize=10.5, color=col, fontweight="bold", linespacing=1.3)
        x0 += len(items) + 0.55

    ev = [("A-cluster", "base", "A 基线\n(root)"), ("A-cluster", "nodup", "A 断视野\n(root)"),
          ("B-workflow", "base", "B 基线\n(S2)"), ("B-workflow", "verify", "B 核对原文\n(S2)"),
          ("B-workflow", "share", "B 轨迹共享\n(S2)"), ("B-workflow", "board", "B 共享工作台\n(S2)")]
    names, vals, cc, rt = [], [], [], []
    for lab, var, name in ev:
        rs = [r for r in D if r["lab"] == lab and r["variant"] == var and r["judgeReads"] is not None]
        names.append(name); vals.append(np.median([r["judgeReads"] for r in rs]))
        rt.append(np.mean([r["deduped"] for r in rs]) * 100)
        cc.append(C["cluster"] if lab == "A-cluster" else C["workflow"])
    ax2.bar(range(len(names)), vals, color=cc, width=0.68, zorder=3, edgecolor="white", linewidth=1.2)
    for i, (v, r) in enumerate(zip(vals, rt)):
        ax2.text(i, v + 1.0, f"{v:.0f} 份", ha="center", va="bottom", fontsize=9.8, fontweight="bold", color="#333")
        # 矮柱里放不下就把去重率标在柱子上方
        if v < max(vals) * 0.25:
            ax2.text(i, v + 5.2, f"去重 {r:.0f}%", ha="center", va="bottom", fontsize=8.6,
                     color="#666", fontweight="bold")
        else:
            ax2.text(i, v * 0.5, f"去重\n{r:.0f}%", ha="center", va="center", fontsize=9, color="white", fontweight="bold")
    ax2.set_xticks(range(len(names))); ax2.set_xticklabels(names, fontsize=9)
    ax2.set_ylabel("判断者读材料的份数（中位数）", fontsize=10.5)
    ax2.set_ylim(0, max(vals) * 1.28); clean(ax2)
    ax2.set_title("视野是硬约束：读 0–2 份的判断者，去重只到 0–50%", fontsize=12, fontweight="bold", pad=12)
    fig.savefig(os.path.join(OUT, "fig3_handoff.png"))
    plt.close(fig)

# ══════════════════════════════════════════════════════════════
# 图 4：工作台的机制证据
# ══════════════════════════════════════════════════════════════
def fig4():
    bd = [r for r in D if r["variant"] == "board" and r["workbench"]]
    old = [r for r in bd if r["workbench"]["injectedChars"] > 300000]
    new = [r for r in bd if r["workbench"]["injectedChars"] <= 300000]
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))

    ax = axes[0]
    a = np.mean([r["workbench"]["injectedChars"] for r in old]) / 1000
    b = np.mean([r["workbench"]["injectedChars"] for r in new]) / 1000
    ax.bar(["改前\n(每轮重注整块黑板)", "改后\n(只注增量)"], [a, b], color=[C["bad"], C["good"]],
           width=0.55, zorder=3, edgecolor="white", linewidth=1.2)
    for i, v in enumerate([a, b]):
        ax.text(i, v + a * 0.025, f"{v:.0f}k 字符", ha="center", va="bottom", fontsize=11, fontweight="bold")
    ax.annotate(f"{a/b:.0f}× 降低", xy=(0.5, (a + b) / 2), ha="center", fontsize=13,
                fontweight="bold", color=C["good"],
                bbox=dict(boxstyle="round,pad=0.3", facecolor="white", edgecolor=C["good"], linewidth=1.4))
    ax.set_ylim(0, a * 1.2)
    ax.set_title("① 注入量：合流的真实成本\n不是信息量，是「重复注入」", fontsize=11.5, fontweight="bold")

    ax = axes[1]
    a = np.mean([r["workbench"]["digested"] for r in old])
    b = np.mean([r["workbench"]["digested"] for r in new])
    ax.bar(["改前\n(靠 preview 找)", "改后\n(读前记 + 读后取)"], [a, b], color=[C["bad"], C["good"]],
           width=0.55, zorder=3, edgecolor="white", linewidth=1.2)
    for i, v in enumerate([a, b]):
        ax.text(i, v + b * 0.025, f"{v:.0f} 份", ha="center", va="bottom", fontsize=11, fontweight="bold")
    ax.set_ylim(0, b * 1.25)
    ax.set_title("② 读后即消化：原文移出上下文\n（共 44 份材料）", fontsize=11.5, fontweight="bold")

    ax = axes[2]
    xs = [r["notes"] for r in bd]; ys = [r["s4Reads"] for r in bd]
    okc = [C["good"] if r["ok"] else C["bad"] for r in bd]
    ax.scatter(xs, ys, s=150, c=okc, zorder=3, edgecolor="white", linewidth=1.5)
    if len(xs) > 1:
        k, m = np.polyfit(xs, ys, 1)
        xr = np.linspace(min(xs), max(xs), 20)
        ax.plot(xr, k * xr + m, "--", color=C["neutral"], zorder=2, linewidth=1.5)
    ax.set_xlabel("黑板上的笔记数", fontsize=10.5)
    ax.set_ylabel("S4（写手）重读材料的份数", fontsize=10.5)
    ax.set_title("③ 黑板写得越满，下游越不必重读？\n实测关系很弱（诚实记录）", fontsize=11.5, fontweight="bold")
    ax.text(0.03, 0.05, "绿=通过 红=失败", transform=ax.transAxes, fontsize=8.6, color="#888")
    for ax in axes: clean(ax)
    fig.suptitle("自造构件「工作台」：两个坑修好之后的读数（第三个面板是没兑现的部分）",
                 fontsize=14, fontweight="bold", y=1.05)
    fig.savefig(os.path.join(OUT, "fig4_workbench.png"))
    plt.close(fig)

# ══════════════════════════════════════════════════════════════
# 图 5：判据 bug 的代价
# ══════════════════════════════════════════════════════════════
def fig5():
    fig, ax = plt.subplots(figsize=(10, 5.6))
    items = [("子串碰撞\n\"M37\".includes(\"M3\") 为 true", "A 自由集群", 1, 6, 4, 6),
             ("fallback 分支里的旧逻辑\n（粗体段落退回按节判断）", "B 固定流程", 0, 4, 2, 4)]
    w = 0.34
    for i, (name, who, a, an, b, bn) in enumerate(items):
        ax.bar(i - w / 2, a / an * 100, width=w, color=C["bad"], zorder=3, edgecolor="white", linewidth=1.2)
        ax.bar(i + w / 2, b / bn * 100, width=w, color=C["good"], zorder=3, edgecolor="white", linewidth=1.2)
        ax.text(i - w / 2, a / an * 100 + 2, f"{a}/{an}\n{a/an*100:.0f}%", ha="center", va="bottom", fontsize=10.5, fontweight="bold")
        ax.text(i + w / 2, b / bn * 100 + 2, f"{b}/{bn}\n{b/bn*100:.0f}%", ha="center", va="bottom", fontsize=10.5, fontweight="bold")
    ax.set_xticks(range(len(items))); ax.set_xticklabels([n for n, *_ in items], fontsize=9.8)
    ax.set_ylabel("通过率 %", fontsize=11.5); ax.set_ylim(0, 96); clean(ax)
    ax.legend(handles=[Patch(color=C["bad"], label="判据修正前"), Patch(color=C["good"], label="判据修正后")],
              frameon=False, fontsize=10.5, loc="upper left")
    ax.set_title("判据的两个 bug 与它们的代价\n（一个字符，结论翻三倍）", fontsize=14, fontweight="bold", pad=14)
    fig.savefig(os.path.join(OUT, "fig5_judge_bugs.png"))
    plt.close(fig)

# ══════════════════════════════════════════════════════════════
# 图 6：架构示意
# ══════════════════════════════════════════════════════════════
def fig6():
    fig, axes = plt.subplots(1, 2, figsize=(14, 6.6))
    for ax, title, col in [(axes[0], "A 自由集群：图在运行时长出来", C["cluster"]),
                           (axes[1], "B 固定流程：图在设计期写死", C["workflow"])]:
        ax.set_xlim(0, 10); ax.set_ylim(0, 10); ax.axis("off")
        ax.set_title(title, fontsize=13.5, fontweight="bold", color=col, pad=10)

    def box(ax, x, y, w, h, text, fc, fs=9.5, tc="white"):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.12",
                                    facecolor=fc, edgecolor="white", linewidth=1.5, zorder=3))
        ax.text(x + w / 2, y + h / 2, text, ha="center", va="center", fontsize=fs,
                color=tc, fontweight="bold", zorder=4, linespacing=1.35)

    def arrow(ax, p, q, color, ls="-"):
        ax.add_patch(FancyArrowPatch(p, q, arrowstyle="-|>", mutation_scale=14,
                                     color=color, lw=1.8, linestyle=ls, zorder=2))

    ax = axes[0]
    box(ax, 3.3, 8.0, 3.4, 1.4, "root（协调者）\n自己读 + 决定派谁", C["cluster"])
    for x, t in [(0.35, "scout"), (2.6, "scout"), (4.85, "analyst"), (7.1, "checker")]:
        box(ax, x, 5.2, 2.15, 1.05, t, "#6BAED6", 9)
        arrow(ax, (5.0, 8.0), (x + 1.07, 6.35), "#9DC3E6", ls="--")
    box(ax, 3.0, 3.0, 4.0, 1.15, "writer（唯一落盘）", "#6BAED6", 9.5)
    arrow(ax, (4.0, 5.2), (4.6, 4.15), "#9DC3E6", ls="--")
    arrow(ax, (6.0, 5.2), (5.4, 4.15), "#9DC3E6", ls="--")
    ax.text(5.0, 1.9, "agent 数 = 变量（实测 1–8）\n谁派给谁：模型运行时决定",
            ha="center", fontsize=10, color="#555", linespacing=1.4, style="italic")
    ax.text(5.0, 0.7, "【注意】预算闸只在 spawn 之前查", ha="center", fontsize=9, color=C["bad"], fontweight="bold")

    ax = axes[1]
    ys = 8.1
    for i, t in enumerate(["S1\n摸底", "S2 去重", "S3 查矛盾", "S4\n成文", "S6\n强制合并", "S5\n校验"]):
        x = 0.2 + i * 1.63
        box(ax, x, ys, 1.45, 1.2, t, C["purple"] if i == 4 else C["workflow"], 8.2)
        if i < 5:
            arrow(ax, (x + 1.45, ys + 0.6), (x + 1.63, ys + 0.6), "#F0A58C")
    ax.text(5.0, 7.35, "阶段与边：跑之前就画得出来", ha="center", fontsize=9.6, color="#555", style="italic")
    box(ax, 1.0, 5.2, 3.4, 1.15, "共享工作台\n（结构化黑板）", C["purple"], 9)
    box(ax, 5.6, 5.2, 3.4, 1.15, "每阶段护栏\nmaxCalls", C["purple"], 9)
    for i in range(6):
        x = 0.2 + i * 1.63 + 0.72
        arrow(ax, (x, ys), (x, 6.4), "#C77DFF", ls=":")
    ax.text(5.0, 4.1, "agent 数 = 常数（实测恒为 5）\n每个位置的上限由设计者写死",
            ha="center", fontsize=10, color="#555", linespacing=1.4, style="italic")
    ax.text(5.0, 2.9, "代码阶段 S6：模型负责判断，代码负责保真",
            ha="center", fontsize=9.6, color=C["purple"], fontweight="bold")
    ax.text(5.0, 1.7, "【注意】但阶段内部可以失控\n（实测单次 423 次调用 / 572 万 token）",
            ha="center", fontsize=9, color=C["bad"], fontweight="bold", linespacing=1.4)

    fig.suptitle("两种形态的结构差别：可寻址的干预点 vs 运行时长出来的图",
                 fontsize=15, fontweight="bold", y=1.0)
    fig.savefig(os.path.join(OUT, "fig6_architecture.png"))
    plt.close(fig)

for f in (fig1, fig2, fig3, fig4, fig5, fig6):
    f(); print("[ok]", f.__name__)
print("done")
