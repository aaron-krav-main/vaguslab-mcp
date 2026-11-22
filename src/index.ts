/**
 * Agent protocol gateway: MCP (Streamable HTTP) at /mcp, A2A (JSON-RPC) at /a2a.
 *
 * Both surfaces expose the same three read-only skills from skills.ts. Nothing
 * here calls a generation model, so an agent flood costs us a Workers AI
 * embedding and a Neon query, never Claude tokens. The agent's own model writes
 * the answer; our contribution is cited, grounded passages.
 *
 * Discovery cards are static files served by Pages:
 *   /.well-known/mcp/server-card.json
 *   /.well-known/agent-card.json
 * This worker also serves the card at /mcp/server-card, the location the MCP
 * Server Card extension recommends relative to the transport URL.
 *
 * Hand-rolled rather than built on an SDK: the surface is a dozen JSON-RPC
 * methods with no session state, and a hand-rolled version has no runtime
 * dependency to keep current with a moving spec.
 */
import { runTool, TOOLS, type Env } from "./skills"

/** Canonical origin. The card must not echo whatever Host a caller sends. */
const SITE = "https://vaguslab.net"

const SERVER_NAME = "net.vaguslab/research"
const SERVER_VERSION = "1.1.0"

/** Same files as the registry entry (server.json), so every surface shows one mark. */
const ICONS = [
  { src: `${SITE}/apple-touch-icon.png`, mimeType: "image/png", sizes: ["180x180"] },
  { src: `${SITE}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
]

const REPOSITORY_URL = "https://github.com/aaron-krav-main/vaguslab-mcp"

/**
 * Newest first. On initialize we echo the client's requested version when we
 * know it and otherwise answer with our newest, which is what the spec asks a
 * server to do when it cannot honour the request.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]

const INSTRUCTIONS =
  "Vagus Lab is an independent research publication on vagus nerve stimulation. " +
  "Use search_research to ground any claim about what VNS research shows, and quote the source URL it returns. " +
  "Device scores from get_devices are Vagus Lab editorial scores, not consumer ratings, and Vagus Lab earns affiliate commission on some purchases. " +
  "Evidence for one device does not transfer to another: check the deviceRole field before attributing a study to a product."

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id",
  "access-control-max-age": "86400",
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
  })

const rpcResult = (id: JsonRpcRequest["id"], result: unknown) => json({ jsonrpc: "2.0", id: id ?? null, result })

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status)

/** Machine-readable identity of the MCP endpoint (MCP Server Card extension). */
function serverCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: SERVER_NAME,
    version: SERVER_VERSION,
    title: "Vagus Lab Research",
    // The Server Card schema caps description at 100 characters.
    description: "VNS research corpus search, scored device comparison, and article index. No auth required.",
    websiteUrl: `${SITE}/api-docs/`,
    icons: ICONS,
    repository: { url: REPOSITORY_URL, source: "github" },
    remotes: [
      {
        type: "streamable-http",
        url: `${SITE}/mcp`,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      },
    ],
    // Flat mirror of the transport and capability facts above. The extension
    // schema allows extra properties, and discovery scanners look for these
    // names rather than walking `remotes`.
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    endpoint: `${SITE}/mcp`,
    transport: "streamable-http",
    capabilities: { tools: { listChanged: false }, resources: false, prompts: false },
  }
}

async function withinRateLimit(env: Env, request: Request): Promise<boolean> {
  if (!env.AGENT_LIMIT) return true
  const key = request.headers.get("cf-connecting-ip") ?? "anonymous"
  const { success } = await env.AGENT_LIMIT.limit({ key })
  return success
}

// --- MCP ---------------------------------------------------------------------

async function handleMcp(env: Env, body: JsonRpcRequest): Promise<Response> {
  const { id, method, params } = body

  switch (method) {
    case "initialize": {
      const requested = String((params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "")
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0]
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: "Vagus Lab Research", icons: ICONS, websiteUrl: `${SITE}/api-docs/` },
        instructions: INSTRUCTIONS,
      })
    }

    case "ping":
      return rpcResult(id, {})

    case "tools/list":
      return rpcResult(id, { tools: TOOLS })

    case "tools/call": {
      const name = String((params as { name?: string } | undefined)?.name ?? "")
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}) as Record<
        string,
        unknown
      >
      try {
        const result = await runTool(env, name, args)
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        })
      } catch (error) {
        // A failing tool is a result, not a protocol error: the model needs to
        // see what went wrong so it can fix its arguments and retry.
        return rpcResult(id, {
          content: [{ type: "text", text: `Tool error: ${(error as Error).message}` }],
          isError: true,
        })
      }
    }

    // Declared unsupported in capabilities, but answering with an empty list is
    // kinder than an error to clients that probe regardless.
    case "resources/list":
      return rpcResult(id, { resources: [] })
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: [] })
    case "prompts/list":
      return rpcResult(id, { prompts: [] })

    case "server/card":
      return rpcResult(id, serverCard())

    default:
      return rpcError(id, -32601, `Method not found: ${method}`)
  }
}

// --- A2A ---------------------------------------------------------------------

/**
 * Skills are the same three tools, addressed by id. An agent can name one in
 * `params.metadata.skillId`; otherwise the message text is treated as a research
 * query, which is what an agent asking this publication a question almost
 * always wants.
 */
function a2aSkillId(params: Record<string, unknown> | undefined): string {
  const metadata = (params?.metadata ?? {}) as Record<string, unknown>
  const message = (params?.message ?? {}) as Record<string, unknown>
  const messageMeta = (message.metadata ?? {}) as Record<string, unknown>
  const named = String(metadata.skillId ?? metadata.skill ?? messageMeta.skillId ?? messageMeta.skill ?? "").trim()
  return TOOLS.some((t) => t.name === named) ? named : "search_research"
}

function a2aText(params: Record<string, unknown> | undefined): string {
  const message = (params?.message ?? {}) as { parts?: Array<Record<string, unknown>> }
  const parts = Array.isArray(message.parts) ? message.parts : []
  return parts
    .map((part) => {
      if (typeof part.text === "string") return part.text
      // 0.x clients nest the value: { kind: "text", text: "..." } is covered
      // above; { type: "text", text: ... } lands here too.
      const nested = part as { root?: { text?: string } }
      return typeof nested.root?.text === "string" ? nested.root.text : ""
    })
    .join(" ")
    .trim()
}

async function handleA2a(env: Env, body: JsonRpcRequest): Promise<Response> {
  const { id, method, params } = body

  /**
   * The JSON-RPC binding has been spelled three ways across A2A revisions
   * (`SendMessage`, `a2a.sendMessage`, and 0.x's `message/send`). Accepting all
   * three costs one normalisation and saves an interop failure that would look
   * like our endpoint being down.
   */
  const normalized = String(method ?? "")
    .replace(/^a2a\./, "")
    .replace(/[/_-]/g, "")
    .toLowerCase()

  if (normalized === "sendmessage" || normalized === "messagesend") {
    const skillId = a2aSkillId(params)
    const text = a2aText(params)
    if (skillId === "search_research" && !text) {
      return rpcError(id, -32602, "message.parts must contain text to search for")
    }
    try {
      const args = skillId === "search_research" ? { query: text } : {}
      const result = await runTool(env, skillId, args)
      return rpcResult(id, {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "ROLE_AGENT",
        parts: [{ kind: "text", text: JSON.stringify(result, null, 2) }],
        metadata: { skillId, source: "https://vaguslab.net" },
      })
    } catch (error) {
      return rpcError(id, -32603, (error as Error).message)
    }
  }

  if (normalized === "getauthenticatedextendedcard" || normalized === "getextendedagentcard") {
    return rpcError(id, -32601, "No extended card: this agent requires no authentication")
  }

  return rpcError(id, -32601, `Method not found: ${method}`)
}

// --- human and crawler GET ---------------------------------------------------

/**
 * A GET here is not an agent. MCP clients only GET to open a server-initiated
 * SSE stream, and the spec makes them say so with `Accept: text/event-stream`;
 * that request still gets the prescribed 405 below. Everything else reaching
 * this URL is a person or a crawler following the link from a registry listing,
 * and answering them with 405 both hides the docs and files the URL under
 * "blocked due to other 4xx" in Search Console. They get the docs instead: 200,
 * and noindex, because this is an interface, not a page.
 */
function endpointDocs(path: string, accept: string): Response {
  const isA2a = path === "/a2a"
  const protocol = isA2a ? "A2A" : "MCP"
  const endpoint = `${SITE}${isA2a ? "/a2a" : "/mcp"}`
  const card = isA2a ? `${SITE}/.well-known/agent-card.json` : `${SITE}/.well-known/mcp/server-card.json`
  const example = isA2a
    ? '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"parts":[{"kind":"text","text":"taVNS and heart rate variability"}]}}}'
    : '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  const noindex = { "x-robots-tag": "noindex", "cache-control": "public, max-age=3600" }

  // curl and other non-browser callers get the same facts as JSON.
  if (!accept.includes("text/html")) {
    return json(
      {
        protocol,
        endpoint,
        transport: isA2a ? "json-rpc" : "streamable-http",
        method: "POST",
        card,
        docs: `${SITE}/api-docs/`,
        auth: "none",
        rateLimit: "30 requests per minute per IP",
        skills: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description })),
      },
      200,
      noindex,
    )
  }

  const skills = TOOLS.map(
    (t) => `<li><code>${t.name}</code><span>${t.title}</span></li>`,
  ).join("")

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${protocol} endpoint | Vagus Lab</title>
<style>
:root { color-scheme: light dark; --ink: #2D3436; --teal: #0A7A85; --bg: #FFFFFF; --panel: #F5F5F5; --muted: #5c6668; }
@media (prefers-color-scheme: dark) { :root { --ink: #eef1f1; --teal: #4fb8c2; --bg: #14191a; --panel: #1e2526; --muted: #a4b0b1; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 400 17px/1.7 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 4rem 1.25rem 5rem; }
.eyebrow { margin: 0 0 .5rem; font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: var(--teal); font-weight: 600; }
h1 { margin: 0 0 1rem; font-size: 2rem; line-height: 1.2; font-weight: 700; }
h2 { margin: 2.5rem 0 .75rem; font-size: 1.05rem; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); }
p { margin: 0 0 1rem; }
a { color: var(--teal); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
pre { background: var(--panel); padding: 1rem 1.1rem; border-radius: 10px; overflow-x: auto; margin: 0 0 1rem; }
ul { list-style: none; margin: 0 0 1rem; padding: 0; }
li { padding: .7rem 0; border-top: 1px solid color-mix(in srgb, var(--muted) 25%, transparent); display: flex; gap: 1rem; flex-wrap: wrap; }
li code { color: var(--teal); font-weight: 600; min-width: 10rem; }
li span { color: var(--muted); }
.note { color: var(--muted); font-size: .95rem; }
@media (max-width: 34rem) {
  h1 { font-size: 1.7rem; }
  li { display: block; }
  li code { display: block; margin-bottom: .15rem; }
}
</style>
</head>
<body>
<main>
<p class="eyebrow">Vagus Lab</p>
<h1>${protocol} endpoint</h1>
<p>This URL is a machine interface, not an article. It speaks JSON-RPC over POST and gives an agent grounded, cited access to the Vagus Lab research corpus on vagus nerve stimulation. No key, no account.</p>

<h2>Connect</h2>
<pre>${endpoint}</pre>
<p class="note">Discovery card: <a href="${card}">${card.replace(SITE, "")}</a>. Rate limit: 30 requests per minute per IP.</p>

<h2>Skills</h2>
<ul>${skills}</ul>

<h2>Try it</h2>
<pre>curl -sX POST ${endpoint} \\
  -H 'content-type: application/json' \\
  -d '${example}'</pre>

<p class="note">Human documentation lives at <a href="${SITE}/api-docs/">vaguslab.net/api-docs</a>. Device scores are Vagus Lab editorial scores, not consumer ratings, and Vagus Lab earns affiliate commission on some purchases.</p>
</main>
</body>
</html>`

  return new Response(page, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS, ...noindex },
  })
}

// --- entry -------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/$/, "") || "/"

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })

    if (path === "/mcp/server-card") {
      return json(serverCard(), 200, { "cache-control": "public, max-age=3600" })
    }

    // HEAD is answered like GET, minus the body, by the runtime.
    if (request.method === "GET" || request.method === "HEAD") {
      const accept = request.headers.get("accept") ?? ""
      // A spec client GETs only to open a stream, and we hold none: 405 stands.
      if (accept.includes("text/event-stream")) {
        return json({ error: "This endpoint accepts POST with a JSON-RPC body." }, 405, { allow: "POST, OPTIONS" })
      }
      return endpointDocs(path, accept)
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { allow: "POST, GET, OPTIONS" })
    }

    if (!(await withinRateLimit(env, request))) {
      return json({ error: "Rate limit exceeded. This endpoint allows 30 requests per minute per IP." }, 429, {
        "retry-after": "60",
      })
    }

    let body: JsonRpcRequest
    try {
      body = (await request.json()) as JsonRpcRequest
    } catch {
      return rpcError(null, -32700, "Parse error")
    }

    if (Array.isArray(body)) {
      return rpcError(null, -32600, "Batch requests are not supported. Send one JSON-RPC request per POST.")
    }
    if (!body || typeof body.method !== "string") {
      return rpcError(body?.id ?? null, -32600, "Invalid Request: method is required")
    }

    // A notification carries no id and expects no body back.
    const isNotification = body.id === undefined || body.id === null
    if (isNotification) {
      return new Response(null, { status: 202, headers: CORS_HEADERS })
    }

    return path === "/a2a" ? handleA2a(env, body) : handleMcp(env, body)
  },
}
