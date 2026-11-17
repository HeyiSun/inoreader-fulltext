# Inoreader full text

Inoreader rules send new OpenAI articles to a Cloudflare Worker. The Worker starts a GitHub Actions job. The job captures article text and images, renders SVG figures as PNG, and publishes a full-text RSS feed from Workers KV.

This project uses Cloudflare's free Workers and KV allowances and standard GitHub-hosted runners in a public repository. Article feeds and their images are public. Webhook and publishing credentials are secrets.

## Deployment

1. Run `npm ci`.
2. Create a Workers KV namespace and bind it as `CONTENT` in `worker/wrangler.jsonc`.
3. Deploy using `npx wrangler deploy --config worker/wrangler.jsonc`.
4. Configure the Worker secrets `HOOK_SECRET`, `GITHUB_TOKEN`, and `PUBLISH_SECRET`.
5. Set the repository variable `WORKER_URL` and secret `PUBLISH_SECRET`.
6. Give the Worker's fine-grained GitHub token access to this repository with Actions write permission.
7. Configure Inoreader rules to POST new OpenAI articles to `/hooks/<HOOK_SECRET>`.
8. Subscribe to `/feeds/openai-engineering.xml`, `/feeds/openai-research.xml`, or `/feeds/openai-developer.xml`.

The workflow is event-triggered and can also be run manually from GitHub Actions. It has no periodic polling schedule. Existing article URLs are cached. A manual input can include `force: true` to recapture an article.

## Live feeds

- [OpenAI Engineering](https://inoreader-fulltext.inoreader-fulltext.workers.dev/feeds/openai-engineering.xml)
- [OpenAI Research](https://inoreader-fulltext.inoreader-fulltext.workers.dev/feeds/openai-research.xml)
- [OpenAI Developer Blog](https://inoreader-fulltext.inoreader-fulltext.workers.dev/feeds/openai-developer.xml)

The original Inoreader subscriptions trigger capture jobs. Read the generated subscriptions for the extracted content. Each output feed contains the latest 20 captured articles. Successful publications notify a WebSub hub, while delivery timing also depends on Inoreader's feed refresh.

## Extraction limits

The job first opens the original article in Chromium. If the original page cannot be read, it tries public RSSHub full-text feeds. Ordinary images retain their original URLs. Contentful SVG image URLs request a PNG rendition, and inline SVG figures are rendered into PNG files stored in Workers KV. The fallback includes styles for the Git and storage diagram components checked during setup.

Interactive figures become static snapshots. Figures that require unavailable client-side data retain a link to the original article. A changed website layout, unavailable upstream feed, or an expired GitHub trigger token can require maintenance. Failed captures are visible in GitHub Actions and can be rerun there. This deployment uses no AI model calls.

## Local checks

Run `npm test` to check payload validation, feed output, authentication and dispatch behavior.

The capture script accepts an `ARTICLE_INPUT` JSON array and writes a report under `artifacts/`. When the publishing environment is omitted it produces local diagnostics only.
