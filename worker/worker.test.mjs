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

test("Kong articles retain their source and published time", () => {
  const [item] = normalizeItems({ items: [{
    title: "Kong article",
    canonical: [{ href: "https://konghq.com/blog/engineering/example" }],
    origin: { streamId: "feed/https://konghq.com/feed/rss/blogs" },
    published: 1794898800
  }] });
  assert.equal(item.source, "kong");
  assert.equal(item.published, 1794898800);
});

test("Kong feed points to the publisher website", async () => {
  const response = await worker.fetch(new Request("https://worker.test/rss/kong.xml"), {
    CONTENT: { list: async () => ({ keys: [] }) }
  });
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /Kong Blog 全文/);
  assert.match(xml, /<link>https:\/\/konghq.com\/blog<\/link>/);
});

test("public feed requests work without publishing credentials", async () => {
  const response = await worker.fetch(new Request("https://worker.test/rss/openai-engineering.xml"), {
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
