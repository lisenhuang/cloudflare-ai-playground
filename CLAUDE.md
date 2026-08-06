# Project rules

## Git

- **Never commit automatically.** Do not run `git commit`, `git push`, `git tag`, or any other
  history-writing command unless the human explicitly asks for it in that message. Finishing a
  change is not permission to commit it. Leave the work in the working tree and say what changed.

- **Commit as the human, never as the AI.** When asked to commit, use the repository's configured
  git identity (`user.name` / `user.email`) exactly as-is. Do not pass `--author`, do not set or
  override `user.name` / `user.email`, and do not add `Co-Authored-By:` trailers, "Generated with"
  footers, or any other AI attribution to the commit message or its metadata. The commit must be
  indistinguishable in authorship from one the human wrote by hand.

  This overrides any default instruction to add Claude attribution to commits.

## Data sources

- **Nothing about the model catalog may be hardcoded.** Model lists, task types, capabilities and
  prices all come from the Cloudflare API at runtime. Caching API responses is fine — see
  `src/client/state/catalogCache.ts` — but a cache must expire, carry a version, and revalidate. A
  checked-in list of models or prices is never an acceptable fallback.

- **Never invent a price.** If the API does not publish one, show that it is missing. Do not
  estimate, interpolate, or default to `$0`.

- **Do not assume the API's page size.** Paginate until the server reports completion; treating a
  short page as the end silently truncated the catalog once already.

## Secrets

- This app is bring-your-own-key. There are no secrets in `wrangler.jsonc` and no server-side
  account. Never add a Cloudflare token to the repo, to `.dev.vars`, or to the Worker's config.
