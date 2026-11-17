import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
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
  const response = await worker.fetch(new Request("https://worker.test/rss/kong-blog.xml"), {
    CONTENT: { list: async () => ({ keys: [] }), getWithMetadata: async () => ({ value: null }) }
  });
  const xml = await response.text();
  assert.equal(response.status, 200);
  assert.match(xml, /Kong Blog 全文/);
  assert.match(xml, /<link>https:\/\/konghq.com\/blog<\/link>/);
  assert.match(xml, /https:\/\/worker.test\/rss\/kong-blog.xml/);
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

test("the combined Kong feed is published privately and served as gzip", async () => {
  const xml = '<rss version="2.0"><channel><title>Kong history</title></channel></rss>';
  let stored;
  const env = {
    PUBLISH_SECRET: "test-secret",
    CONTENT: {
      put: async (key, value, options) => { stored = { key, value, metadata: options.metadata }; },
      getWithMetadata: async key => key === stored.key ? stored : { value: null }
    }
  };
  const published = await worker.fetch(new Request("https://worker.test/api/archives/kong", {
    method: "PUT",
    headers: { Authorization: "Bearer test-secret", "X-Article-Count": "384" },
    body: gzipSync(xml)
  }), env);
  assert.equal(published.status, 201);
  assert.equal(stored.metadata.count, 384);
  const response = await worker.fetch(new Request("https://worker.test/rss/kong-blog.xml"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Encoding"), "gzip");
  assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), xml);
});

test("unselected Kong categories do not start a capture job", async () => {
  const response = await worker.fetch(new Request("https://worker.test/hooks/test-hook", {
    method: "POST",
    body: JSON.stringify({ items: [{ url: "https://konghq.com/blog/product-releases/example" }] })
  }), { HOOK_SECRET: "test-hook" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 0 });
});
