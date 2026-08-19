import { DestroyRef, DOCUMENT, Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { describeFailure } from './api-failure';
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
 * The single owner of the polled snapshot and of every mutation. Everything on the page reads
 * `state()`, and nothing else in the app holds a timer, POSTs, or decides what a POST meant;
 * `model-hub.service.ts` reads the Hub browser's GET-only endpoints and owns no state beyond
 * the filters, rows and inspections on screen.
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

  cancelDownload(key: string): Promise<void> {
    return this.act({ kind: 'cancel', key }, '/api/download/cancel', { key });
  }

  /**
   * Unlink a file, and with it every shard of a split set. Which files that is, and whether it is
   * allowed at all, is the server's call: this only says which row the operator confirmed.
   */
  deleteModel(file: string): Promise<void> {
    return this.act({ kind: 'delete', file }, '/api/models/delete', { file });
  }

  /**
   * Fetch a file the Hub browser found. `downloadKey` is the server's, passed through from the
   * row rather than rebuilt here, so the pending action and `state().downloads` agree on one
   * spelling of the key.
   */
  downloadHubFile(repo: string, rfilename: string, downloadKey: string): Promise<void> {
    return this.act({ kind: 'download', key: downloadKey }, '/api/download', { repo, rfilename });
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
