# Example: learning

An agent with `learning: true`. Its first run does the job the long way: it explores the workspace, drafts,
reads the draft back and only then writes `release-notes.txt`. After the run, the learning turn proposes one
note and one skill; code checks them, the grader (scripted here) keeps both, and they are stored as versioned
items. The second run is given them in its system prompt and writes the file in one step.

```sh
node --disable-warning=ExperimentalWarning examples/learning/run.ts
```

`run.ts` runs the agent twice and prints, for each run, the turns, the job's own cost and tokens (the learning
and grading calls are counted separately) and which items it was given; then the stored items and the agent's
before/after learning metrics, and a JSON summary line. It exits 1 if the second run is not cheaper than the
first.

The scripted model is deterministic: the shorter path is a script variant chosen when the system prompt
contains the note's title, which only happens once the note was learned and given to the run.
