# og-llama-cpp/ui

The browser UI for the local engine: what weights are installed, what Hugging Face publishes as
GGUF, and whether each of them actually fits this GPU. Documented in
[`../README.md`](../README.md#model-ui); this file only covers working on it.

Two halves, one process:

| Path | Runtime | Role |
| --- | --- | --- |
| `server/` | Bun, zero dependencies | JSON API (`/api/*`), GGUF metadata reading, fit arithmetic, downloads, deleting installed weights, the Hugging Face browse presets and remote-header inspection, launching via `../serve.ts`, and static hosting of the built app |
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
  cannot express — table zebra striping, sticky headers, the progress-bar transition. The shapes
  every table shares (`.scroller`, `.grid-table`, `.num`, `.actions`, `.detail`, `.progress`,
  `.bar`, `.installed`, `.failed`) are defined once in `src/styles.scss` under `@layer components`;
  a component keeps only what is genuinely its own. Palette tokens live in `tailwind.config.js`
  and are re-published as custom properties in `src/styles.scss`, so there is one source for a
  colour.
- `services/model-state.service.ts` owns the polled snapshot, the poll timer, and every POST —
  what a mutation meant is decided in one place. `services/model-hub.service.ts` owns the Hugging
  Face browser's two GETs, which are request-scoped rather than polled, and holds only what is on
  screen: the filters, the last `/api/hub/browse` reply, the row expanded inside it and its
  inspections. Expanding a repo costs no request — `browse` returns each repo's launchable GGUFs
  inline. Components render the snapshot and are presentational; `model-hub` is the exception,
  because a half-typed query is nobody else's business.
- Destructive actions ask first, and decide nothing. Delete opens a native `<dialog>` through
  `showModal()` — no dialog library, no scroll lock of our own — naming the file, its size and,
  for a `gguf-split` set, every shard that goes with it and how many. Escape and Cancel touch
  nothing; only the confirm button POSTs. Whether a file *can* go is the API's `blocked` sentence
  on the row, shown as the disabled reason in the row's own words and never recomputed from the
  snapshot, and the row leaves on the next poll rather than being hidden optimistically.
- The browse surface has no vocabulary of its own. Presets, their labels, their notes and the sort
  keys all arrive in the reply and are rendered from it; the only strings the page owns are the
  words on the `fit` filter (`any`/`runs`/`gpu`) and the ceiling typed into the GiB box. Which file
  in a repository is recommended is the server's `best`, looked up by `rfilename` — never
  recomputed here.
- Numbers are never invented in the UI. Every VRAM figure arrives from the API already labelled
  measured (a row of `../docs/benchmarks.md`) or estimated (computed from the GGUF's own metadata).
  A Hub file starts out estimated from its file size alone, since its metadata is still remote;
  Inspect asks the server to read the real header over a range request and replaces the verdict
  with the same arithmetic an installed file gets. The browser never does that arithmetic.
