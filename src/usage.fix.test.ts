// Review fixes: README promises the query only for search_research.
import { test } from "node:test"
import assert from "node:assert/strict"
import { toolCallPoint } from "./usage.ts"

test("query is recorded only for search_research", () => {
  const p = toolCallPoint("list_articles", { query: "secret text" }, "ua", "mcp")
  assert.equal(p.blobs[2], "")
})

test("caller-supplied tool name is cut to 64 chars", () => {
  const p = toolCallPoint("t".repeat(500), {}, "ua", "mcp")
  assert.equal(p.blobs[0].length, 64)
  assert.equal(p.indexes[0].length, 64)
})
