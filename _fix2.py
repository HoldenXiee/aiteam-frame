import pathlib

p = pathlib.Path("research/clusters/forge/tools/signoff.ts")
lines = p.read_text(encoding="utf-8").split(chr(10))

# 找到 description: 开始（"为一份产物签字"）
start = None
for i, l in enumerate(lines):
    if '为一份产物签字' in l:
        start = i
        break
assert start is not None

# 找到 description 结束（',\n    parameters:' 之前）
end = None
for i in range(start, len(lines)):
    if lines[i].strip().startswith("parameters:"):
        end = i - 1
        break
assert end is not None

repl = r'''      [
        "为一份产物签字 —— ★★★ 这是**共识门**。",
        "★ 一份东西要进教科书，必须**全体团队都表态**（沉默不算认同）。",
        "",
        "★★★ 四选一：",
        "· **认同** —— 你核对过，没问题",
        "· **有保留** —— 可进，但你有条件（**必须给解除条件**）",
        "  ★★ 你的保留**只是提议** —— 必须有**别的团队说「认同这条保留」**才生效。",
        "     没人认同 ⇒ 你这条**不算表态**（等于没签）⇒ 产物进不了书。",
        "· **认可保留** —— 你看过同事的保留，认为**它站得住**（给他背书）",
        "· **反对** —— 不许进，先辩清楚",
        "",
        "★★ 为什么要「认可保留」这一步：",
        "   实测过 87 张签字里 43 张「有保留」、**0 张反对** ⇒ 带保留率 86%。",
        "   根因是两种表态**代价不对等**：反对要拿反例且卡住发布，",
        "   有保留只要写条条件就照样进书 ⇒ 理性做法永远是「有保留」。",
        "   ⇒ 现在保留是**提议**，要有人背书才生效。",
      ].join(String.fromCharCode(10)),
'''.rstrip(chr(10)).split(chr(10))

lines = lines[:start] + repl + lines[end + 1 :]
p.write_text(chr(10).join(lines), encoding="utf-8")
print("description 已重写")
