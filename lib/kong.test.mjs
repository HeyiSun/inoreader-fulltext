import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeKongEntries, readKongFeed, renderKongFeed } from "./kong.mjs";

test("Kong history and new captures merge by URL within the selected categories", () => {
  const old = { url: "https://konghq.com/blog/engineering/example", title: "Old", published: 100, html: "<p>Old</p>" };
  const updated = { ...old, title: "Updated", html: '<p>Updated &amp; complete</p><img src="https://example.com/image.png">', tags: ["Engineering", "API Gateway"] };
  const excluded = { ...old, url: "https://konghq.com/blog/product-releases/example" };
  const entries = mergeKongEntries([old, excluded], [updated]);
  assert.equal(entries.length, 1);
  const restored = readKongFeed(renderKongFeed(entries, "https://worker.test"));
  assert.equal(restored[0].title, "Updated");
  assert.equal(restored[0].html, updated.html);
  assert.deepEqual(restored[0].tags, updated.tags);
  assert.equal(restored[0].published, 100);
});
