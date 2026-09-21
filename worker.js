// Static-only: every request is served from the assets. Kept so `wrangler deploy` has an entry point.
export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };
