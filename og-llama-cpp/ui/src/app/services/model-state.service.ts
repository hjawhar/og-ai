import { DestroyRef, DOCUMENT, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import type { PendingAction, ServeRequest, StateResponse } from '../models/state.model';

/**
 * Fast enough that a download's progress bar moves and a launching server's log grows, slow
 * enough that reading GGUF headers and shelling out to `nvidia-smi` on every tick stays cheap.
 */
const POLL_MS = 1500;

/** The context the measured default profile serves at (docs/benchmarks.md). */
const DEFAULT_CTX = 32768;

const MIN_CTX = 512;
const MAX_CTX = 1_048_576;

/**
 * The single owner of server state. Everything on the page reads `state()`; nothing else in
 * the app talks to the API, holds a timer, or decides what a POST meant.
 */
@Injectable({ providedIn: 'root' })
export class ModelStateService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);

  private readonly stateSignal = signal<StateResponse | null>(null);
  private readonly errorSignal = signal<string | null>(null);
  private readonly pendingSignal = signal<PendingAction | null>(null);
  private readonly ctxSignal = signal(DEFAULT_CTX);

  /** Latest snapshot, or null until the first read lands. */
  readonly state = this.stateSignal.asReadonly();
  /** Last failure, surfaced as a banner. Cleared by the next successful read. */
  readonly error = this.errorSignal.asReadonly();
  /** The action in flight, so exactly one control shows as working. */
  readonly pending = this.pendingSignal.asReadonly();
  /** Context length the server is asked to compute fit arithmetic for. */
  readonly ctx = this.ctxSignal.asReadonly();

  /** Read in flight — the poll skips a tick rather than stacking requests on a slow API. */
  private reading = false;
  /** Monotonic read id: a response that is no longer the newest is discarded. */
  private sequence = 0;
  /** `window.setInterval` handle; null while the tab is hidden. */
  private timer: number | null = null;

  constructor() {
    // Polling a page nobody is looking at keeps `nvidia-smi` busy and the card awake.
    const onVisibilityChange = (): void => {
      if (this.document.visibilityState === 'visible') {
        this.resume();
      } else {
        this.pause();
      }
    };

    this.document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      this.pause();
    });

    this.resume();
  }

  /** Recompute every verdict for a different context length. */
  setCtx(ctx: number): void {
    if (!Number.isFinite(ctx)) {
      return;
    }
    const clamped = Math.min(MAX_CTX, Math.max(MIN_CTX, Math.trunc(ctx)));
    if (clamped === this.ctxSignal()) {
      return;
    }
    this.ctxSignal.set(clamped);
    void this.read();
  }

  download(key: string): Promise<void> {
    return this.act({ kind: 'download', key }, '/api/download', { key });
  }

  cancelDownload(key: string): Promise<void> {
    return this.act({ kind: 'cancel', key }, '/api/download/cancel', { key });
  }

  serve(request: ServeRequest): Promise<void> {
    return this.act({ kind: 'serve', file: request.file }, '/api/serve', request);
  }

  stopServer(): Promise<void> {
    return this.act({ kind: 'stop' }, '/api/server/stop', {});
  }

  private resume(): void {
    void this.read();
    this.timer ??= window.setInterval(() => {
      if (!this.reading) {
        void this.read();
      }
    }, POLL_MS);
  }

  private pause(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async read(): Promise<void> {
    const id = ++this.sequence;
    this.reading = true;
    try {
      const params = new HttpParams().set('ctx', this.ctxSignal());
      const next = await firstValueFrom(this.http.get<StateResponse>('/api/state', { params }));
      // A slower earlier read must never overwrite a newer one.
      if (id === this.sequence) {
        this.stateSignal.set(next);
        this.errorSignal.set(null);
      }
    } catch (cause) {
      if (id === this.sequence) {
        this.errorSignal.set(describeFailure(cause));
      }
    } finally {
      if (id === this.sequence) {
        this.reading = false;
      }
    }
  }

  /**
   * A POST reply only says the request was accepted — a download that will fail on its third
   * chunk and a server that will die during load both answer 200 here. State comes from the
   * read that follows, which is issued whether the POST succeeded or not.
   */
  private async act(action: PendingAction, url: string, body: object): Promise<void> {
    this.pendingSignal.set(action);
    try {
      await firstValueFrom(this.http.post<unknown>(url, body));
      this.errorSignal.set(null);
    } catch (cause) {
      this.errorSignal.set(describeFailure(cause));
    } finally {
      this.pendingSignal.set(null);
      await this.read();
    }
  }
}

function describeFailure(cause: unknown): string {
  if (cause instanceof HttpErrorResponse) {
    // status 0 is the browser refusing to say more: the API is down or the port moved.
    if (cause.status === 0) {
      return 'Cannot reach the model API. Is `bun run ui` still running on 127.0.0.1:8130?';
    }
    const detail = messageFromBody(cause.error);
    return detail === null
      ? `${cause.status} ${cause.statusText} from ${cause.url ?? 'the API'}`
      : `${cause.status} ${cause.statusText}: ${detail}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function messageFromBody(body: unknown): string | null {
  if (typeof body === 'string' && body.trim() !== '') {
    return body.trim();
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };
    if (typeof error === 'string' && error.trim() !== '') {
      return error.trim();
    }
  }
  return null;
}
