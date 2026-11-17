import type { UsageQuery } from "../../store/types.ts";
import type { ServerContext } from "../context.ts";
import { json, queryEnum, queryInt, queryString } from "../http.ts";
import type { Route } from "../router.ts";

const GROUPS = ["day", "agent", "model"] as const;

export function usageRoutes(context: ServerContext): Route[] {
  const { deps } = context;
  return [
    {
      id: "usage.summary", method: "GET", path: "/v1/usage", auth: "bearer",
      summary: "Token use and cost grouped by day (UTC), agent or model; unknownCostCalls counts calls with no price",
      query: { groupBy: "day|agent|model, default day", from: "epoch ms, inclusive", to: "epoch ms, exclusive", agentId: "agent id" },
      body: null, bodyMode: "none", response: "{groupBy, rows: UsageRow[]}",
      async handler({ query }) {
        const groupBy = queryEnum(query, "groupBy", GROUPS) ?? "day";
        const from = queryInt(query, "from", { min: 0 });
        const to = queryInt(query, "to", { min: 0 });
        const agentId = queryString(query, "agentId");
        const request: UsageQuery = { groupBy };
        if (from !== undefined) request.from = from;
        if (to !== undefined) request.to = to;
        if (agentId !== undefined) request.agentId = agentId;
        return json(200, { groupBy, rows: await deps.store.usageSummary(request) });
      },
    },
  ];
}
