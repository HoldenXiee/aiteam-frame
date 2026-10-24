import pathlib
import re

p = pathlib.Path("research/clusters/forge/runner.ts")
s = p.read_text(encoding="utf-8")

# ① 找到渐进段的起止（从注释 "「渐进的书」审查基准" 到 stale 检查结束）
start_marker = "        // ★★★ 2026-10-21 · 「渐进的书」审查基准（设计者裁定）"
start = s.index(start_marker)

# 终点：stale 那段结束（找 "</content>" 之前的 "}\n        }" 结构）
# 用 stale 段的最后一句作为锚
end_marker = """              L.push(`★ 过时检查：**0 章**被新原料影响（\\`source/\\` 里没有比它们更新的原料）。`);
            }
          }"""
end = s.index(end_marker) + len(end_marker)

block = s[start:end]
s = s[:start] + s[end:]

# ② 这一段原本 8 空格缩进（在 if 里），现在要 6 空格（在 orderTodo 的 IIFE 顶层）
lines = []
for ln in block.split("\n"):
    if ln.startswith("        "):
        lines.append(ln[2:])
    else:
        lines.append(ln)
block = "\n".join(lines)

# ③ 插到 orderTodo 返回之前（即 `)))` 之前的位置）
#   找到 orderTodo IIFE 的结束：`      return L.join(String.fromCharCode(10));`
ret_marker = """    return L.join(String.fromCharCode(10));
  } catch (e) {
    log("error", `认知顺序读数失败：${(e as Error).message}`);"""
assert ret_marker in s, "orderTodo 返回点没找到"

s = s.replace(ret_marker, block + "\n" + ret_marker, 1)
p.write_text(s, encoding="utf-8")
print("渐进段已移出 if 块")
