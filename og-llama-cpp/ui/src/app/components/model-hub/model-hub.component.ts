import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { BytesPipe } from '../../pipes/bytes.pipe';
import { VerdictBadgeComponent } from '../verdict-badge/verdict-badge.component';
import { ModelHubService } from '../../services/model-hub.service';
import { ModelStateService } from '../../services/model-state.service';
import type {
  DownloadProgress,
  HubFile,
  HubFitFilter,
  HubInspection,
  HubResult,
} from '../../models/state.model';

/** The API's `fit` values in this page's own words: the keys are the server's, the words are ours. */
interface FitOption {
  readonly key: HubFitFilter;
  readonly label: string;
}

/**
 * Hugging Face, browsed rather than searched: the page opens on a preset the server chose and
 * every row already carries a verdict for this card, so "will this run here?" is answered before
 * a 16 GiB download starts. Those verdicts begin as size estimates, because the GGUF metadata is
 * still on the Hub; Inspect reads the real header over a Range request and the server replaces
 * the estimate with the same arithmetic an installed file gets.
 *
 * Unlike its sibling tables this component is not purely presentational: the filters, the open
 * row and the inspections are its own request-scoped state, so it drives `ModelHubService`
 * directly — the template calls it for the controls that only move a filter — and reads the
 * polled snapshot for download progress and whether a token is configured. Every preset, every
 * sort and every recommendation comes out of the reply.
 */
@Component({
  selector: 'og-model-hub',
  templateUrl: './model-hub.component.html',
  styleUrls: ['./model-hub.component.scss'],
  imports: [BytesPipe, DatePipe, DecimalPipe, VerdictBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelHubComponent {
  protected readonly hub = inject(ModelHubService);
  private readonly state = inject(ModelStateService);

  readonly response = this.hub.response;
  readonly query = this.hub.query;
  readonly loading = this.hub.loading;
  readonly error = this.hub.error;
  readonly expanded = this.hub.expanded;
  readonly inspections = this.hub.inspections;
  readonly inspecting = this.hub.inspecting;
  readonly activeFit = this.hub.fit;

  readonly fitOptions: readonly FitOption[] = [
    { key: 'any', label: 'Any verdict' },
    { key: 'runs', label: 'Runs on this GPU' },
    { key: 'gpu', label: 'Fits entirely in VRAM' },
  ];

  /** What was asked for wins over what was answered, so a control never lags its own click. */
  readonly activePreset = computed(() => this.hub.preset() ?? this.response()?.preset ?? null);
  readonly activeSort = computed(() => this.hub.sort() ?? this.response()?.query.sort ?? null);
  readonly openOnly = computed(() => this.hub.gated() === 'open');

  /** The size box's contents: blank means no ceiling, which is not the same as zero. */
  readonly maxGiBText = computed(() => {
    const ceiling = this.hub.maxGiB();
    return ceiling === null ? '' : String(ceiling);
  });

  /** The active preset's own account of the Hub query that produced these rows. */
  readonly presetNote = computed(() => {
    const key = this.activePreset();
    return this.response()?.presets.find((preset) => preset.key === key)?.note ?? null;
  });

  /** Progress for every download this process knows about, keyed the way `HubFile` is. */
  readonly downloads = computed<Record<string, DownloadProgress>>(
    () => this.state.state()?.downloads ?? {},
  );

  /** A gated repo needs a token in the server's environment, not in the browser. */
  readonly hubTokenPresent = computed(() => this.state.state()?.hubTokenPresent === true);

  /** The one download or cancellation in flight, so exactly one control reads as working. */
  readonly busyKey = computed(() => {
    const pending = this.state.pending();
    return pending?.kind === 'download' || pending?.kind === 'cancel' ? pending.key : null;
  });

  /** Narrowed against the options above rather than cast: a select's value is only a string. */
  setFit(value: string): void {
    const option = this.fitOptions.find((candidate) => candidate.key === value);
    if (option !== undefined) {
      this.hub.setFit(option.key);
    }
  }

  setOpenOnly(openOnly: boolean): void {
    this.hub.setGated(openOnly ? 'open' : 'any');
  }

  retry(): void {
    void this.hub.browse();
  }

  /**
   * The file the server recommends for this machine, looked up by the `rfilename` it named.
   * Absent when nothing in the repo runs here; which file is best is never decided here.
   */
  recommended(result: HubResult): HubFile | undefined {
    const best = result.best;
    return best === undefined ? undefined : result.files.find((file) => file.rfilename === best);
  }

  inspect(result: HubResult, file: HubFile): void {
    void this.hub.inspect(result.repo.id, file);
  }

  /**
   * Named for the action rather than the noun: the template's progress cell already binds a
   * `download` of its own, and a method sharing that name would resolve to the record.
   */
  startDownload(result: HubResult, file: HubFile): void {
    void this.state.downloadHubFile(result.repo.id, file.rfilename, file.downloadKey);
  }

  cancel(file: HubFile): void {
    void this.state.cancelDownload(file.downloadKey);
  }

  percentOf(download: DownloadProgress): number {
    if (download.totalBytes <= 0) {
      return 0;
    }
    return Math.min(100, (download.receivedBytes / download.totalBytes) * 100);
  }

  /** What the header actually said, each field independent: a GGUF may carry none of them. */
  chipsFor(header: HubInspection): string[] {
    const chips: string[] = [];
    if (header.arch !== undefined) chips.push(header.arch);
    if (header.layers !== undefined) chips.push(`${header.layers} layers`);
    if (header.experts !== undefined) chips.push(`${header.experts} experts`);
    if (header.trainedContext !== undefined) chips.push(`trained ctx ${header.trainedContext}`);
    if (header.moe) chips.push('MoE');
    return chips;
  }
}
