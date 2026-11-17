import { RunwrightError } from "../../core/errors.ts";
import { SECRET_NAME_PATTERN } from "../../security/secrets.ts";
import type { ServerContext } from "../context.ts";
import { empty, json, notFound, param } from "../http.ts";
import type { Route } from "../router.ts";

function secretName(name: string): string {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new RunwrightError("validation_failed", "a secret name is 1-64 characters: an upper-case letter, then A-Z, 0-9 or _", {
      details: { problems: [{ path: "$.name", keyword: "pattern", message: `a secret name matches ${SECRET_NAME_PATTERN.source}` }] },
    });
  }
  return name;
}

/** Secrets are write-only: values go in, only set/missing status comes out. */
export function secretRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "secrets.list", method: "GET", path: "/v1/secrets", auth: "bearer", summary: "Which secrets are set (never their values)",
      query: {}, body: null, bodyMode: "none", response: "{secrets: SecretStatus[]}",
      async handler() {
        return json(200, { secrets: await deps.secrets.list() });
      },
    },
    {
      id: "secrets.get", method: "GET", path: "/v1/secrets/:name", auth: "bearer", summary: "Whether one secret is set",
      query: {}, body: null, bodyMode: "none", response: "{secret: SecretStatus}",
      async handler({ params }) {
        return json(200, { secret: await deps.secrets.status(secretName(param(params, "name"))) });
      },
    },
    {
      id: "secrets.put", method: "PUT", path: "/v1/secrets/:name", auth: "bearer", summary: "Set a secret (sealed at rest; write-only)",
      query: {}, bodyMode: "json", response: "{secret: SecretStatus}",
      body: { type: "object", required: ["value"], additionalProperties: false, properties: { value: { type: "string" } } },
      async handler({ params, body }) {
        const name = secretName(param(params, "name"));
        return json(200, { secret: await deps.secrets.set(name, body["value"] as string) });
      },
    },
    {
      id: "secrets.delete", method: "DELETE", path: "/v1/secrets/:name", auth: "bearer", summary: "Delete a secret",
      query: {}, body: null, bodyMode: "none", response: "204",
      async handler({ params }) {
        const name = secretName(param(params, "name"));
        if (!(await deps.secrets.delete(name))) throw notFound(`secret ${name} is not set`);
        return empty(204);
      },
    },
  ];
}
