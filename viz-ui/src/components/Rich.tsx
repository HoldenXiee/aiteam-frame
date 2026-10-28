/**
 * 把账本里的**原始文字**渲染出来，只做两件最小的事：
 *   `**粗体**` → <strong>，`` `代码` `` → <code>
 *
 * ★ 不做 markdown 全解析、不自动加链接、不改写任何字 —— 这是研究记录，
 *   转述一次就可能变味（硬规则①是给内容判断用的，这里连"美化"都不该过度）。
 */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`") && p.length > 2) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}
