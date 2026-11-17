# Example: triage workflow

A typed, deterministic workflow instead of an open-ended agent loop. A yes/no decision asks "is this ticket
urgent?"; an answer with confidence below 0.7 is routed to an agent hand-off that reviews the ticket and gives a
typed verdict. A branch then writes `urgent.txt` or `routine.txt`.

```sh
node --disable-warning=ExperimentalWarning examples/triage-workflow/run.ts
```

- `workflow.ts` writes the document with the TypeScript builder; `workflow.json` is the same document as JSON
  (`runwright workflows validate examples/triage-workflow/workflow.json`), and `agent.json` embeds it as the
  agent's `workflow`. `run.ts` checks that the three agree.
- The scripted model answers the outage ticket with confidence 0.95 (route `confident`) and the printer ticket
  with 0.4 (route `low_confidence`, so the `review` agent decides).

`run.ts` validates the document, dry-runs it (no model call and no tool call), prints its Mermaid graph, runs
both tickets and prints the route each one took, read from the run's journal, then a JSON summary line.
