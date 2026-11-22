/**
 * The three read-only skills behind both protocol surfaces (/mcp and /a2a).
 *
 * Design rule for this file: no generation model is ever called. Corpus search
 * runs one Workers AI embedding and one Neon query; the other two skills read
 * the static JSON the site already publishes. The expensive Claude pipeline
 * stays where it belongs, in the assistant worker behind the on-site widget.
 *
 * Corpus exposure is deliberately capped. `search_chunks` returns the full
 * passage text, but an agent gets a snippet plus the citation metadata and the
 * source URL. That is enough to write a cited answer and not enough to drain a
 * corpus we spent real effort assembling.
 */
import { neon } from "@neondatabase/serverless"

export interface Env {
  AI: Ai
  DATABASE_URL: string
  AGENT_LIMIT?: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  /** Origin the public JSON is read from. Overridden only to test against a local build. */
  SITE_ORIGIN?: string
}

/** Same model that embedded the corpus. A different one silently degrades results. */
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"

/** Hard ceiling on passages per call, whatever the caller asks for. */
const MAX_RESULTS = 10
const DEFAULT_RESULTS = 5

/** Characters of passage text handed out per result. */
const SNIPPET_CHARS = 480

/** Device names an agent might use, mapped to the names the corpus uses. */
const DEVICE_ALIASES: Record<string, string[]> = {
  pulsetto: ["Pulsetto"],
  nuropod: ["Nuropod", "Nurosym", "Parasym"],
  nurosym: ["Nuropod", "Nurosym", "Parasym"],
  truvaga: ["Truvaga"],
  xen: ["Xen", "Neuvana"],
  neuvana: ["Xen", "Neuvana"],
  sensate: ["Sensate"],
  apollo: ["Apollo"],
}

export interface ResearchHit {
  title: string
  section: string | null
  url: string
  year: string | null
  /** Study tier in our corpus, e.g. RCT or systematic review. */
  tier: string | null
  evidenceGrade: string | null
  /** Whether the study used this device, a comparable one, or none. */
  deviceRole: string | null
  snippet: string
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

function snippet(content: string): string {
  const text = content.replace(/\s+/g, " ").trim()
  if (text.length <= SNIPPET_CHARS) return text
  // Cut at a word boundary so the snippet does not end mid-token.
  return text.slice(0, text.lastIndexOf(" ", SNIPPET_CHARS)) + "..."
}

export async function searchResearch(
  env: Env,
  args: { query?: unknown; device?: unknown; onlyDeviceStudies?: unknown; limit?: unknown },
): Promise<{ query: string; count: number; results: ResearchHit[]; note: string }> {
  const query = String(args.query ?? "").trim()
  if (!query) throw new Error("query is required")
  if (query.length > 500) throw new Error("query must be 500 characters or fewer")

  const limit = clampInt(args.limit, DEFAULT_RESULTS, MAX_RESULTS)
  const deviceKey = String(args.device ?? "").trim().toLowerCase()
  const devices = deviceKey ? (DEVICE_ALIASES[deviceKey] ?? [deviceKey]) : null
  // `device` alone only biases the ranking: unrelated passages still surface,
  // with deviceRole null. This flag turns it into a real filter, which is what
  // an agent asking "which studies used this device" actually means.
  const onlyDeviceStudies = Boolean(devices) && args.onlyDeviceStudies === true

  const embedding = (await env.AI.run(EMBEDDING_MODEL, { text: [query] })) as { data: number[][] }
  const sql = neon(env.DATABASE_URL)
  const rows = (await sql`
    SELECT title, section, url, year, tier, evidence_grade, device_role, content
    FROM search_chunks(
      ${query}, ${JSON.stringify(embedding.data[0])}::vector,
      ${devices}, NULL, ${onlyDeviceStudies}, ${limit}
    )`) as unknown as Array<Record<string, string | null>>

  return {
    query,
    count: rows.length,
    results: rows.map((r) => ({
      title: r.title ?? "",
      section: r.section,
      url: r.url ?? "",
      year: r.year,
      tier: r.tier,
      evidenceGrade: r.evidence_grade,
      deviceRole: r.device_role,
      snippet: snippet(r.content ?? ""),
    })),
    note:
      "Snippets from peer-reviewed sources indexed by Vagus Lab. Cite the source URL, not Vagus Lab, for the study itself. Evidence for one device never transfers to another: check deviceRole before attributing a finding to a product.",
  }
}

/**
 * Devices and articles come from the site's own public JSON rather than a second
 * copy of the data. One source, one set of numbers, and the edge cache absorbs
 * the traffic.
 */
async function fetchPublic(env: Env, path: string): Promise<unknown> {
  const response = await fetch(`${env.SITE_ORIGIN ?? "https://vaguslab.net"}${path}`, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  })
  if (!response.ok) throw new Error(`upstream ${path} returned ${response.status}`)
  return response.json()
}

export function getDevices(env: Env): Promise<unknown> {
  return fetchPublic(env, "/api/public/devices.json")
}

export async function listArticles(env: Env, args: { category?: unknown; limit?: unknown }): Promise<unknown> {
  const data = (await fetchPublic(env, "/api/public/articles.json")) as {
    articles: Array<{ category?: { slug: string } | null }>
    count: number
  }
  const category = String(args.category ?? "").trim().toLowerCase()
  let articles = data.articles
  if (category) articles = articles.filter((a) => a.category?.slug === category)
  const limit = clampInt(args.limit, 50, 200)
  return { ...data, count: articles.length, articles: articles.slice(0, limit) }
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

/** Tool contracts, shared by the MCP tool list and the A2A skill list. */
export const TOOLS = [
  {
    name: "search_research",
    // Every tool only reads: a corpus query or a public JSON file on vaguslab.net.
    // Clients use these hints to run a tool without asking the user first.
    annotations: READ_ONLY,
    title: "Search the VNS research corpus",
    description:
      "Search Vagus Lab's curated corpus of published vagus nerve stimulation research (3,093 studies indexed as 20,535 passages, including 596 RCTs, systematic reviews and meta-analyses). Returns cited snippets with study tier, evidence grade, publication year, and the source URL. Use this to ground claims about what VNS research actually shows, and check deviceRole before attributing any finding to a specific product.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Research question or topic, for example 'taVNS effect on heart rate variability'",
          maxLength: 500,
        },
        device: {
          type: "string",
          description:
            "Prefer studies involving this device. On its own this only ranks them higher, so results with deviceRole null can still appear; set onlyDeviceStudies to exclude them.",
          enum: ["pulsetto", "nuropod", "nurosym", "truvaga", "xen", "sensate", "apollo"],
        },
        onlyDeviceStudies: {
          type: "boolean",
          description:
            "Return only passages from studies that actually used the named device. Requires device. Use this before stating that a device has evidence behind it.",
          default: false,
        },
        limit: {
          type: "integer",
          description: `Passages to return, 1 to ${MAX_RESULTS}`,
          minimum: 1,
          maximum: MAX_RESULTS,
          default: DEFAULT_RESULTS,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_devices",
    annotations: READ_ONLY,
    title: "Get the scored device comparison",
    description:
      "Vagus Lab's comparison of six consumer VNS devices: editorial score out of 10, price, badge, pros and cons, and merchant return terms. Scores are editorial, authored from a ten-criterion weighted methodology, and are not consumer ratings. Vagus Lab earns affiliate commission on some purchases; the payload carries that disclosure.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_articles",
    annotations: READ_ONLY,
    title: "List published articles",
    description:
      "Index of every published Vagus Lab article with its URL, category, and evidence grade. Fetch any article URL with the header 'Accept: text/markdown' to read the full text as clean markdown.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category slug, for example 'devices' or 'sleep-energy'",
        },
        limit: { type: "integer", description: "Maximum articles to return", minimum: 1, maximum: 200 },
      },
    },
  },
] as const

export async function runTool(env: Env, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "search_research":
      return searchResearch(env, args)
    case "get_devices":
      return getDevices(env)
    case "list_articles":
      return listArticles(env, args)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
