# Example: ask and write

An agent that asks a person a question (`ask_person`), waits for the answer, then writes `greeting.txt` with it.
It runs offline on the scripted model: no API key and no network.

```sh
node --disable-warning=ExperimentalWarning examples/ask-and-write/run.ts
```

What `run.ts` does:

1. starts Runwright in a temporary data directory on a free port;
2. saves the agent from `agent.json` (id `ask-and-write`);
3. starts a run and shows it `waiting`, with the open question listed as a pending;
4. answers `Ada`, waits for `completed` and prints `greeting.txt` (`Hello, Ada!`);
5. prints a JSON summary line, stops the server and deletes the directory.

`agent.json` has the shape `runwright agents save` accepts, so the same agent can be used with the CLI against
a running server:

```sh
runwright agents save examples/ask-and-write/agent.json
runwright runs start ask-and-write --message "Please greet me." --wait   # exit 8: the run waits for an answer
runwright runs answer @last Ada
runwright runs wait @last                                                # exit 0: completed
runwright runs files @last greeting.txt
```

`runs start` returns as soon as the run is queued, so the block waits for the question (`--wait`, which exits 8
while the run waits on a person) before answering it. Run from the repository root, `runwright` is
`node bin/runwright.ts`.
