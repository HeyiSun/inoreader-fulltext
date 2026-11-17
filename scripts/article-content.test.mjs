import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { extractArticleHtml, sanitizeArticleHtml } from "./article-content.mjs";

test("Kong extraction preserves code and images without duplicate machine-readable text", () => {
  const { document } = parseHTML('<main><div class="toc-body"><p><a href="/docs"><span class="agent">[Docs](/docs)</span><span>Docs</span></a></p><pre><code><span class="linenumber">1</span><span>echo</span> hello\n<span class="linenumber">2</span>next</code></pre><img src="/figure.png"></div></main>');
  const html = sanitizeArticleHtml(extractArticleHtml({ document, selector: "main .toc-body", articleUrl: "https://konghq.com/blog/test" }));
  assert.match(html, /<pre><code>echo hello\nnext<\/code><\/pre>/);
  assert.match(html, /https:\/\/konghq.com\/figure.png/);
  assert.doesNotMatch(html, /\[Docs\]/);
});

test("placeholder URLs retain their visible text without preventing extraction", () => {
  const { document } = parseHTML('<main><div class="toc-body"><a href="http://managerhost:port/info">manager URL</a><a href="http://&lt;kong_host&gt;:8001/routes/">route URL</a></div></main>');
  const html = sanitizeArticleHtml(extractArticleHtml({ document, selector: "main .toc-body", articleUrl: "https://konghq.com/blog/test" }));
  assert.equal(html, "<a>manager URL</a><a>route URL</a>");
});
