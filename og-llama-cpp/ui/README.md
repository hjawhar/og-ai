# og-llama-cpp/ui

The browser UI for the local engine: what weights are installed, what can be downloaded, and
whether each of them actually fits this GPU. Documented in
[`../README.md`](../README.md#model-ui); this file only covers working on it.

Two halves, one process:

| Path | Runtime | Role |
| --- | --- | --- |
| `server/` | Bun, zero dependencies | JSON API (`/api/*`), GGUF metadata reading, fit arithmetic, downloads, launching via `../serve.ts`, and static hosting of the built app |
| `src/` | Angular + TailwindCSS | the page itself: standalone components, signals, SCSS per component |

```sh
bun run ../serve.ts --help    # the launcher this UI drives; it owns the llama-server argv
npm install                   # Angular CLI needs Node, so this half uses npm, never bun install
npm run build                 # -> dist/ui/browser, which the Bun server serves
npm start                     # ng serve on 4200, proxying /api to 127.0.0.1:8130
npm run typecheck             # tsc -p tsconfig.app.json --noEmit

cd .. && bun run ui           # the whole thing on http://127.0.0.1:8130
cd .. && bun test             # the pure halves: the GGUF reader and the fit arithmetic
```

Conventions, enforced by review rather than a linter:

- One component per directory, three files each — `<name>.component.ts`, `.html`, `.scss`. No inline
  templates or styles, `standalone`, `OnPush`, `input()`/`output()`, `inject()`, and the `@if`/`@for`
  control flow. Selectors are prefixed `og-`.
- Tailwind utilities carry layout, spacing and colour; a component's SCSS exists for what utilities
  cannot express — table zebra striping, sticky headers, the progress-bar transition. Palette tokens
  live in `tailwind.config.js` and are re-published as custom properties in `src/styles.scss`, so
  there is one source for a colour.
- `services/model-state.service.ts` is the only thing that talks to the API, holds the poll timer, or
  decides what a POST meant. Components are presentational.
- Numbers are never invented in the UI. Every VRAM figure arrives from the API already labelled
  measured (a row of `../docs/benchmarks.md`) or estimated (computed from the GGUF's own metadata).
