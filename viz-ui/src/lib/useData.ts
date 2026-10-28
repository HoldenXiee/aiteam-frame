import { useEffect, useState } from "react";
import { parseData, type VizData } from "../types";

/**
 * 载入数据。
 *
 * ★★★ 为什么是"手动选文件"而不是自动 fetch：
 *   这份页面要能**双击 dist/index.html** 打开（file://）——
 *   file:// 下 `fetch("./data/hunt.json")` 会被浏览器的同源策略挡掉，
 *   所以要给三条路：① 选文件 ② 把文件拖进窗口 ③ 起本地服务时用 `?data=相对路径`。
 *
 * ★★ 坏文件必须**当场说清楚坏在哪**（`parseData` 抛的那句话直接显示），不白屏。
 */

export type LoadState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: VizData; source: string };

export function useData(): [LoadState, (file: File) => Promise<void>] {
  const [state, setState] = useState<LoadState>({ kind: "empty" });

  const loadFile = async (file: File): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const text = await file.text();
      const data = parseData(JSON.parse(text));
      setState({ kind: "ready", data, source: `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)}MB` });
      try {
        localStorage.setItem("viz:last", JSON.stringify({ name: file.name, at: Date.now(), counts: data.meta.counts }));
      } catch {
        /* 隐私模式下写不进，不影响使用 */
      }
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message || String(e) });
    }
  };

  // `?data=...` —— 只有起了本地服务时才有用；file:// 下失败就走手动，不报错
  useEffect(() => {
    const p = new URLSearchParams(location.search).get("data");
    if (!p) return;
    setState({ kind: "loading" });
    fetch(p)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        const data = parseData(j);
        setState({ kind: "ready", data, source: `${p} · ${(JSON.stringify(j).length / 1024 / 1024).toFixed(1)}MB` });
      })
      .catch((e: Error) => {
        setState({
          kind: "error",
          message: `读 ?data=${p} 失败：${e.message} —— file:// 下取本地文件是被浏览器禁止的，请改用「选择文件」`,
        });
      });
  }, []);

  // 整窗拖入
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadFile(f);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return [state, loadFile];
}
