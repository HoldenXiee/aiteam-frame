// ★★★ 专家调度：tick 只「记下要派谁」，真正派活按节奏逐个来
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这份是从 forge 搬来的（2026-10-21），搬的理由见下
//
//   hunt 一直是 `await fire(...)` —— 专家跑 3–6 分钟，**整个 tick 停在那里**。
//   ★ 实测（2026-10-21，420s 窗口）：**tick 只跑了 1 次**，
//     日志里只有 `onNewFinding` 和 `onCapabilityGap` 两行，
//     ★ 新加的第 5 条规则 `onInstrumentReview` **一次都没轮到**。
//   ★★ 这与 forge 2026-10-20 记录的**是同一个病**，只是换了个集群。
//     那次修法是「观察快、派活慢，两件事分开」——这里直接沿用。
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么需要这个文件（2026-10-20 forge 实测出来的结构问题）
//
//   病：`tick()` 串行 `await` 每条规则，而规则里有 **9 处 `await fire(...)`**，
//      专家每次跑 3–6 分钟 ⇒ **整个 tick 停在那里** ⇒ 后面规则全被饿死。
//
//   实测：180s 窗口 tick 只跑 1 次（该 ~6 次）· 600s 只跑 3 次（该 ~20 次）
//        ⇒ **实际频率只有设计值的 1/6 ~ 1/7**
//        ⇒ 具体受害者：`onChapterIndex` 从上线起 **0 次触发**。
//
// ══════════════════════════════════════════════════════════════════════════
// 我走过的两条错路（都记在这里，别再走）
//
//   ① `await fire(...)`  —— 原状：tick 被专家卡住 3–6 分钟。
//   ② `void fire(...)`   —— 只让 tick 不等：tick 跑起来了，**但一个 tick 里
//      能同时 fire 好几个专家**。实测：一个 tick 里 archivist + inspector 同时开工。
//      ★ 后果：成本不可控（一次 tick 可能起 3 个专家）、日志交错、
//        且 9 处 `fire` 的返回值全变成 `""`（语义被悄悄改掉）。
//
// ══════════════════════════════════════════════════════════════════════════
// 现在这条（③）：**观察快、派活慢，两件事分开**
//
//   规则里 `await fire(...)` 的语义变成：
//     「**记下**这个专家该被派」（立刻返回，一次几微秒）
//   真正的派活由 `drain()` 按节奏做：
//     「**同一时刻只跑一个专家**；跑完再从队列取下一个」
//
//   ★ 于是：
//     · tick 永不被专家卡（观察是快的）
//     · 一次只有一位专家在跑（成本可控、日志不交错）
//     · 规则仍然按顺序写、按顺序判（语义没变）
//     · ★★ `onSettled` 需要 `VERDICT` 的诉求变成「等**自己派的那一位**跑完」
//        —— 它不再阻塞 tick，而是拿到结果后异步写回
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 为什么不干脆并发派所有专家
//
//   成本。实测一轮 6 席位 + 4 观众约 2–3× 单员工的量级（≈$3–5/小时）。
//   若一个 tick 同时起 3 个专家，成本直接翻数倍，而且它们会**互相矛盾地改同一批东西**。
//   ★ 这个项目的教训（AGENTS §三）：forge 的病是「**还在散记，只是写得更长**」
//     —— 派更多专家只会让它写得更长，不会让它更收敛。
// ══════════════════════════════════════════════════════════════════════════

export type FireJob = {
  /** 谁 */
  role: string;
  /** 为什么叫它（会进日志与它的 role） */
  why: string;
  /** 额外焦点 */
  focus?: string;
  /**
   * ★★★ 给这位专家的**额外消息**（2026-10-25）
   * ★ 为的是把规则里残留的 `await fire(role, msg)` 全部改成入队 —— 那些 await 会
   *   **卡住整个 tick**（实测主空间 45 分钟只跑了 **4 次 tick**）。
   */
  message?: string;
  /** ★ 谁要它的结果（★ `onSettled` 要读 `VERDICT`） */
  onDone?: (text: string) => void;
  /** ★ 排进来时刻（用于日志说清"等了多久"） */
  at: number;
};

export type Drainer = {
  /** 记下一位要派的专家（★ 立刻返回） */
  enqueue: (job: Omit<FireJob, "at">) => void;
  /** 把队列里的活按「一次一个」的节奏派完（★ 调用方不该 await 它太多次） */
  drain: () => void;
  /** 现在有没有专家在跑 */
  busy: () => boolean;
  /** 队列里还有几个 */
  queued: () => number;
  /** 这一轮总共派了几个（读数） */
  fired: () => number;
  byRole: () => Record<string, number>;
  /**
   * ★★★ 同时在跑的专家峰値（读数）。
   *
   * ★ 为什么必须有这个数：这个设计**唯一**要保证的就是"一次只跑一位"。
   *   没有它，测试只能断言"看起来对"，而**看不出并发**。
   *   ★ 纪律㉔：量具记的字段必须能回答你想问的问题。
   */
  peakConcurrent: () => number;
  /** 同一专家排队时去重（★ 防止 3 个 tick 攒了 3 个 archivist） */
  clear: () => void;
};

/**
 * ★★★ 建一个派活器。
 *
 * @param doFire 真正去叫专家的函数（★ 会跑 3–6 分钟）
 * @param trace  记日志（★ 必须能看见「排队 / 开始 / 结束」三段）
 * @param closing 收尾态判断（★ 收尾后不再派新的）
 */
/**
 * ★★★★★ 座位派活账（纯函数 —— 纪律⑦：可离线重判）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么专门做这一行日志
 *
 *   ★★★ 实测事故：`hands-on`（唯一建设性的角度）**从头到尾 0 次派活**。
 *     而那件事**在日志里完全看不见** —— 它只是"没出现"。
 *   ★★ 我当时的诊断是「集群变成了审计员」，真相是「它只拿到了审计员」。
 *   ★ 纪律㉖：**没有名字 = 没发生**。所以这一行必须把「谁跑了 0 次」也说出来。
 *
 * ★ 与 `git log` 数前缀的区别：
 *   那个数的是**提交**，这个是**派活** ——
 *   ★ 0 次派活 ≠ 没干活（它可能只是没提交），0 次派活才是真的没被叫过。
 * ═══════════════════════════════════════════════════════════════════════
 *
 * @param counts 每个座位被派了几次
 * @param allKeys 应该被考虑的座位（★ 要包含"一次都没派过"的，否则看不见 0）
 */
export function renderSeatLedger(counts: Record<string, number>, allKeys: string[]): string {
  const keys = [...new Set(allKeys)];
  const zero = keys.filter((k) => !counts[k]);
  const body = keys.map((k) => `${k}=${counts[k] ?? 0}`).join(" · ");
  return `★ 座位派活账：${body}` + (zero.length ? ` · ★★ 0 次：${zero.join("/")}` : " · ✔ 全部动过");
}

export function makeDrainer(opts: {
  doFire: (role: string, why: string, focus?: string) => Promise<string>;
  trace: (what: string, detail: string) => void;
  closing: () => boolean;
}): Drainer {
  const queue: FireJob[] = [];
  let running = false;
  let firedCount = 0;
  /**
   * ★★★★★ 每个座位被派了几次（2026-10-21）
   *
   * ★ 为什么要这个账：实测「`hands-on` 整个窗口只收到 5 次挑战，另两位 24/25 次」
   *   这种事以前只能靠**事后翻 git log 数前缀**才发现 —— 也就是**看不见**。
   * ★★ 而 0 次 ≠ 没发生：它可能只是没提交。所以必须记**派活次数**，不是提交数。
   * ★ 纪律㉔：量具记的字段，必须能回答你想问的问题。
   */
  const byRole: Record<string, number> = {};
  /** ★ 真正在跑的 doFire 个数（★ 必须恒 ≤1 —— 这就是设计） */
  let inflight = 0;
  /** ★ 同时在跑的最大值（读数 —— 测试断言它恒为 1） */
  let peak = 0;

  /**
   * ★ 这一位是否**已经排了或在跑**（★ 去重：同一专家只需要被叫一次）
   *
   * ★★★ 实测 bug（我第一版漏了）：「在跑的那一位」不在队列里（已经 shift 走了）
   *   ⇒ 连排 3 次 archivist 会真的派 3 次。
   *   ⇒ 必须把 `runningRole` 也算进来。
   */
  let runningRole: string | null = null;
  const runningRoles = new Set<string>();
  const has = (role: string) => runningRoles.has(role) || queue.some((j) => j.role === role);

  /**
   * ★★★ 2026-10-21 · 峰值并发 1 → N（DESIGN §4「撤掉我加的保守东西」）
   *
   *   ★ 原来是 `if (running) return;` —— 一次只跑一个。
   *     那是我在"成本"是 KPI 时的取舍；而现在设计者裁定**成本不是 KPI**。
   *   ★★ 更要紧的是：串行是「广」的**硬上限** —— 排队 1193s 的专家就是它造成的
   *     （收尾也因此拖到几分钟）。
   *   ★ 默认 2（不是 3）：先观察 `peakConcurrent` 与报错，别把并发一次拉满。
   *     可用 `HUNT_FIRE_CONCURRENCY` 调。
   */
  const MAX_INFLIGHT = (() => {
    const v = Number(process.env.HUNT_FIRE_CONCURRENCY);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 2;
  })();

  const drain = (): void => {
    // ★ 并发到上限就停（★ 不是"一次只跑一个"了）
    if (inflight >= MAX_INFLIGHT) return;
    // ★★★ 2026-10-21 修：`closing` **只挡新进队，不挡已排队的执行**
    //
    //   ★ 原来是 `if (opts.closing()) return;` —— 与「收尾时要等队列跑空」**互成死锁**：
    //     收尾后 drain 永远立刻返回 ⇒ 队列永不清空 ⇒ 收尾循环永远等下去。
    //   ★★ 实测（hunt 2026-10-21）：收尾时日志写着 `等派活器收干净（队列 2 · 在跑 1）`，
    //     然后那两个**永远没跑**，被 `dispose()` 直接关掉。
    //   ★ 正确语义（与 AGENTS「收尾态：不再 fire 新专家，**已 fire 的会跑完**」一致）：
    //     `enqueue` 拒绝新活，`drain` 照常把**已经排进来的**跑完。
    const job = queue.shift();
    if (!job) return;

    running = true;
    runningRole = job.role;
    runningRoles.add(job.role);
    firedCount++;
    byRole[job.role] = (byRole[job.role] ?? 0) + 1;
    inflight++;
    peak = Math.max(peak, inflight);
    const waited = Math.round((Date.now() - job.at) / 1000);
    opts.trace("fire", `▶ ${job.role} 开始（排队 ${waited}s）← ${job.why.slice(0, 60)}`);

    void opts
      .doFire(job.role, job.message ? `${job.why}

${job.message}` : job.why, job.focus)
      .then((text) => {
        opts.trace("fire", `✔ ${job.role} 结束（${text.length} 字）`);
        try {
          job.onDone?.(text);
        } catch (e) {
          // ★ 回调坏了不能吞 —— 它可能是 `onSettled` 写 verdict 那一步
          opts.trace("fire", `⛔ ${job.role} 的 onDone 抛错：${(e as Error).message}`);
        }
      })
      .catch((e: unknown) => {
        // ★★★ 失败必须响（本项目栽过"静默不响"多次）
        opts.trace("fire", `⛔ ${job.role} 失败：${(e as Error).message}`);
        try {
          job.onDone?.("");
        } catch {
          /* 已在上面报过 */
        }
      })
      .finally(() => {
        runningRoles.delete(job.role);
        runningRole = runningRoles.size ? [...runningRoles][0]! : null;
        running = runningRoles.size > 0;
        inflight--;
        // ★ 跑完立刻看队列里还有没有 —— 有就接着跑（★ 仍然一次一个）
        //
        // ★★★ 2026-10-21 修：原来这里是 `if (queue.length && !opts.closing()) drain();`
        //   ⇒ **收尾后不再接力** ⇒ 队列里剩下的两位永远跑不到，
        //     而收尾循环还在等"队列跑空" ⇒ **死锁**。
        //   ★ 收尾的正确语义是「不再进新活，**已排的跑完**」（AGENTS §三之二）。
        // ★ 队列还有、且并发没满 ⇒ 接力（可以同时跑多位）
        while (queue.length && inflight < MAX_INFLIGHT) drain();
      });
  };

  return {
    enqueue: (job) => {
      // ★★ 收尾后不再接受**新**活（已排的会跑完 —— 见 drain 的注释）
      if (opts.closing()) {
        opts.trace("fire", `… ${job.role} 不收（已进收尾态）← ${job.why.slice(0, 40)}`);
        return;
      }
      // ★ 去重：同一位已经在排队就不再排（否则 3 个 tick = 3 个 archivist）
      if (has(job.role)) {
        opts.trace("fire", `… ${job.role} 已在队列里，不重复排`);
        return;
      }
      queue.push({ ...job, at: Date.now() });
      opts.trace("fire", `… ${job.role} 排队（队列 ${queue.length}）← ${job.why.slice(0, 50)}`);
      drain();
    },
    drain,
    busy: () => inflight > 0,
    queued: () => queue.length,
    fired: () => firedCount,
    /** ★ 每个座位被派了几次（★ 用来查「哪个角度没在干活」） */
    byRole: () => ({ ...byRole }),
    peakConcurrent: () => peak,
    /** ★ 丢掉**排队未开工**的（收尾用：排队 ≠ 已在跑） */
    clear: () => {
      queue.length = 0;
    },
  };
}
