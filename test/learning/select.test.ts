import { test } from "node:test";
import assert from "node:assert/strict";
import { textTokens } from "../../src/models/util.ts";
import type { LearningContext } from "../../src/engine/types.ts";
import type { LearningItem } from "../../src/store/types.ts";
import { rankBm25 } from "../../src/learning/bm25.ts";
import { renderItem, renderLine } from "../../src/learning/proposal.ts";
import { selectItems, SECTION_HEADING } from "../../src/learning/select.ts";

function item(id: string, kind: "note" | "skill", name: string, title: string, body: string, updatedAt = 1): LearningItem {
  return {
    id, agentId: "a", kind, name, title, description: `About ${title.toLowerCase()}.`, body, status: "active", version: 2,
    etag: "2-00000000", sourceRunId: null, promotedWorkflow: null, promotedWorkflowVersion: null, promotionAttempts: 0, createdAt: 1, updatedAt,
  };
}

const filler = (topic: string): string => `${topic} `.repeat(60) + "and more details that make this body long enough to matter.";

const items = [
  item("i1", "note", "invoices", "Invoice numbering", filler("invoices numbering prefix")),
  item("i2", "note", "deploy", "Deploying the app", filler("deploy staging script")),
  item("i3", "skill", "release", "Cutting a release", filler("release tag version")),
  item("i4", "note", "database", "Database access", filler("database credentials role")),
];

test("under budget every item is given in full, skills first then by name", () => {
  const result = selectItems(items, "anything", 100_000);
  assert.deepEqual(result.given.map((g) => [g.name, g.mode]), [["release", "full"], ["database", "full"], ["deploy", "full"], ["invoices", "full"]]);
  assert.deepEqual(result.tools, []);
  assert.ok(result.promptSection.startsWith(SECTION_HEADING));
  assert.ok(result.promptSection.includes("## [skill] release — Cutting a release\nAbout cutting a release.\n\n"));
  assert.ok(!result.promptSection.includes("recall"));
});

test("over budget the items most relevant to the first message are full and the rest one line each", () => {
  const one = textTokens(`## [note] deploy — Deploying the app\nAbout deploying the app.\n\n${filler("deploy staging script")}\n\n`);
  const budget = one + 200;
  assert.equal(linesFit(items, budget), true, "every line fits (case a): the most relevant item is upgraded to whole");
  const result = selectItems(items, "please deploy the new build to staging", budget);
  assert.deepEqual(result.given.map((g) => [g.name, g.mode]), [["deploy", "full"], ["database", "line"], ["invoices", "line"], ["release", "line"]]);
  assert.deepEqual(result.tools, ["recall"]);
  assert.ok(result.promptSection.includes("- [note] invoices — Invoice numbering: About invoice numbering."));
  assert.ok(result.promptSection.includes("`recall` tool"));
  assert.ok(textTokens(result.promptSection) <= budget);

  const other = selectItems(items, "how are invoices numbered", budget);
  assert.equal(other.given.find((g) => g.mode === "full")?.name, "invoices");
});

test("the section never exceeds the budget, lines that cannot fit are left out", () => {
  for (const budget of [0, 10, 40, 60, 80, 120, 300, 500, 700, 1000, 2000]) {
    const result = selectItems(items, "deploy", budget);
    assert.ok(textTokens(result.promptSection) <= budget, `budget ${budget}`);
    assert.equal(result.tools.length > 0, result.given.some((g) => g.mode === "line"), `budget ${budget}`);
  }
  assert.equal(linesFit(items, 75), false, "budget 75: case (b)");
  const tight = selectItems(items, "database role", 75);
  assert.ok(tight.given.length > 0 && tight.given.length < items.length);
  assert.equal(tight.given[0]?.name, "database", "the best-ranked line is kept first");
  assert.deepEqual(selectItems(items, "x", 5), { promptSection: "", given: [], tools: [] });
});

test("selection is deterministic and ties fall back to newest first, then name", () => {
  const tied = [item("a", "note", "beta", "Beta", filler("same words"), 5), item("b", "note", "alpha", "Alpha", filler("same words"), 5),
    item("c", "note", "gamma", "Gamma", filler("same words"), 9)];
  const first = selectItems(tied, "unrelated query", 120);
  const second = selectItems([...tied].reverse(), "unrelated query", 120);
  assert.deepEqual(first, second);
  assert.deepEqual(first.given.map((g) => g.name), ["gamma", "alpha", "beta"]);
});

test("no items gives an empty context; a promoted skill names its workflow and version", () => {
  assert.deepEqual(selectItems([], "go", 2000), { promptSection: "", given: [], tools: [] });
  const name = "skill-release-01jabcdefghjkmnpqrstvwxyz0";
  const promoted = { ...item("p", "skill", "release", "Release", "Do it."), promotedWorkflow: name, promotedWorkflowVersion: 3 };
  const result = selectItems([promoted], "go", 2000);
  assert.ok(result.promptSection.includes(
    `Saved as workflow \`${name}\` version 3: run it with the \`run_workflow\` tool, passing this name and version.`,
  ));
  assert.deepEqual(result.given, [{ itemId: "p", version: 2, kind: "skill", name: "release", mode: "full" }]);
});

test("the one-line form of a promoted skill names its workflow and version", () => {
  const name = "skill-release-01jabcdefghjkmnpqrstvwxyz0";
  const promoted = { ...item("p", "skill", "release", "Cutting a release", filler("release tag version")), promotedWorkflow: name, promotedWorkflowVersion: 3 };
  const result = selectItems([promoted, ...items.filter((i) => i.kind === "note")], "deploy to staging", 150);
  assert.equal(result.given.find((g) => g.itemId === "p")?.mode, "line");
  assert.ok(result.promptSection.includes(
    `- [skill] release — Cutting a release: About cutting a release. (workflow \`${name}\` version 3, use \`run_workflow\`)`,
  ));
});

test("a promoted skill without a recorded version keeps the unversioned text", () => {
  const promoted = { ...item("p", "skill", "release", "Release", "Do it."), promotedWorkflow: "old-flow" };
  const result = selectItems([promoted], "go", 2000);
  assert.ok(result.promptSection.includes("Saved as workflow `old-flow`: run it with the `run_workflow` tool."));
});

// ---------------------------------------------------------------- rule S2: the reference and its properties

const INTRO_ALL = "These notes and skills were kept from earlier runs of this agent. Use them where they apply.";
const INTRO_LINES = "These notes and skills were kept from earlier runs of this agent. Items listed on one line are "
  + "summaries: open one in full with the `recall` tool (pass the item's name).";
const INTRO_NO_RECALL = "These notes and skills were kept from earlier runs of this agent. Items listed on one line are summaries only.";

const headWith = (withLines: boolean, recall = true): string =>
  `${SECTION_HEADING}\n\n${withLines ? (recall ? INTRO_LINES : INTRO_NO_RECALL) : INTRO_ALL}\n\n`;
const wholeCost = (i: LearningItem): number => textTokens(`${renderItem(i)}\n\n`);
const lineCost = (i: LearningItem): number => textTokens(`${renderLine(i)}\n`);
/** The budget charged before any item: the larger heading. */
const headCost = (recall = true): number => Math.max(textTokens(headWith(true, recall)), textTokens(headWith(false, recall)));
/** Case (a) of rule S2 holds at `budget`: one line for every item fits (with the larger heading). */
const linesFit = (set: readonly LearningItem[], budget: number, recall = true): boolean =>
  headCost(recall) + set.reduce((sum, i) => sum + lineCost(i), 0) <= budget;
const fitsWhole = (set: readonly LearningItem[], budget: number, recall = true): boolean =>
  textTokens(headWith(false, recall)) + set.reduce((sum, i) => sum + wholeCost(i), 0) <= budget;
const modeOf = (context: LearningContext, id: string): string => context.given.find((g) => g.itemId === id)?.mode ?? "left out";

function ranking(all: readonly LearningItem[], firstMessage: string): LearningItem[] {
  const names = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const tieOrder = [...all].sort((a, b) => b.updatedAt - a.updatedAt || names(a.name, b.name));
  const byId = new Map(tieOrder.map((i) => [i.id, i]));
  return rankBm25(firstMessage, tieOrder).map((score) => byId.get(score.id) as LearningItem);
}

/**
 * Rule S2 written as plainly as possible (costs recomputed wherever they are needed): the reference. Everything
 * fits → all whole, skills first then by name. Otherwise in BM25 rank order, the larger heading charged from the
 * start: (a) when every item's line fits, all start as lines and an item becomes whole when the difference still
 * fits; (b) otherwise whole if it fits in what is left, else one line if that fits, else left out.
 */
function referenceSelect(all: readonly LearningItem[], firstMessage: string, budgetTokens: number, recall = true): LearningContext {
  const fullPiece = (i: LearningItem): string => `${renderItem(i)}\n\n`;
  const linePiece = (i: LearningItem): string => `${renderLine(i)}\n`;
  const names = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const given = (i: LearningItem, mode: "full" | "line") => ({ itemId: i.id, version: i.version, kind: i.kind, name: i.name, mode });
  const assemble = (full: readonly LearningItem[], lines: readonly LearningItem[]): LearningContext => {
    if (full.length === 0 && lines.length === 0) return { promptSection: "", given: [], tools: [] };
    const text = headWith(lines.length > 0, recall) + full.map(fullPiece).join("") + lines.map(linePiece).join("");
    return {
      promptSection: text.trimEnd(),
      given: [...full.map((i) => given(i, "full")), ...lines.map((i) => given(i, "line"))],
      tools: lines.length > 0 && recall ? ["recall"] : [],
    };
  };
  if (all.length === 0) return assemble([], []);
  const byKindAndName = [...all].sort((a, b) => (a.kind === b.kind ? names(a.name, b.name) : a.kind === "skill" ? -1 : 1));
  if (fitsWhole(all, budgetTokens, recall)) return assemble(byKindAndName, []);
  const ranked = ranking(all, firstMessage);
  let left = budgetTokens - headCost(recall);
  if (left < 0) return assemble([], []);
  if (linesFit(all, budgetTokens, recall)) {
    left -= ranked.reduce((sum, i) => sum + lineCost(i), 0);
    const whole = new Set<LearningItem>();
    for (const i of ranked) {
      if (wholeCost(i) - lineCost(i) <= left) {
        whole.add(i);
        left -= wholeCost(i) - lineCost(i);
      }
    }
    return assemble(ranked.filter((i) => whole.has(i)), ranked.filter((i) => !whole.has(i)));
  }
  const full: LearningItem[] = [];
  const lines: LearningItem[] = [];
  for (const i of ranked) {
    if (wholeCost(i) <= left) {
      full.push(i);
      left -= wholeCost(i);
    } else if (lineCost(i) <= left) {
      lines.push(i);
      left -= lineCost(i);
    }
  }
  return assemble(full, lines);
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["deploy", "staging", "invoice", "number", "database", "role", "release", "tag", "build", "cache", "token", "report",
  "weekly", "tests", "port", "migrate", "schema", "api", "gateway", "queue", "retry", "cron", "webhook", "archive"];

function randomItems(random: () => number, count: number): LearningItem[] {
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)] as string;
  const words = (n: number): string => Array.from({ length: n }, pick).join(" ");
  return Array.from({ length: count }, (_, index) => {
    const kind = random() < 0.3 ? "skill" : "note";
    const base = item(`id${index}`, kind, `${pick()}-${index}`, words(1 + Math.floor(random() * 5)), words(Math.floor(random() * 120) + 1),
      Math.floor(random() * 4));
    const promoted = kind === "skill" && random() < 0.3;
    return promoted ? { ...base, promotedWorkflow: `skill-${base.name}`, promotedWorkflowVersion: random() < 0.5 ? null : 1 + Math.floor(random() * 5) } : base;
  });
}

test("for 300 random item sets the selection is exactly the reference algorithm's", () => {
  const random = seeded(20261114);
  let overBudget = 0;
  for (let round = 0; round < 300; round++) {
    const set = randomItems(random, Math.floor(random() * 25));
    const total = set.reduce((sum, i) => sum + textTokens(`${renderItem(i)}\n\n`), 60);
    const budget = Math.floor(random() * total * 1.2);
    const message = Array.from({ length: 1 + Math.floor(random() * 8) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
    const expected = referenceSelect(set, message, budget);
    if (expected.tools.length > 0) overBudget += 1;
    assert.deepEqual(selectItems(set, message, budget), expected, `round ${round}`);
    assert.deepEqual(selectItems(set, message, budget, { recall: false }), referenceSelect(set, message, budget, false), `round ${round}, recall denied`);
  }
  assert.ok(overBudget > 100, `the random sets exercise the over-budget path (${overBudget} of 300)`);
});

test("the estimator is called at most 2 × items + 2 times, also for 5000 items over budget", () => {
  const random = seeded(7);
  const many = randomItems(random, 5000);
  let calls = 0;
  const counting = (text: string): number => {
    calls += 1;
    return textTokens(text);
  };
  const budget = many.reduce((sum, i) => sum + textTokens(`${renderLine(i)}\n`), 5000);
  const result = selectItems(many, "deploy the release to staging", budget, { estimate: counting });
  assert.ok(calls >= many.length && calls <= 2 * many.length + 2, `${calls} calls`);
  assert.ok(result.given.some((g) => g.mode === "full") && result.given.some((g) => g.mode === "line"));
  assert.ok(textTokens(result.promptSection) <= budget);

  calls = 0;
  selectItems(many, "anything", 1e12, { estimate: counting });
  assert.ok(calls <= 2 * many.length + 2, `${calls} calls under budget`);
  for (const budget of [0, 1, 100, 1000]) {
    calls = 0;
    selectItems(many, "deploy", budget, { estimate: counting });
    assert.ok(calls <= 2 * many.length + 2, `${calls} calls at budget ${budget}`);
  }
});

test("a custom estimator decides what fits", () => {
  const everythingFree = selectItems(items, "deploy", 0, { estimate: () => 0 });
  assert.deepEqual(everythingFree.given.map((g) => g.mode), ["full", "full", "full", "full"]);
  const nothingFits = selectItems(items, "deploy", 1000, { estimate: () => 1001 });
  assert.deepEqual(nothingFits, { promptSection: "", given: [], tools: [] });
});

// ---------------------------------------------------------------- R13D-spec-04 / R13D-learning-02: relevance decides

/** 100 notes of about the same size on unrelated topics, plus `extra`. */
function hundredNotes(extra: readonly LearningItem[] = []): LearningItem[] {
  const topics = WORDS.slice(0, 20);
  const notes = Array.from({ length: 100 }, (_, i) => {
    const topic = topics[i % topics.length] as string;
    return item(`n${i}`, "note", `${topic}-${i}`, `About ${topic} ${i}`, `${topic} notes number ${i}: ${"plain words of filler text ".repeat(4)}`, 1);
  });
  return [...notes, ...extra];
}

test("the reviewer's probes: with 100 notes the most relevant one is given whole when it fits alone", () => {
  const relevant = item("rel", "note", "kiln-firing", "Kiln firing schedule", "Fire the kiln at 1240 degrees for six hours, then let it cool overnight.", 1);
  for (const budget of [300, 200]) {
    const set = hundredNotes([relevant]);
    assert.equal(linesFit(set, budget), false, `budget ${budget}: the lines of 101 notes do not all fit (case b)`);
    const result = selectItems(set, "what is the kiln firing schedule", budget);
    assert.deepEqual(result.given[0], { itemId: "rel", version: 2, kind: "note", name: "kiln-firing", mode: "full" }, `budget ${budget}`);
    assert.ok(result.given.some((g) => g.mode === "line"), `budget ${budget}: the rest is listed as lines while they fit`);
    assert.ok(textTokens(result.promptSection) <= budget, `budget ${budget}`);
    assert.deepEqual(result, referenceSelect(set, "what is the kiln firing schedule", budget));
  }
});

test("an item too large to be whole is a line while smaller, lower-ranked items after it are whole", () => {
  const big = item("big", "note", "deploy-big", "Deploy staging deploy", filler("deploy staging script deploy"), 1);
  const small = item("small", "note", "deploy-small", "Deploy note", "Deploy with the script.", 1);
  const other = item("other", "note", "database", "Database", "The database needs the admin role.", 1);
  const budget = textTokens(`${SECTION_HEADING}\n\n${INTRO_LINES}\n\n`) + textTokens(`${renderItem(small)}\n\n`)
    + textTokens(`${renderItem(other)}\n\n`) + textTokens(`${renderLine(big)}\n`);
  // Older unrelated items rank after these three; their lines no longer fit and must not displace anything.
  const older = Array.from({ length: 30 }, (_, i) => item(`old${i}`, "note", `archive-${i}`, `Archive ${i}`, "Rows of the old archive.", 0));
  assert.equal(linesFit([big, small, other, ...older], budget), false, "the 33 lines do not all fit (case b)");
  const result = selectItems([big, small, other, ...older], "deploy staging", budget);
  assert.equal(rankBm25("deploy staging", [big, small, other])[0]?.id, "big");
  assert.deepEqual(result.given.map((g) => [g.itemId, g.mode]), [["small", "full"], ["other", "full"], ["big", "line"]]);
  assert.ok(textTokens(result.promptSection) <= budget);
});

test("monotone: in case (b) adding lower-ranked items never changes how a higher-ranked item is given; in case (a) every item stays given", () => {
  const random = seeded(1311);
  let comparedB = 0;
  let comparedA = 0;
  for (let round = 0; round < 600; round++) {
    // A query of a word no item uses: every score is 0, so the rank is newest first, then name, whatever is added.
    const set = randomItems(random, 1 + Math.floor(random() * 20));
    const extra = randomItems(random, 1 + Math.floor(random() * 30)).map((i, n) => ({ ...i, id: `x${n}`, name: `zz-${i.name}`, updatedAt: -1 }));
    const total = set.reduce((sum, i) => sum + wholeCost(i), 60);
    const budget = Math.floor(random() * total);
    // Only over budget is the rank order used; a set that fits whole is laid out by kind and name instead.
    if (fitsWhole(set, budget)) continue;
    const both = [...set, ...extra];
    const alone = selectItems(set, "zebra", budget);
    const more = selectItems(both, "zebra", budget);
    if (!linesFit(set, budget) && !linesFit(both, budget)) {
      comparedB += 1;
      for (const i of set) assert.equal(modeOf(more, i.id), modeOf(alone, i.id), `round ${round}, item ${i.id}`);
    }
    if (linesFit(both, budget)) {
      comparedA += 1;
      assert.equal(alone.given.length, set.length, `round ${round}: every item of the set is given`);
      assert.equal(more.given.length, both.length, `round ${round}: every item of the larger set is given`);
    }
  }
  assert.ok(comparedB > 100, `${comparedB} rounds compared in case (b)`);
  assert.ok(comparedA > 10, `${comparedA} rounds compared in case (a)`);
});

test("the section never exceeds the budget for every budget from 0 to the full size", () => {
  const set = hundredNotes().slice(0, 30);
  const full = selectItems(set, "cache", 1e12);
  const size = textTokens(full.promptSection) + 40;
  for (let budget = 0; budget <= size; budget += 1) {
    const result = selectItems(set, "cache", budget);
    assert.ok(textTokens(result.promptSection) <= budget, `budget ${budget}`);
  }
});

test("with recall denied the lines are still listed, the intro does not mention recall and no tool is granted", () => {
  const budget = textTokens(`## [note] deploy — Deploying the app\nAbout deploying the app.\n\n${filler("deploy staging script")}\n\n`) + 200;
  const result = selectItems(items, "please deploy the new build to staging", budget, { recall: false });
  assert.deepEqual(result.given.map((g) => [g.name, g.mode]), [["deploy", "full"], ["database", "line"], ["invoices", "line"], ["release", "line"]]);
  assert.deepEqual(result.tools, []);
  assert.ok(!result.promptSection.includes("recall"));
  assert.ok(result.promptSection.includes(INTRO_NO_RECALL));
  assert.ok(result.promptSection.includes("- [note] invoices — Invoice numbering: About invoice numbering."));
  assert.ok(textTokens(result.promptSection) <= budget);
});

// ---------------------------------------------------------------- R14D-spec-03: rule S2

function pair(): { alpha: LearningItem; beta: LearningItem } {
  return {
    alpha: item("alpha", "note", "alpha", "Alpha", "useful alpha ".repeat(50)),
    beta: item("beta", "note", "beta", "Beta", "useful beta ".repeat(50)),
  };
}

test("the round-14 probe: two notes whose lines both fit are both given, neither is left out", () => {
  const { alpha, beta } = pair();
  assert.equal(linesFit([alpha, beta], 226), true, "both lines fit at 226 (case a)");
  assert.equal(fitsWhole([alpha, beta], 226), false);
  const result = selectItems([alpha, beta], "alpha", 226);
  assert.deepEqual(result.given.map((g) => g.itemId).sort(), ["alpha", "beta"], "alpha is not left out and beta is not left out");
  assert.ok(result.promptSection.includes("alpha — Alpha"), "alpha is in the prompt section");
  assert.ok(result.promptSection.includes("beta — Beta"), "beta is in the prompt section");
  assert.deepEqual(result.tools, ["recall"], "a line can be opened");
  assert.ok(textTokens(result.promptSection) <= 226);
  assert.deepEqual(result, referenceSelect([alpha, beta], "alpha", 226));
});

test("case (a): for random sets and every budget at which all lines fit, every item is given and the whole ones are the upgrade loop's", () => {
  const random = seeded(2026_11_16);
  let checked = 0;
  for (let round = 0; round < 60; round++) {
    const set = randomItems(random, 1 + Math.floor(random() * 15));
    const message = Array.from({ length: 1 + Math.floor(random() * 4) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
    const from = headCost() + set.reduce((sum, i) => sum + lineCost(i), 0);
    const to = textTokens(headWith(false)) + set.reduce((sum, i) => sum + wholeCost(i), 0);
    const ranked = ranking(set, message);
    for (let budget = from; budget < to; budget += Math.max(1, Math.floor((to - from) / 25))) {
      if (fitsWhole(set, budget)) continue;
      checked += 1;
      const result = selectItems(set, message, budget);
      assert.equal(result.given.length, set.length, `round ${round}, budget ${budget}`);
      let used = from;
      const upgraded: string[] = [];
      for (const i of ranked) {
        if (used - lineCost(i) + wholeCost(i) <= budget) {
          upgraded.push(i.id);
          used += wholeCost(i) - lineCost(i);
        }
      }
      assert.deepEqual(result.given.filter((g) => g.mode === "full").map((g) => g.itemId), upgraded, `round ${round}, budget ${budget}`);
      assert.deepEqual(result.given.filter((g) => g.mode === "line").map((g) => g.itemId), ranked.map((i) => i.id).filter((id) => !upgraded.includes(id)));
      assert.ok(textTokens(result.promptSection) <= budget, `round ${round}, budget ${budget}`);
    }
  }
  assert.ok(checked > 300, `${checked} case (a) budgets checked`);
});

test("the boundary: at heading + all lines exactly every item is a line (case a); one token less some item is left out (case b)", () => {
  const set = items;
  const boundary = headCost() + set.reduce((sum, i) => sum + lineCost(i), 0);
  const at = selectItems(set, "deploy staging", boundary);
  assert.deepEqual(at.given.map((g) => g.mode), ["line", "line", "line", "line"], "no room to upgrade: every item is its line");
  assert.ok(textTokens(at.promptSection) <= boundary);
  const below = selectItems(set, "deploy staging", boundary - 1);
  assert.ok(below.given.length < set.length, "case (b): the lines cannot all be listed, so relevance decides what is left out");
  assert.ok(textTokens(below.promptSection) <= boundary - 1);
  assert.deepEqual(below, referenceSelect(set, "deploy staging", boundary - 1));
});

test("case (a): a less relevant item is whole while a more relevant one is a line only when its upgrade costs strictly less", () => {
  const random = seeded(4242);
  let pairs = 0;
  for (let round = 0; round < 200; round++) {
    const set = randomItems(random, 2 + Math.floor(random() * 12));
    const message = Array.from({ length: 1 + Math.floor(random() * 4) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
    const from = headCost() + set.reduce((sum, i) => sum + lineCost(i), 0);
    const to = textTokens(headWith(false)) + set.reduce((sum, i) => sum + wholeCost(i), 0);
    if (to <= from) continue;
    const budget = from + Math.floor(random() * (to - from));
    if (fitsWhole(set, budget)) continue;
    const result = selectItems(set, message, budget);
    const ranked = ranking(set, message);
    const upgrade = (i: LearningItem): number => wholeCost(i) - lineCost(i);
    for (let hi = 0; hi < ranked.length; hi++) {
      for (let lo = hi + 1; lo < ranked.length; lo++) {
        const higher = ranked[hi] as LearningItem;
        const lower = ranked[lo] as LearningItem;
        if (modeOf(result, higher.id) === "line" && modeOf(result, lower.id) === "full") {
          pairs += 1;
          assert.ok(upgrade(lower) < upgrade(higher), `round ${round}: ${lower.id} is whole before ${higher.id} at no smaller cost`);
        }
      }
    }
  }
  const { alpha, beta } = pair();
  const probe = selectItems([alpha, beta], "alpha", 226);
  assert.deepEqual(probe.given.map((g) => [g.itemId, g.mode]), [["beta", "full"], ["alpha", "line"]],
    "the trade-off: the more relevant alpha costs more to upgrade, so it is a line and recall opens it");
  assert.ok(pairs > 20, `${pairs} pairs of a whole lower-ranked and a line higher-ranked item checked`);
});
