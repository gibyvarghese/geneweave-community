# geneWeave — community edition

The open-source **geneWeave / weaveNotes** application, built on the [weaveIntel](https://github.com/gibyvarghese/weaveintel)
AI framework. This repository is the app on its own: it consumes the framework as published
`@weaveintel/*` npm packages — there is no framework source vendored here.

- **Framework (MIT, the reusable library):** https://github.com/gibyvarghese/weaveintel — `@weaveintel/*` on npm.
- **This repo:** the geneWeave apps (`apps/geneweave`, `apps/geneweave-ui`) that build a real product on top of it.

## Quick start

```bash
npm install        # pulls @weaveintel/* from the npm registry
npm run build
npm run typecheck
npm test            # unit + integration tests (Playwright e2e need a running server)

npm run dev         # start the geneWeave API + UI locally
```

Requires Node 20+.

## Layout

```
apps/
  geneweave/       the API + server (chat, notes, agents, tools, admin)
  geneweave-ui/    the browser UI + the geneWeave brand (design tokens, themes)
```

The apps own their **brand and product configuration** directly (colours, themes, product features);
the framework packages they import are brand-neutral.

## Relationship to the framework

geneWeave is the reference product for weaveIntel — a large, real-world example of how the framework's
pieces (model providers, agents, tools, retrieval, guardrails, collaboration) come together in a shipping
application. When the framework releases a new version on npm, bump the `@weaveintel/*` versions here and
re-run `npm run build && npm test`.

For the framework's own docs, package guide, and migration notes, see the
[weaveIntel repository](https://github.com/gibyvarghese/weaveintel).

## License

MIT — see [LICENSE](./LICENSE).
