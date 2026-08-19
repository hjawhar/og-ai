import { Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

/** Rendering for a MiB figure: as MiB (matching `nvidia-smi`) or scaled to GiB. */
export type MibUnit = 'mib' | 'gib';

/**
 * VRAM is reported in MiB by `nvidia-smi` and by every measured row in docs/benchmarks.md,
 * so MiB is the default and GiB is opt-in for the places where a reader wants scale.
 */
@Pipe({ name: 'mib' })
export class MibPipe implements PipeTransform {
  transform(value: number, unit: MibUnit = 'mib'): string {
    if (!Number.isFinite(value)) {
      return '--';
    }
    return unit === 'gib'
      ? `${(value / 1024).toFixed(2)} GiB`
      : `${Math.round(value).toLocaleString('en-US')} MiB`;
  }
}
