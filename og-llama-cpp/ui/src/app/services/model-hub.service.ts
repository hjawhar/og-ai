import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { describeFailure } from './api-failure';
import { ModelStateService } from './model-state.service';
import type {
  HubBrowseResponse,
  HubFile,
  HubFitFilter,
  HubGatedFilter,
  HubInspection,
} from '../models/state.model';

/**
 * The Hugging Face browser's half of the API: two GETs, both request-scoped, neither polled.
 *
 * `GET /api/hub/browse` answers with the repositories a preset matched *and* every launchable
 * GGUF inside them, so expanding a row is local and instant. What this service holds is only
 * what is on screen: the filters the last reply answered, that reply, the row expanded under it
 * and the inspections done inside it.
 *
 * Everything numeric in those replies was computed by the server against this machine's card,
 * exactly as `ModelStateService`'s snapshot is. A verdict is never derived here — nor is the
 * list of presets, the list of sorts or which file in a repo is the recommended one.
 */
@Injectable({ providedIn: 'root' })
export class ModelHubService {
  private readonly http = inject(HttpClient);
  private readonly state = inject(ModelStateService);

  private readonly presetSignal = signal<string | null>(null);
  private readonly querySignal = signal('');
  private readonly sortSignal = signal<string | null>(null);
  private readonly fitSignal = signal<HubFitFilter>('any');
  private readonly gatedSignal = signal<HubGatedFilter>('any');
  private readonly maxGiBSignal = signal<number | null>(null);
  private readonly responseSignal = signal<HubBrowseResponse | null>(null);
  private readonly loadingSignal = signal(false);
  private readonly errorSignal = signal<string | null>(null);
  private readonly expandedSignal = signal<string | null>(null);
  private readonly inspectionsSignal = signal<Record<string, HubInspection>>({});
  private readonly inspectingSignal = signal<string | null>(null);

  /** Preset asked for, or null while the server's own default is what is on screen. */
  readonly preset = this.presetSignal.asReadonly();
  /** Free text ANDed with the preset's tags, trimmed. Empty until the box is submitted. */
  readonly query = this.querySignal.asReadonly();
  /** Sort key asked for, or null while the server's default ordering is what is on screen. */
  readonly sort = this.sortSignal.asReadonly();
  /** Which verdicts the list is restricted to. */
  readonly fit = this.fitSignal.asReadonly();
  /** Whether repositories needing an accepted licence are dropped. */
  readonly gated = this.gatedSignal.asReadonly();
  /** Size ceiling in GiB, or null for no ceiling. */
  readonly maxGiB = this.maxGiBSignal.asReadonly();
  /** The last browse reply: the rows, and the vocabulary every control above them renders from. */
  readonly response = this.responseSignal.asReadonly();
  /** A browse is in flight, so the controls read as working. */
  readonly loading = this.loadingSignal.asReadonly();
  /** Last Hub failure, in the browser's own banner. Cleared by the next call. */
  readonly error = this.errorSignal.asReadonly();
  /** Repo id whose file table is open. Expansion needs no request: the files already arrived. */
  readonly expanded = this.expandedSignal.asReadonly();
  /** Upgraded verdicts from `/api/hub/inspect`, keyed by `downloadKey` — unique across repos. */
  readonly inspections = this.inspectionsSignal.asReadonly();
  /** The file whose header is being read right now, by `downloadKey`. */
  readonly inspecting = this.inspectingSignal.asReadonly();

  /** Monotonic id: a reply that is no longer the newest is discarded rather than rendered. */
  private browseSequence = 0;

  constructor() {
    effect(() => {
      // Reading ctx is the point: every verdict in the list was computed for it, so moving the
      // control re-asks rather than leaving rows that answer a context the page no longer shows.
      // Untracked around the call so the filters it reads do not become dependencies too — and
      // because this effect's first run is the page's first load, the list is never empty.
      this.state.ctx();
      untracked(() => void this.browse());
    });
  }

  /** Ask the server for the current preset and filters, at the context on screen. */
  async browse(): Promise<void> {
    const sequence = ++this.browseSequence;
    this.loadingSignal.set(true);
    this.errorSignal.set(null);
    try {
      const reply = await firstValueFrom(
        this.http.get<HubBrowseResponse>('/api/hub/browse', { params: this.params() }),
      );
      if (sequence === this.browseSequence) {
        this.responseSignal.set(reply);
        // Every inspection was arithmetic over a file in the list being replaced.
        this.inspectionsSignal.set({});
        this.expandedSignal.update((id) =>
          id !== null && reply.repos.some((result) => result.repo.id === id) ? id : null,
        );
      }
    } catch (cause) {
      // The last good reply is kept on purpose: the controls above the rows are rendered from
      // it, and a failed filter change that erased the preset list would leave nothing to retry
      // with. The banner says the request failed.
      if (sequence === this.browseSequence) {
        this.errorSignal.set(describeFailure(cause));
      }
    } finally {
      if (sequence === this.browseSequence) {
        this.loadingSignal.set(false);
      }
    }
  }

  setPreset(key: string): void {
    if (key === this.presetSignal()) {
      return;
    }
    this.presetSignal.set(key);
    void this.browse();
  }

  setSort(key: string): void {
    if (key === this.sortSignal()) {
      return;
    }
    this.sortSignal.set(key);
    void this.browse();
  }

  setFit(fit: HubFitFilter): void {
    if (fit === this.fitSignal()) {
      return;
    }
    this.fitSignal.set(fit);
    void this.browse();
  }

  setGated(gated: HubGatedFilter): void {
    if (gated === this.gatedSignal()) {
      return;
    }
    this.gatedSignal.set(gated);
    void this.browse();
  }

  /** The ceiling as typed. Blank clears it; anything that is not a positive number is ignored. */
  setMaxGiB(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (this.maxGiBSignal() !== null) {
        this.maxGiBSignal.set(null);
        void this.browse();
      }
      return;
    }
    const value = Number.parseFloat(trimmed);
    if (!Number.isFinite(value) || value <= 0 || value === this.maxGiBSignal()) {
      return;
    }
    this.maxGiBSignal.set(value);
    void this.browse();
  }

  /** Narrow within the preset. Submitted explicitly: typing alone asks huggingface.co nothing. */
  search(text: string): void {
    this.querySignal.set(text.trim());
    void this.browse();
  }

  /** Open a repo's file table, or close the one already open. Purely local: no request. */
  toggle(id: string): void {
    this.expandedSignal.update((current) => (current === id ? null : id));
  }

  /**
   * Read the remote file's real GGUF header, which replaces its size-only estimate with the same
   * arithmetic an installed file gets.
   */
  async inspect(repo: string, file: HubFile): Promise<void> {
    const ctx = this.state.ctx();
    const key = file.downloadKey;
    this.inspectingSignal.set(key);
    this.errorSignal.set(null);
    try {
      const params = new HttpParams()
        .set('repo', repo)
        .set('rfilename', file.rfilename)
        .set('ctx', ctx);
      const reply = await firstValueFrom(
        this.http.get<HubInspection>('/api/hub/inspect', { params }),
      );
      // A re-browse or a moved ctx control makes this reply arithmetic for something the page is
      // no longer showing.
      if (this.state.ctx() === ctx && this.stillListed(key)) {
        this.inspectionsSignal.update((current) => ({ ...current, [key]: reply }));
      }
    } catch (cause) {
      this.errorSignal.set(describeFailure(cause));
    } finally {
      if (this.inspectingSignal() === key) {
        this.inspectingSignal.set(null);
      }
    }
  }

  private params(): HttpParams {
    // `limit` is left to the server: how many repositories are worth scanning is its decision,
    // not a number this page should hold a second copy of.
    let params = new HttpParams()
      .set('ctx', this.state.ctx())
      .set('fit', this.fitSignal())
      .set('gated', this.gatedSignal());
    const preset = this.presetSignal();
    if (preset !== null) {
      params = params.set('preset', preset);
    }
    const sort = this.sortSignal();
    if (sort !== null) {
      params = params.set('sort', sort);
    }
    const query = this.querySignal();
    if (query !== '') {
      params = params.set('q', query);
    }
    const maxGiB = this.maxGiBSignal();
    if (maxGiB !== null) {
      params = params.set('maxGiB', maxGiB);
    }
    return params;
  }

  private stillListed(downloadKey: string): boolean {
    const reply = this.responseSignal();
    return (
      reply !== null &&
      reply.repos.some((result) => result.files.some((file) => file.downloadKey === downloadKey))
    );
  }
}
