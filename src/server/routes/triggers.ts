import { RunwrightError } from "../../core/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../../core/json.ts";
import type { TriggerRecord } from "../../store/types.ts";
import { buildTrigger, fireResult, fireTriggerOnce } from "../../triggers/service.ts";
import { verifyWebhook } from "../../triggers/webhook.ts";
import type { ServerContext, ServerDeps } from "../context.ts";
import { badRequest, json, empty, notFound, param, parseJsonBytes } from "../http.ts";
import type { Route } from "../router.ts";

/** Reads and merges of one PATCH before it gives up with 409 conflict. */
const UPDATE_ATTEMPTS = 3;
/** Reads and fires of one manual fire or webhook delivery whose trigger keeps changing, before 409 conflict. */
const FIRE_ATTEMPTS = 3;

const DELIVERY = /^[\x21-\x7e]{1,128}$/;
const triggerBody = { type: "object", description: "TriggerInput (validated in full by the handler)" };

async function requireTrigger(deps: ServerDeps, id: string): Promise<TriggerRecord> {
  const trigger = await deps.store.getTrigger(id);
  if (trigger === null) throw notFound(`trigger ${id} not found`);
  return trigger;
}

async function requireAgentFor(deps: ServerDeps, input: JsonObject): Promise<void> {
  const agentId = input["agentId"];
  if (typeof agentId === "string" && agentId !== "" && (await deps.store.getAgent(agentId)) === null) {
    throw notFound(`agent ${agentId} not found`);
  }
}

/** A stored trigger as the input it could have been built from. */
function inputOf(trigger: TriggerRecord): JsonObject {
  const limits: JsonObject = {};
  if (trigger.limits.maxCostMicros !== null) limits["maxCostMicros"] = trigger.limits.maxCostMicros;
  if (trigger.limits.maxToolCalls !== null) limits["maxToolCalls"] = trigger.limits.maxToolCalls;
  if (trigger.limits.maxTurns !== null) limits["maxTurns"] = trigger.limits.maxTurns;
  const input: JsonObject = {
    name: trigger.name, kind: trigger.kind, agentId: trigger.agentId, enabled: trigger.enabled, message: trigger.message, limits,
  };
  if (trigger.cron !== null) input["cron"] = { expression: trigger.cron.expression, timeZone: trigger.cron.timeZone };
  if (trigger.webhook !== null) input["webhook"] = { secretName: trigger.webhook.secretName };
  return input;
}

/** Overlays a partial input on a stored trigger; switching kind drops the other kind's settings unless given. */
function mergeInput(trigger: TriggerRecord, patch: JsonObject): JsonObject {
  const merged: JsonObject = { ...inputOf(trigger), ...patch };
  const baseLimits = inputOf(trigger)["limits"] as JsonObject;
  if (isJsonObject(patch["limits"])) merged["limits"] = { ...baseLimits, ...patch["limits"] };
  if (merged["kind"] === "cron" && patch["webhook"] === undefined) delete merged["webhook"];
  if (merged["kind"] === "webhook" && patch["cron"] === undefined) delete merged["cron"];
  return merged;
}

function keptChanging(id: string): RunwrightError {
  return new RunwrightError("conflict", `trigger ${id} kept changing while it was being fired; try again`, { details: { triggerId: id } });
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The delivery of a verified webhook body: the body parsed strictly, which must be a JSON object whose own member
 * `delivery` is 1 to 128 visible ASCII characters. That signed value is the delivery id; an
 * `X-Runwright-Delivery` header, when sent (non-empty after trimming), must equal it. Call only after
 * `verifyWebhook` accepted `rawBody`.
 */
function signedDelivery(rawBody: Uint8Array, presented: string | undefined): { delivery: string; payload: JsonObject } {
  const payload = parseJsonBytes(rawBody);
  const delivery = isJsonObject(payload) && Object.hasOwn(payload, "delivery") ? payload["delivery"] : undefined;
  if (!isJsonObject(payload) || typeof delivery !== "string" || !DELIVERY.test(delivery)) {
    throw badRequest('the signed body must be a JSON object with a "delivery" string of 1 to 128 visible ASCII characters');
  }
  const sent = presented?.trim() ?? "";
  if (sent !== "" && sent !== delivery) throw badRequest('X-Runwright-Delivery does not match the "delivery" of the signed body');
  return { delivery, payload };
}

export function triggerRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "triggers.list", method: "GET", path: "/v1/triggers", auth: "bearer", summary: "Cron and webhook triggers",
      query: {}, body: null, bodyMode: "none", response: "{triggers}",
      async handler() {
        return json(200, { triggers: await deps.store.listTriggers() });
      },
    },
    {
      id: "triggers.create", method: "POST", path: "/v1/triggers", auth: "bearer",
      summary: "Create a cron or webhook trigger; every trigger carries a spend cap",
      query: {}, body: triggerBody, bodyMode: "json", response: "201 {trigger}",
      async handler({ body }) {
        const trigger = buildTrigger(body, { ids: deps.ids, clock: deps.clock });
        await requireAgentFor(deps, body);
        await deps.store.saveTrigger(trigger);
        return json(201, { trigger });
      },
    },
    {
      id: "triggers.get", method: "GET", path: "/v1/triggers/:id", auth: "bearer", summary: "One trigger",
      query: {}, body: null, bodyMode: "none", response: "{trigger}",
      async handler({ params }) {
        return json(200, { trigger: await requireTrigger(deps, param(params, "id")) });
      },
    },
    {
      id: "triggers.update", method: "PATCH", path: "/v1/triggers/:id", auth: "bearer",
      summary: "Change a trigger (any TriggerInput fields; enabled: false turns it off)",
      query: {}, body: triggerBody, bodyMode: "json", response: "{trigger}",
      async handler({ params, body }) {
        const id = param(params, "id");
        // Compare-and-set: a change made by another writer between the read and the write is merged again, never lost.
        for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
          const existing = await requireTrigger(deps, id);
          const merged = mergeInput(existing, body);
          const trigger = buildTrigger(merged, { ids: deps.ids, clock: deps.clock, existing });
          if (trigger.agentId !== existing.agentId) await requireAgentFor(deps, merged);
          const outcome = await deps.store.updateTrigger(trigger, existing);
          if (outcome === "updated") return json(200, { trigger: (await deps.store.getTrigger(id)) ?? trigger });
          if (outcome === "missing") throw notFound(`trigger ${id} not found`);
        }
        throw new RunwrightError("conflict", `trigger ${id} kept changing while it was being updated; try again`, { details: { triggerId: id } });
      },
    },
    {
      id: "triggers.delete", method: "DELETE", path: "/v1/triggers/:id", auth: "bearer", summary: "Delete a trigger",
      query: {}, body: null, bodyMode: "none", response: "204",
      async handler({ params }) {
        const id = param(params, "id");
        if (!(await deps.store.deleteTrigger(id))) throw notFound(`trigger ${id} not found`);
        return empty(204);
      },
    },
    {
      id: "triggers.fire", method: "POST", path: "/v1/triggers/:id/fire", auth: "bearer", summary: "Start a run from a trigger now",
      query: {}, bodyMode: "json", response: "202 {run, created}",
      body: { type: "object", additionalProperties: false, properties: { data: {} } },
      async handler({ params, body, requestId }) {
        const id = param(params, "id");
        const data: Json = body["data"] === undefined ? null : body["data"];
        // The store fires only from the trigger as stored: one edited since this read is read again and fired anew.
        for (let attempt = 1; attempt <= FIRE_ATTEMPTS; attempt++) {
          const trigger = await requireTrigger(deps, id);
          const result = await fireTriggerOnce({ store: deps.store, clock: deps.clock }, trigger, {
            dedupeKey: `manual:${trigger.id}:${requestId}`, kind: "manual", data,
          });
          if (result.outcome !== "changed") return json(202, fireResult(trigger, result));
        }
        throw keptChanging(id);
      },
    },
    {
      id: "hooks.receive", method: "POST", path: "/v1/hooks/:id", auth: "signature",
      summary: "Signed webhook delivery: X-Runwright-Timestamp, X-Runwright-Signature (HMAC-SHA256 over timestamp and body); "
        + "the body is a JSON object whose \"delivery\" string is the delivery id; X-Runwright-Delivery is optional and must match it",
      query: {}, body: null, bodyMode: "raw", response: "202 {runId, duplicate}",
      async handler({ req, params, rawBody }) {
        const id = param(params, "id");
        // Each attempt verifies the delivery against the secret the trigger it fires from names. Nothing of the
        // request but the route parameter is read before the signature over the raw body has been verified.
        for (let attempt = 1; attempt <= FIRE_ATTEMPTS; attempt++) {
          const trigger = await deps.store.getTrigger(id);
          if (trigger === null || trigger.kind !== "webhook" || trigger.webhook === null) throw notFound(`webhook ${id} not found`);
          const secretName = trigger.webhook.secretName;
          const secret = (await deps.secrets.reveal([secretName]))[secretName];
          if (secret === undefined) {
            deps.logger.warn("webhook secret is missing", { triggerId: id, secretName });
            throw new RunwrightError("unavailable", "this webhook cannot be verified right now");
          }
          verifyWebhook({
            secret,
            timestamp: header(req.headers["x-runwright-timestamp"]),
            signature: header(req.headers["x-runwright-signature"]),
            body: rawBody,
            nowMs: deps.clock.now(),
            windowSec: deps.config.triggers.webhookWindowSec,
          });
          const { delivery, payload } = signedDelivery(rawBody, header(req.headers["x-runwright-delivery"]));
          const result = await fireTriggerOnce({ store: deps.store, clock: deps.clock }, trigger, {
            dedupeKey: `webhook:${trigger.id}:${delivery}`, kind: "webhook", data: { delivery, body: payload },
          });
          if (result.outcome === "changed") continue;
          const fired = fireResult(trigger, result);
          return json(202, { runId: fired.run.id, duplicate: !fired.created });
        }
        throw keptChanging(id);
      },
    },
  ];
}
