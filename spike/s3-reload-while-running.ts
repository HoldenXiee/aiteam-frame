// S3：正在 streaming 时调 reload()，破坏面有多大？
// 规格 §3.3 打算给 add/remove 加「必须 idle，否则抛错」的前置。要先知道真砸下去会怎样。
import { check, head, rig, sleep } from "./_pi.ts";

head("S3 reload 撞上 running");

const r = await rig([]);
try {
  const p = r.session.prompt("[[sleep:1500]] 慢任务");
  p.catch(() => {}); // 先挂住，别让它在 await 时炸掉整个脚本
  await sleep(400);
  check("此刻确实在 streaming", r.session.isStreaming === true);

  const t0 = Date.now();
  let reloadError: string | undefined;
  const reloadDone = await Promise.race([
    r.session
      .reload()
      .then(() => "ok")
      .catch((err: unknown) => {
        reloadError = String(err);
        return "threw";
      }),
    sleep(5000).then(() => "timeout"),
  ]);
  console.log(`  reload 结果=${reloadDone}（${Date.now() - t0}ms）${reloadError ? ` 错误：${reloadError.slice(0, 200)}` : ""}`);

  let promptOutcome = "未结束";
  await Promise.race([
    p.then(
      () => (promptOutcome = "跑完了"),
      (err: unknown) => (promptOutcome = `抛错：${String(err).slice(0, 160)}`),
    ),
    sleep(4000).then(() => (promptOutcome = "超时（4s 没结束）")),
  ]);
  console.log(`  被打断的那轮：${promptOutcome}`);
  console.log(`  之后 isStreaming=${r.session.isStreaming}`);

  let afterOutcome = "";
  try {
    await Promise.race([r.session.prompt("after"), sleep(5000).then(() => "超时")]).then((v) => {
      afterOutcome = String(v ?? "ok");
    });
  } catch (err) {
    afterOutcome = `抛错：${String(err).slice(0, 160)}`;
  }
  check("reload 之后会话**还能继续用**", afterOutcome !== "超时" && !afterOutcome.startsWith("抛错"), afterOutcome);

  console.log(`  假服务收到 ${r.calls.length} 次请求`);
} finally {
  await r.close();
}