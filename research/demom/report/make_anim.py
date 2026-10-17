# -*- coding: utf-8 -*-
"""动图：固定流程（B）的七轮改进，一轮一轮长出来。

变体名用中文（括号里留代号）。生成 GIF（Pillow 写出）。
"""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter
import numpy as np

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei"]
plt.rcParams["axes.unicode_minus"] = False
plt.rcParams["figure.dpi"] = 130
plt.rcParams["axes.edgecolor"] = "#cccccc"

OUT = os.path.dirname(os.path.abspath(__file__))
D = json.load(open(os.path.join(OUT, "data.json"), encoding="utf-8"))
C = dict(good="#2A9D8F", bad="#C1121F", accent="#F4A261", cluster="#2E86AB", grid="#E8E8E8")

def agg(v):
    rs = [r for r in D if r["lab"] == "B-workflow" and r["variant"] == v]
    n = len(rs)
    return dict(n=n, ok=sum(r["ok"] for r in rs), rate=sum(r["ok"] for r in rs) / n if n else 0,
                tok=int(np.mean([r["tokens"] for r in rs])) if n else 0)

STEPS = [
    ("base",       "第 0 轮：B 基线",       "自由文本交接（有损）"),
    ("preserve",   "第 1 轮：B 指令保真",   "用提示词要求保留合并分组 —— 有效但不可靠"),
    ("mechanical", "第 2 轮：B 代码保真",   "结构化 + 代码强制 —— 接口造好了，但判断者没有全局视野 → 全挂"),
    ("verify",     "第 3 轮：B 核对原文",   "给判断者全局视野：S2 读 45 份原文 —— 涨到 73%，但最贵"),
    ("share",      "第 4 轮：B 轨迹共享",   "context.override 注入上游轨迹 —— 同样准，便宜一半"),
    ("steer",      "第 5 轮：B 中途纠正",   "io.steer —— 把本来要 abort 的阶段拉回来"),
    ("board",      "第 6 轮：B 共享工作台", "自造构件：结构化黑板 + 读后即消化"),
]
stats = [agg(s[0]) for s in STEPS]
rates = [s["rate"] * 100 for s in stats]
toks = [s["tok"] / 1000 for s in stats]

fig, ax = plt.subplots(figsize=(11.4, 6.6))
xs = np.arange(len(STEPS))
XTICK = [s[1].split("：")[1] + "\n(" + s[0] + ")" for s in STEPS]

def frame(i):
    ax.clear()
    n = i + 1
    colors = [C["bad"] if r == 0 else (C["good"] if r >= 73 else C["accent"]) for r in rates[:n]]
    ax.bar(xs[:n], rates[:n], color=colors, width=0.62, zorder=3, edgecolor="white", linewidth=1.2)
    for j in range(n):
        ax.text(xs[j], rates[j] + 2.2, f"{stats[j]['ok']}/{stats[j]['n']}\n{rates[j]:.0f}%",
                ha="center", va="bottom", fontsize=10.5, fontweight="bold", color="#333")
    ax.set_xticks(xs)
    ax.set_xticklabels(XTICK, fontsize=8.8)
    ax.set_ylabel("通过率（5 项判据全过）", fontsize=11.5)
    ax.set_ylim(0, 104); ax.set_xlim(-0.6, len(STEPS) - 0.4)
    ax.grid(axis="y", color=C["grid"], zorder=0); ax.set_axisbelow(True)
    for sp in ("top", "right"): ax.spines[sp].set_visible(False)

    ax2 = ax.twinx()
    ax2.plot(xs[:n], toks[:n], color=C["cluster"], marker="o", markersize=6, linewidth=2.2, zorder=4)
    ax2.set_ylabel("平均 token 消耗", fontsize=11, color=C["cluster"])
    ax2.tick_params(axis="y", colors=C["cluster"])
    ax2.set_ylim(0, max(toks) * 1.2)
    for sp in ("top", "left"): ax2.spines[sp].set_visible(False)

    ax.set_title(STEPS[i][1], fontsize=15, fontweight="bold", pad=12, color="#222")
    ax.text(0.5, 0.955, STEPS[i][2], transform=ax.transAxes, ha="center", fontsize=11, color="#666")
    ax.text(0.985, 0.02, "对照：A 基线（自由集群）= 4/6 (67%)  |  数据：55 条实测记录",
            transform=ax.transAxes, fontsize=8.6, color="#999", ha="right")
    return []

frames = []
for i in range(len(STEPS)):
    frames += [i] * (6 if i == len(STEPS) - 1 else 3)

anim = FuncAnimation(fig, frame, frames=frames, blit=False)
anim.save(os.path.join(OUT, "anim_b_improvement.gif"), writer=PillowWriter(fps=2.2))
plt.close(fig)
print("[ok] anim_b_improvement.gif")
