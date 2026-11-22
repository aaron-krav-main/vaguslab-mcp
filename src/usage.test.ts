// Run: node --experimental-strip-types --test src/usage.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { recordToolCall, toolCallPoint } from "./usage.ts"

test("search_research point carries tool, client and query", () => {
  const p = toolCallPoint("search_research", { query: "taVNS for sleep" }, "Claude-User/1.0", "mcp")
  assert.deepEqual(p.blobs, ["search_research", "Claude-User/1.0", "taVNS for sleep", "mcp"])
  assert.deepEqual(p.indexes, ["search_research"])
  assert.deepEqual(p.doubles, [1])
})

test("user agent is cut to 80 chars and query to 200", () => {
  const p = toolCallPoint("search_research", { query: "q".repeat(500) }, "u".repeat(300), "a2a")
  assert.equal(p.blobs[1].length, 80)
  assert.equal(p.blobs[2].length, 200)
})

test("tools without a query record an empty query", () => {
  const p = toolCallPoint("get_devices", {}, "x", "mcp")
  assert.equal(p.blobs[2], "")
})

test("missing user agent becomes an empty string", () => {
  const p = toolCallPoint("list_articles", {}, null, "mcp")
  assert.equal(p.blobs[1], "")
})

test("the point holds exactly the four documented blobs, nothing else", () => {
  const p = toolCallPoint("search_research", { query: "q", ip: "1.2.3.4" }, "ua", "mcp")
  assert.equal(p.blobs.length, 4)
  assert.ok(!JSON.stringify(p).includes("1.2.3.4"))
})

test("recordToolCall is a no-op without the binding and never throws", () => {
  assert.doesNotThrow(() => recordToolCall({}, "get_devices", {}, null, "mcp"))
  const broken = { AGENT_CALLS: { writeDataPoint() { throw new Error("down") } } }
  assert.doesNotThrow(() => recordToolCall(broken, "get_devices", {}, null, "mcp"))
})

test("recordToolCall writes the point to the binding", () => {
  const written: unknown[] = []
  recordToolCall({ AGENT_CALLS: { writeDataPoint: (p: unknown) => written.push(p) } }, "get_devices", {}, "ua", "mcp")
  assert.equal(written.length, 1)
})
