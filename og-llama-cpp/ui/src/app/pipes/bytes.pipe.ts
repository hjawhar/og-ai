import { Pipe } from '@angular/core';
import type { PipeTransform } from '@angular/core';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Bytes as binary units. GGUF sizes are quoted in GiB everywhere in this repository and by
 * `nvidia-smi`, so a 17,665,334,432-byte file reads as "16.45 GiB" here and never "17.7 GB".
 */
@Pipe({ name: 'bytes' })
export class BytesPipe implements PipeTransform {
  transform(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
      return '--';
    }
    if (value >= GIB) {
      return `${(value / GIB).toFixed(2)} GiB`;
    }
    if (value >= MIB) {
      return `${Math.round(value / MIB).toLocaleString('en-US')} MiB`;
    }
    return `${Math.round(value / 1024).toLocaleString('en-US')} KiB`;
  }
}
