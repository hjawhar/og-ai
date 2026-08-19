/**
 * Field-for-field mirror of what `ui/server` returns from `GET /api/state` and the
 * `GET /api/hub/*` explorer endpoints.
 *
 * Nothing derived lives here. Every fit verdict, every sentence of arithmetic and every
 * suggested flag is computed server-side, where the GGUF metadata and `nvidia-smi` actually
 * are; the browser only renders them. Adding a computed property to this file would create a
 * second place that decides whether a model fits, which is exactly the bug this page exists
 * to prevent.
 */

/** How a model relates to this card's VRAM budget. */
export type FitVerdict = 'gpu' | 'offload' | 'partial' | 'cpu' | 'no' | 'unknown';

export interface Fit {
  readonly verdict: FitVerdict;
  /** Short human label, e.g. "fits with expert offload (measured)". */
  readonly label: string;
  /** One sentence of arithmetic, already written server-side. */
  readonly detail: string;
  readonly weightsMiB: number;
  readonly kvMiB?: number;
  readonly budgetMiB: number;
  /** A concrete flag to pass, e.g. "--n-cpu-moe 14" or "-ngl 38". */
  readonly suggestion?: string;
  /** Pre-formatted rows from docs/benchmarks.md — a real run, not an estimate. */
  readonly measured?: string;
}

/**
 * Peak arithmetic throughput of a card, derived server-side from its SM count and
 * rated boost clock. A ceiling, not a measurement: nothing on this page claims to
 * have reached it.
 */
export interface ComputePeak {
  /** Architecture and tensor-core generation, e.g. "Blackwell, 5th-gen tensor cores". */
  readonly arch: string;
  readonly sm: number;
  readonly boostGhz: number;
  /** CUDA cores, FP32 FMA. */
  readonly fp32Tflops: number;
  /** Tensor cores, dense FP16 with FP16 accumulate — the published headline. */
  readonly fp16Tflops: number;
  /** Tensor cores, dense FP16/BF16 with FP32 accumulate: half of `fp16Tflops` on GeForce. */
  readonly fp16Fp32AccTflops: number;
  /** Tensor cores, dense INT8, no sparsity. */
  readonly int8Tops: number;
}

export interface Gpu {
  readonly index: number;
  readonly name: string;
  readonly totalMiB: number;
  readonly usedMiB: number;
  readonly freeMiB: number;
  /** Absent when the card is not in the server's peak table. */
  readonly peak?: ComputePeak;
}

export interface Hardware {
  readonly os: string;
  readonly hostname: string;
  readonly cpu: string;
  readonly threads: number;
  readonly ramTotalMiB: number;
  readonly ramFreeMiB: number;
  readonly gpus: readonly Gpu[];
  /** The margin every measured profile leaves free — 1200 MiB. */
  readonly headroomMiB: number;
  /** `gpu.totalMiB - headroomMiB`, or 0 when there is no GPU. */
  readonly budgetMiB: number;
}

export interface Engine {
  readonly root: string;
  readonly binary: string;
  readonly present: boolean;
  readonly build?: string;
  readonly version?: string;
  readonly devices: readonly string[];
}

export interface ServedModel {
  readonly id: string;
  readonly nCtx?: number;
}

export interface ServerState {
  readonly url: string;
  readonly reachable: boolean;
  readonly models: readonly ServedModel[];
  readonly launchedHere: boolean;
  readonly launching: boolean;
  readonly pid?: number;
  /**
   * The weights file this process launched, when it launched one. Informational only: whether a
   * row can be deleted arrives as `InstalledModel.blocked`, already decided server-side.
   */
  readonly file?: string;
  /** Tail of the launched process's stdout+stderr, newest last. */
  readonly log: readonly string[];
}

/**
 * Why a file in the models directory cannot be served. `downloading` is a `.part` file sitting
 * beside it; `short` is a file whose own tensor table needs more bytes than the file has, and is
 * the only reason that carries an `expectBytes`. The reason is the server's: nothing here infers
 * one from a size comparison.
 */
export interface IncompleteFile {
  readonly reason: 'downloading' | 'short';
  readonly haveBytes: number;
  /** Bytes the file's own tensor table needs; present only when `reason` is `short`. */
  readonly expectBytes?: number;
}

export interface InstalledModel {
  readonly file: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly arch?: string;
  readonly layers?: number;
  readonly trainedContext?: number;
  readonly experts?: number;
  readonly moe: boolean;
  readonly fit: Fit;
  readonly measured?: string;
  readonly incomplete?: IncompleteFile;
  /**
   * Every file that goes when this model is deleted: `[file]` for an ordinary single-file model,
   * one entry per shard for a `gguf-split` set, which is useless a shard at a time.
   */
  readonly shards: readonly string[];
  /**
   * Why this file cannot be deleted, as a whole sentence naming the obstacle — the running
   * server holds it open, or a download is writing it. Absent when it can go. The words are the
   * server's: nothing here composes a reason, and nothing here infers one from the snapshot.
   */
  readonly blocked?: string;
}

export type DownloadPhase = 'downloading' | 'done' | 'error' | 'cancelled';

export interface DownloadProgress {
  readonly state: DownloadPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly error?: string;
  readonly mbps: number;
  /** The part currently being written — the only shard of a normal file. */
  readonly file: string;
  /** Present only while a multi-shard download is in flight. */
  readonly partIndex?: number;
  readonly partCount?: number;
}

/** The `fit` filter's values, exactly as `GET /api/hub/browse` accepts them. */
export type HubFitFilter = 'any' | 'runs' | 'gpu';

/** The `gated` filter's values: `open` drops repositories that need an accepted licence. */
export type HubGatedFilter = 'any' | 'open';

export interface StateResponse {
  readonly hardware: Hardware;
  readonly engine: Engine;
  readonly server: ServerState;
  readonly installed: readonly InstalledModel[];
  /**
   * Every download this process knows about, keyed by download key. A Hub file finds its
   * progress here under the `downloadKey` its row was served with.
   */
  readonly downloads: Record<string, DownloadProgress>;
  readonly modelsDir: string;
  /** The context length the fit arithmetic above was computed for. */
  readonly ctx: number;
  /** Whether the server has an `HF_TOKEN`/`HUGGING_FACE_HUB_TOKEN`: gated repos need one. */
  readonly hubTokenPresent: boolean;
}

/** Body of `POST /api/serve`. */
export interface ServeRequest {
  readonly file: string;
  readonly ctx?: number;
  readonly ncmoe?: number;
  readonly alias?: string;
}

/**
 * A repository `GET /api/hub/browse` matched, exactly as huggingface.co reported it. Nothing
 * here is this machine's opinion: `downloads` and `likes` are the Hub's counters.
 */
export interface HubRepo {
  readonly id: string;
  readonly downloads: number;
  readonly likes: number;
  /** Hugging Face wants its terms accepted first: fetching fails without a server-side token. */
  readonly gated: boolean;
  readonly tags: readonly string[];
  readonly pipeline?: string;
  /** ISO timestamp of the last commit; absent when the Hub omits it. */
  readonly updatedAt?: string;
}

/** A named Hub query the server offers. The key, the label and the note are all the server's. */
export interface HubPreset {
  readonly key: string;
  readonly label: string;
  /** Which Hub query this preset actually runs, so the list on screen is never a mystery. */
  readonly note: string;
}

/** An ordering the server accepts for `sort`, with the words to put on the control. */
export interface HubSort {
  readonly key: string;
  readonly label: string;
}

/** What the reply below actually answered — the server's reading of the filters that were sent. */
export interface HubQuery {
  /** Free text ANDed with the preset's tags; empty means preset only. */
  readonly search: string;
  readonly tags: readonly string[];
  readonly sort: string;
  readonly fit: HubFitFilter;
  readonly gated: HubGatedFilter;
  readonly ctx: number;
  /** Absent when no size ceiling was asked for. */
  readonly maxGiB?: number;
}

/** One downloadable GGUF inside a repo, with the verdict the server computed for it. */
export interface HubFile {
  /** Path within the repo, which is what both download and inspect are asked for. */
  readonly rfilename: string;
  /** Basename, i.e. what lands in the models directory. */
  readonly file: string;
  /** Absent when the quantisation could not be read off the filename. */
  readonly quant?: string;
  /** Total across every shard, so this is what the download will actually move. */
  readonly sizeBytes: number;
  /** Files the weights are split across; 1 for a normal single file. */
  readonly shards: number;
  /** Key for `POST /api/download/cancel` and for `StateResponse.downloads`. */
  readonly downloadKey: string;
  readonly installed: boolean;
  /**
   * Estimated from the file size alone: the GGUF metadata is not on this machine yet, so
   * `kvMiB` is absent and `detail` says as much. `GET /api/hub/inspect` replaces it with
   * arithmetic over the real header.
   */
  readonly fit: Fit;
}

/**
 * One repository and every GGUF it ships that this engine can launch: vision projectors and
 * multi-token-prediction heads are separate modules `../serve.ts` builds no flag for, and the
 * server leaves them out rather than showing a 440 MiB row that "fits". Files arrive smallest
 * first, with split weights already collapsed into one row.
 *
 * There is no `moe` here on purpose. The Hub's config does not reliably declare experts, and a
 * filename is a convention rather than metadata; whether a file is MoE comes out of its own
 * tensor table, which only `/api/hub/inspect` has read.
 */
export interface HubResult {
  readonly repo: HubRepo;
  /**
   * `rfilename` of the file the server recommends for this machine — best verdict, largest
   * among equals. Absent when nothing in the repo runs here. Look it up in `files`; which file
   * is best is never decided in the browser.
   */
  readonly best?: string;
  readonly files: readonly HubFile[];
}

/**
 * Reply from `GET /api/hub/browse`. `presets` and `sorts` are the server's whole vocabulary for
 * the controls above the list; `scanned` against `matched` is how many repositories the Hub
 * returned against how many survived the filters, so a short list reads as filtered rather than
 * as an empty Hub.
 */
export interface HubBrowseResponse {
  readonly preset: string;
  readonly presets: readonly HubPreset[];
  readonly sorts: readonly HubSort[];
  readonly query: HubQuery;
  readonly scanned: number;
  readonly matched: number;
  readonly repos: readonly HubResult[];
}

/**
 * Reply from `GET /api/hub/inspect`: the first 4 MiB of the remote file, read over a Range
 * request, which turns the size guess above into the same arithmetic an installed file gets —
 * before the other 16 GiB are downloaded.
 */
export interface HubInspection {
  readonly fit: Fit;
  readonly arch?: string;
  readonly layers?: number;
  readonly trainedContext?: number;
  readonly experts?: number;
  /** Authoritative: read from the file's own tensor table, not guessed from its name. */
  readonly moe: boolean;
  /**
   * Sharded model: shard 1's metadata sizes the KV cache correctly, but its tensor table only
   * covers shard 1, so no `--n-cpu-moe` suggestion would be honest.
   */
  readonly expertsUnknown: boolean;
}

/**
 * The one action currently in flight. Structured rather than a string tag so a component can
 * ask "is *this* row starting?" without parsing anything.
 */
export type PendingAction =
  | { readonly kind: 'download'; readonly key: string }
  | { readonly kind: 'cancel'; readonly key: string }
  | { readonly kind: 'serve'; readonly file: string }
  | { readonly kind: 'delete'; readonly file: string }
  | { readonly kind: 'stop' };
