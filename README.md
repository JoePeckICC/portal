# InCadence Care — client portal (hosted page)

One page: `index.html`. It talks to the Apps Script back end over HTTPS; no data lives here.
Deployed to Cloudflare as a Worker with static assets (see `wrangler.toml`). Every commit to `main` publishes.
