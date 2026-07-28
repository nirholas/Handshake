# docs/

Product and developer documentation for three.ws. Individual docs are served on the live site under `/docs/<slug>` and `/tutorials/<slug>`.

Start points:

- [start-here.md](start-here.md): the front door for both creators and developers, with the reference shelf at the bottom.
- [introduction.md](introduction.md) and [quick-start.md](quick-start.md): the developer track.
- [ALL.md](ALL.md): generated single-file aggregate of the public docs (regenerate with `node scripts/combine-docs.mjs`; edit source files, never ALL.md).
- [api-reference.md](api-reference.md): the REST API surface, with dedicated docs for the larger API families (crypto, 3D, market data, MCP).

Subdirectories: [tutorials/](tutorials/) (step-by-step guides served on-site), [specs/](specs/) (proposed contracts), [api/](api/), [erc8004/](erc8004/), [agent-abilities/](agent-abilities/), [ux-flows/](ux-flows/) (the UX Flow Atlas), [content/](content/) (use-case narratives), [partners/](partners/).

Private trees, excluded from the public site build and from ALL.md by `vite.config.js` and `scripts/combine-docs.mjs`: [ops/](ops/README.md) (production runbooks), [security/](security/) (review records), [internal/](internal/). Do not link to them from public docs.

Writing rules are in [CLAUDE.md](../CLAUDE.md) (Documentation section): every feature ships with its doc, every code sample runs, every link resolves, update rather than duplicate.
