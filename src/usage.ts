/**
 * Counts genuine tool calls, the only signal of real use. Raw /mcp traffic is
 * almost all directory liveness probes (initialize + tools/list), so it says
 * nothing; a tools/call means some agent wanted an answer from us.
 *
 * One Workers Analytics Engine point per call, read weekly by
 * scripts/seo/ai_visibility.py. Columns: blob1 tool, blob2 user agent,
 * blob3 query (search_research only), blob4 protocol. No IP, by design: the
 * public README promises exactly these four fields.
 */

const UA_CHARS = 80
const QUERY_CHARS = 200

export type Protocol = "mcp" | "a2a"

export interface UsageEnv {
  AGENT_CALLS?: { writeDataPoint(point: { blobs: string[]; indexes: string[]; doubles: number[] }): void }
}

export function toolCallPoint(
  tool: string,
  args: Record<string, unknown>,
  userAgent: string | null,
  protocol: Protocol,
): { blobs: string[]; indexes: string[]; doubles: number[] } {
  const query = typeof args.query === "string" ? args.query : ""
  return {
    blobs: [tool, (userAgent ?? "").slice(0, UA_CHARS), query.slice(0, QUERY_CHARS), protocol],
    indexes: [tool],
    doubles: [1],
  }
}

/** Never throws and never blocks the answer: counting is not worth a failed call. */
export function recordToolCall(
  env: UsageEnv,
  tool: string,
  args: Record<string, unknown>,
  userAgent: string | null,
  protocol: Protocol,
): void {
  try {
    env.AGENT_CALLS?.writeDataPoint(toolCallPoint(tool, args, userAgent, protocol))
  } catch {
    // Analytics Engine down or misconfigured: the tool call still succeeds.
  }
}
