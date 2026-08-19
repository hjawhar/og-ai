import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';

import { BytesPipe } from '../../pipes/bytes.pipe';
import { VerdictBadgeComponent } from '../verdict-badge/verdict-badge.component';
import type { CatalogEntry } from '../../models/state.model';

/**
 * Weights this repository knows how to fetch, with the same verdict treatment as
 * the installed table — the point is to see whether a 16 GiB download is worth
 * starting *before* starting it.
 */
@Component({
  selector: 'og-model-catalog',
  templateUrl: './model-catalog.component.html',
  styleUrls: ['./model-catalog.component.scss'],
  imports: [BytesPipe, DecimalPipe, VerdictBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModelCatalogComponent {
  readonly entries = input.required<readonly CatalogEntry[]>();
  /** Catalogue key whose download or cancellation is in flight. */
  readonly busyKey = input<string | null>(null);

  readonly downloadRequested = output<string>();
  readonly cancelRequested = output<string>();

  percentOf(entry: CatalogEntry): number {
    const download = entry.download;
    if (download === undefined || download.totalBytes <= 0) {
      return 0;
    }
    return Math.min(100, (download.receivedBytes / download.totalBytes) * 100);
  }
}
