/**
 * Field-for-field mirror of what `ui/server` returns from `GET /api/state`.
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
  /** Tail of the launched process's stdout+stderr, newest last. */
  readonly log: readonly string[];
}

/** Bytes on disk against bytes expected: a truncated GGUF that must not be served. */
export interface IncompleteFile {
  readonly haveBytes: number;
  readonly expectBytes: number;
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
  readonly catalogKey?: string;
  readonly incomplete?: IncompleteFile;
}

export type DownloadPhase = 'downloading' | 'done' | 'error' | 'cancelled';

export interface DownloadProgress {
  readonly state: DownloadPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly error?: string;
  readonly mbps: number;
}

export interface CatalogEntry {
  readonly key: string;
  readonly name: string;
  readonly params: string;
  readonly quant: string;
  readonly moe: boolean;
  readonly file: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly note: string;
  readonly installed: boolean;
  readonly fit: Fit;
  readonly download?: DownloadProgress;
}

export interface StateResponse {
  readonly hardware: Hardware;
  readonly engine: Engine;
  readonly server: ServerState;
  readonly installed: readonly InstalledModel[];
  readonly catalog: readonly CatalogEntry[];
  readonly modelsDir: string;
  /** The context length the fit arithmetic above was computed for. */
  readonly ctx: number;
}

/** Body of `POST /api/serve`. */
export interface ServeRequest {
  readonly file: string;
  readonly ctx?: number;
  readonly ncmoe?: number;
  readonly alias?: string;
}

/**
 * The one action currently in flight. Structured rather than a string tag so a component can
 * ask "is *this* row starting?" without parsing anything.
 */
export type PendingAction =
  | { readonly kind: 'download'; readonly key: string }
  | { readonly kind: 'cancel'; readonly key: string }
  | { readonly kind: 'serve'; readonly file: string }
  | { readonly kind: 'stop' };
