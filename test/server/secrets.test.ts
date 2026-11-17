import { test } from "node:test";
import assert from "node:assert/strict";
import { authed, claim, errorOf, seedRun, startTestServer, testAgentDefinition } from "./support.ts";

const VALUE = "sk-live-RECOGNISABLE-7f3a9c2e41";
const BASE64 = Buffer.from(VALUE, "utf8").toString("base64");

test("secrets are set, reported, listed and deleted, never returned", async (t) => {
  const s = await startTestServer(t);
  const set = await s.client.setSecret("API_KEY", VALUE);
  assert.equal(set.name, "API_KEY");
  assert.equal(set.set, true);
  assert.equal(typeof set.updatedAt, "number");
  assert.deepEqual(Object.keys(set).sort(), ["name", "set", "updatedAt"]);
  assert.equal((await s.client.secretStatus("API_KEY")).set, true);
  assert.deepEqual(await s.client.secretStatus("OTHER_KEY"), { name: "OTHER_KEY", set: false, updatedAt: null });
  assert.deepEqual((await s.client.listSecrets()).map((x) => x.name), ["API_KEY"]);
  assert.equal((await s.secrets.reveal(["API_KEY"]))["API_KEY"], VALUE);
  await s.client.deleteSecret("API_KEY");
  assert.equal((await s.client.secretStatus("API_KEY")).set, false);
  assert.equal((await errorOf(await authed(s, "/v1/secrets/API_KEY", { method: "DELETE" }))).status, 404);
  assert.equal((await errorOf(await authed(s, "/v1/secrets/lower_case"))).code, "validation_failed");
  assert.equal((await errorOf(await authed(s, "/v1/secrets/API_KEY", { method: "PUT", json: { value: "short" } }))).code, "validation_failed");
});

test("a secret value appears in no API response and no log line", async (t) => {
  const s = await startTestServer(t);
  await s.client.setSecret("API_KEY", VALUE);
  const run = await seedRun(s.store, "leaky");
  await s.client.saveAgent({
    name: "Leaky", instructions: `instructions mention ${VALUE}`, model: { provider: "scripted", name: "scripted-1" }, tools: [], limits: {}, learning: false,
  }, "leaky");
  const { lease } = await claim(s.store, run.id);
  await s.store.commit(lease, { records: [{ type: "step.finished", key: "k", data: { echoed: VALUE } }] });
  await s.client.sendMessage(run.id, `please use ${VALUE}`);

  const bodies: string[] = [];
  for (const op of (await s.client.describeApi()).operations) {
    if (op.method !== "GET" || op.path === "/v1/runs/:id/events") continue;
    const path = op.path
      .replace(":id/revisions/:n", "leaky/revisions/1")
      .replace("/v1/agents/:id", "/v1/agents/leaky")
      .replace("/v1/runs/:id", `/v1/runs/${run.id}`)
      .replace(":name", "API_KEY")
      .replace(/:[a-z]+/g, "x1")
      .replace("*path", "a.txt");
    const response = op.auth === "bearer" ? await authed(s, path) : await fetch(`${s.url}${path}`);
    bodies.push(`${op.path} ${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`);
  }
  const echo = await authed(s, "/v1/runs", { method: "POST", json: { agentId: VALUE.toLowerCase().slice(0, 30) } });
  bodies.push(await echo.text());
  const echoed = await authed(s, "/v1/runs", { method: "POST", json: { agentId: VALUE } });
  bodies.push(await echoed.text());
  const badName = await authed(s, `/v1/secrets/${encodeURIComponent(VALUE)}`, { method: "PUT", json: { value: VALUE } });
  bodies.push(await badName.text());
  const badJson = await authed(s, "/v1/agents", { method: "POST", body: `{"definition": "${VALUE}", "definition": 1}`, headers: { "Content-Type": "application/json" } });
  bodies.push(await badJson.text());

  assert.ok(bodies.some((b) => b.includes("[redacted]")), "the echoing request was redacted");
  for (const text of [...bodies, ...s.logLines]) {
    assert.ok(!text.includes(VALUE), `leaked: ${text.slice(0, 300)}`);
    assert.ok(!text.includes(BASE64), `leaked base64: ${text.slice(0, 300)}`);
  }
});

function textForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [value, base64, base64.replace(/=+$/, ""), bytes.toString("base64url"), JSON.stringify(value).slice(1, -1)];
}

for (const [label, value] of [
  ["contains a quote, a backslash and a newline", 'not-"handed"\\to\nthe-run-41c7'],
  ["is 4 characters and 12 bytes", "秘密口令"],
] as const) {
  test(`a secret the run was not handed that ${label} is hidden in serialized responses and logs`, async (t) => {
    const s = await startTestServer(t);
    await s.client.setSecret("OTHER_SECRET", value);
    await s.client.saveAgent(testAgentDefinition(), "unhanded");
    const { run } = await s.client.startRun({ agentId: "unhanded", message: `the value is ${value} here`, data: { nested: value } });
    const { lease } = await claim(s.store, run.id);
    await s.store.commit(lease, { records: [{ type: "step.finished", key: "k", data: { echoed: `x ${value} y` } }] });
    await s.client.sendMessage(run.id, `again ${value}`);

    const bodies: string[] = [];
    for (const path of [`/v1/runs/${run.id}`, `/v1/runs/${run.id}/timeline`, "/v1/runs"]) {
      const response = await authed(s, path);
      assert.equal(response.status, 200, path);
      const body = await response.text();
      assert.ok(body.includes("[redacted]"), `${path} was redacted: ${body.slice(0, 300)}`);
      JSON.parse(body);
      bodies.push(body);
    }
    const timeline = await s.client.timeline(run.id);
    assert.ok(timeline.records.some((r) => JSON.stringify(r.data).includes("[redacted]")));
    for (const text of [...bodies, ...s.logLines]) {
      for (const form of textForms(value)) assert.equal(text.includes(form), false, `leaked ${JSON.stringify(form)}: ${text.slice(0, 300)}`);
    }
  });
}
