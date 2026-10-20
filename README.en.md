# aiteam

> A research project. It studies one thing: **how to use the practice of organizing large language models through code — and use it well.**

English | [简体中文](README.md)

---

## What we research

A new mode of production is emerging:

> Organizing large language models through **code**, in a rigorously logical way, to use this **intelligence that costs almost nothing** effectively and at high quality.

Nobody has this figured out. This repository studies it.

Three words constrain what it is:

- **Through code.** The orchestration lives in code — readable, reviewable, reproducible. Not steering it with prompts, and not letting the model decide for itself.
- **Effective, and high quality.** These are two requirements, not one. Reaching the end is not enough; the result has to be good.
- **Intelligence is nearly free.** This is not about "saving money" — the **premise has changed**. Everything else has a cost, so "should we do this at all" is naturally constrained; calling an LLM is now cheap enough that it no longer constrains anything. So many shapes that never worked before now do — redundancy, multiple versions, rerunning repeatedly, one agent dispatching ten agents to try.

What we want out of this is **experience** and **good practice** in using the new mode of production. "Good" is drawn deliberately wide: anything that makes this mode of production better counts, including but not limited to:

| | |
|---|---|
| **Design** | How should a given kind of work be organized? |
| **Attribution** | When something goes wrong, which property of it caused that? |
| **Exploitation** | Given a property, what can it be used for? |
| **Analysis** | Given a class of situation, how do you spot the problem? |
| **Optimization** | Once you see it, which direction do you change? |

The middle two are the fulcrum: they require first understanding *what properties LLMs have as a means of production*, before you can talk about guarding against them or exploiting them.

So the object of study is not "an agent cluster" — it is the **human + code + agent production system**. This is a discipline that has to grow out of practice, not a checklist — which is why it deliberately refuses a narrow definition.

---

## Something that gets confused

This is easily mistaken for "using AI to help me write code."

| | AI-assisted programming | Here |
|---|---|---|
| Who is doing the work | AI helps **you** write code | **You write code to organize agents doing the work** |
| What you write | Product code | **Organizational code**: topology, rules, boundaries |
| Scaling comes from | You writing faster | **The organizational shape your code defines** |

In assisted programming, AI is a tool. Here, AI is **organized productive capacity**, and what organizes it is code.

The dividing line falls after the cost changes. In the old world, writing code, buying machines, hiring people all cost something, so people had reason to be careful and efficient; in the new world that constraint largely disappears, and **the question shifts from "how do we do this cheapest" to "how do we organize this so it's done right."**

Why it has to be code: you cannot precisely tell twenty agents in natural language what their dependencies on each other are, but you can write it down. **Write "when this happens → do that" into code, and let the agents act autonomously inside that structure** — rather than directing them every round, which is automation, not organization.

Artifacts are disposable; **the cluster's code is an iterable asset**. After a milestone is done, what you go back and change is the cluster's code, not the code it wrote.

A test you can apply right now: ask yourself, **"Am I telling it what to do, or am I specifying when it should do what?"** The former is using it as a tool; the latter is organizing it.

---

## What the research looks like

The method is not "do the research yourself." It is: **design a researcher cluster, and let the research happen inside the cluster.**

```
Layer 1   Researcher cluster
          picks its own problems · designs its own experiments · runs them
          · reads the data · judges whether it has done enough
              ↓ uses the library to build experimental apparatus, and measures
Layer 2   That mode of production itself
          how to use it well · what properties it has · how to analyze each situation
              ↓
          Knowledge about it: practices · properties · analytical methods
```

Adding this one layer buys four things:

- **It doesn't drift from reality.** Problems come from friction actually hit in production, not concepts picked from theory. We got this wrong before — early on we used systems science as the source of problems, and all 109 rounds of data are still there, yet not one of them could answer "what should we do."
- **Findings are usable on the spot.** Conclusions immediately feed back into changing the research itself, without waiting for publication.
- **Self-consistency.** If this paradigm really holds, it should be able to produce knowledge about itself. Failing to do so is itself a counterexample.
- **The object of study is the production system, not the cluster.** The cluster is the means. This is easy to misread, and once you misread it you end up asking "is multi-agent any good" instead of "how do we get the work done."

The cluster is explicitly barred from **degenerating into an executor**:

| Its job | Not its job |
|---|---|
| Find its own problems, judge which are worth doing | Work through someone else's list of topics |
| Design experiments: variables, controls, criteria, frozen before the run | Execute steps someone else laid out |
| Run, read data, analyze, derive practices | Write literature reviews, concept surveys |
| Judge whether it has done enough | Wait for someone else to count rounds and decide to stop |

This has a measured cost. The first version of the briefing document packed in 5,000 words of identity, 26 existing findings, three task families, a fixed eight-step workflow. The result: the cluster spent three consecutive rounds working on **the problem the designer had picked for it**. Its autonomy hadn't failed — it had **never been switched on**. It was later cut down to a single goal-level rule, plus one line: "how to do it is up to you."

One corollary: **if Layer 1 picks the topics for Layer 2, the two layers collapse into one.**

---

## Where the human is

This project is not "let agents do the work for people."

The human steps back half a pace from the decision point of every experiment, and stands at the **meta level**: setting goals, reviewing findings, deciding what enters the repository. Proposals the cluster hands up — "I need to change the library," "I need to reach outside this repo" — get analyzed by a human, and a human does them. The human does not pick problems for it, run for it, or write conclusions for it, because doing so would demote it back to an executor.

Longer term: the human labors with a new tool. Historically, human value has lain in using knowledge and tools to reshape the world, and in this era the best tool is this. So the real question here is not "what can agents do" but **how do we let people make greater use of it**.

One more thing that's easy to miss: **self-review must use an agent with a clean context.** The reviewer's context contains no trace of the reviewed agent's reasoning, only its artifacts — so it cannot be persuaded by a line of reasoning, only by evidence. This is implemented directly through the library's context surface, not by asking it in a prompt to be fair.

---

## The library

The work above needs a tool that can do two things: **manipulate an agent down to its foundations**, and **take out everything it received** to look at. Without the first, all you can say is "have a think"; without the second, you can only see whether the result was right, and never why.

`src/` is that tool: an agent control library with eight surfaces — dispatch and settlement, context, tools, permissions, extensions, skills, model, and observation. Deliberately thin, built on the [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK, doing only "organizing the surfaces" and "settling the run."

Two requirements run through the whole library: **control must be absolute** (anything pi can do, your code can turn), and **materials must be extractable** (context, events, tool calls, usage — all programmable). Two prohibitions: don't over-abstract (every wrapper costs you a knob), don't productize (a product decides for the user; a research tool doesn't).

**The library contains no policy.** Rosters, delegation, guardrails, red lines are all user code — because those are exactly what this project studies.

It is not the object of study. It is the bench.

```bash
npm install
node dev/examples/12-team.ts      # a complete multi-agent collaboration, no key needed
```

```ts
import { createLab } from "./src/index.ts";

const lab = await createLab({
  agentDir: "./my-pi",   // environment: credentials, models, skills, extensions. Required.
  cwd: "./work",         // working directory. Required.
});

const agent = await lab.createAgent({ id: "retriever", model: "…" });
const result = await agent.io.prompt("…");      // one run = agent_start → agent_settled
```

Miss either environment field and it throws — no defaults, and no falling back to your local pi directory. That is the precondition for reproducible experiments.

Install, usage, the full description of all eight surfaces, examples, the experiment scaffold, and development discipline are all in [`docs/USAGE.md`](docs/USAGE.md) (in Chinese).

> The observation surface deserves its own note: it was added later, under pressure. We could originally only see tool calls, and so we ran into a case where "three of four interventions failed silently" and could not diagnose it — **we could not tell "it didn't listen" from "it never received."** Once it was added, a stuck mechanism puzzle opened up on the spot. **What you can see determines what you can ask.**

---

## Where the material is

```
research/
├── clusters/   the researcher cluster's code (what we research with)
├── labfirst/   the cluster's own space: manual, work area, outputs, a writable library
├── docs/       material for this direction
│                findings · experiments · planning · surveys · cluster design · apparatus
└── book/       the final deliverable, a textbook still being written

dev/
├── docs/       the library's design source and implementation decisions
│                DESIGN.md (design source) · FACTS.md (measured decisions) · GUIDE.md (usage)
└── examples/ · demo/ · test/
```

Start with conclusions in `research/docs/成果/` (findings). To see how they were reached, go to `research/docs/实验/` (experiments). To walk the whole path of this direction, see `research/docs/研究规划.md` (research plan). These are in Chinese.

Before 2026-10-19 this directory was called `lab-3b`. External references to the old path now point at a directory that no longer exists.

---

## What we don't promise

- **Not a security boundary.** pi has no built-in sandbox; `permissions.only` is only toolset trimming, and extensions or `bash` can bypass it. What is offered here is capability trimming plus an approval gate — real isolation only comes from a container or VM.
- **The long-run state layer isn't there.** Context overflow, budgets, long-run recovery — none of these are promised.

---

## License

MIT, see [LICENSE](LICENSE).
