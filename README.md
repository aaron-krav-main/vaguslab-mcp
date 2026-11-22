# Vagus Lab Research: MCP and A2A server

Source of the agent endpoints that run at `https://vaguslab.net/mcp` (Model Context
Protocol) and `https://vaguslab.net/a2a` (A2A). Listed in the official MCP Registry as
[`net.vaguslab/research`](https://registry.modelcontextprotocol.io/v0/servers?search=net.vaguslab/research).

[Vagus Lab](https://vaguslab.net) is an independent research publication on vagus nerve
stimulation (VNS). This server lets an AI agent ground its answer in published VNS
research instead of guessing.

This repository is a read-only mirror, published so anyone can check what the server
does before connecting to it. The site itself lives in a private repository; this code
is copied from it on every change to the server.

## What it does

Three tools, all read-only:

| Tool | Returns |
|---|---|
| `search_research` | Cited passages from a curated corpus of VNS studies, with study tier, evidence grade, year, source URL, and `deviceRole` (whether the study used a named device). |
| `get_devices` | Vagus Lab's scored comparison of consumer VNS devices. Scores are editorial, not consumer ratings. Vagus Lab earns affiliate commission on some purchases, and the payload says so. |
| `list_articles` | Index of published articles. Any article URL returns clean markdown when fetched with `Accept: text/markdown`. |

## What it does not do

- **No generation model.** The server returns passages; your own model writes the
  answer. No call to Claude or any other LLM happens here.
- **No writes, no accounts, no auth.** Nothing you send is stored beyond standard
  Cloudflare request logs.
- **Capped exposure.** Snippets are cut at 480 characters, at most 10 per call, and
  each IP gets 30 requests per minute.

## Connect

```json
{
  "mcpServers": {
    "vaguslab": { "type": "http", "url": "https://vaguslab.net/mcp" }
  }
}
```

Server card: `https://vaguslab.net/.well-known/mcp/server-card.json`
A2A agent card: `https://vaguslab.net/.well-known/agent-card.json`
Human docs: `https://vaguslab.net/api-docs/`

## Run it yourself

It is a Cloudflare Worker. The corpus lives in a private Postgres database, so a local
copy needs your own `DATABASE_URL` with the same schema; `get_devices` and
`list_articles` read the public JSON at `vaguslab.net/api/public/` and work as is.

```bash
npm install
npm run typecheck
npx wrangler dev
```

## Contact

contact@vaguslab.net. Issues on this repository are read too.
