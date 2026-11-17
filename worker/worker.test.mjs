import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { normalizeItems } from "./worker.mjs";

test("Inoreader payload preserves identity and selects the engineering feed", () => {
  const [item] = normalizeItems({ items: [{
    id: "test-1",
    title: "A Git article",
    canonical: [{ href: "https://openai.com/index/example#part" }],
    origin: { streamId: "feed/https://example.test/openai_engineering.xml" }
  }] });
  assert.equal(item.url, "https://openai.com/index/example");
  assert.equal(item.source, "openai-engineering");
  assert.equal(item.originalId, "test-1");
});

test("disabled websites are rejected", () => {
  assert.throws(() => normalizeItems({ items: [{ url: "https://example.com/" }] }), /not enabled/);
});

test("public feed requests work without publishing credentials", async () => {
  const response = await worker.fetch(new Request("https://worker.test/feeds/openai-engineering.xml"), {
    CONTENT: { list: async () => ({ keys: [] }) }
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OpenAI Engineering 全文/);
});

test("publishing requires authorization", async () => {
  const response = await worker.fetch(new Request("https://worker.test/api/articles/openai-research", { method: "PUT" }), {
    PUBLISH_SECRET: "test-secret"
  });
  assert.equal(response.status, 401);
});
