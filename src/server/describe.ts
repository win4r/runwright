import type { JsonSchema } from "../schema/validate.ts";
import type { Route } from "./router.ts";

export interface ApiOperation {
  id: string; method: string; path: string; summary: string; auth: "bearer" | "none" | "signature";
  query: { [name: string]: string }; body: JsonSchema | null; response: string;
}
export interface ApiDescription { name: "runwright"; version: "v1"; operations: ApiOperation[] }

/** The machine-readable API description, generated from the route table so it cannot drift from the routes. */
export function describeApi(routes: readonly Route[]): ApiDescription {
  return {
    name: "runwright",
    version: "v1",
    operations: routes.map((route) => ({
      id: route.id,
      method: route.method,
      path: route.path,
      summary: route.summary,
      auth: route.auth,
      query: { ...route.query },
      body: route.body,
      response: route.response,
    })),
  };
}
