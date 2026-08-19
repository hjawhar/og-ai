import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { MibPipe } from '../../pipes/mib.pipe';
import type { Engine, Hardware } from '../../models/state.model';

/**
 * What this machine is, and how much of its VRAM a model may use. The budget card
 * is the number every verdict on the page is measured against, so it is stated
 * once, here, with its arithmetic visible.
 */
@Component({
  selector: 'og-hardware-panel',
  templateUrl: './hardware-panel.component.html',
  styleUrls: ['./hardware-panel.component.scss'],
  imports: [MibPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HardwarePanelComponent {
  readonly hardware = input.required<Hardware>();
  readonly engine = input.required<Engine>();
  /** True while a server is up: its own weights are what "in use" is then made of. */
  readonly serving = input(false);

  readonly gpu = computed(() => this.hardware().gpus[0]);

  /** Percentage of the card in use right now, for the meter. */
  readonly usedPct = computed(() => {
    const gpu = this.gpu();
    if (gpu === undefined || gpu.totalMiB <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (gpu.usedMiB / gpu.totalMiB) * 100));
  });

  /**
   * A card that is already close to full is the failure this page exists to
   * prevent: the verdicts assume the budget is free, and a browser or a second
   * model quietly takes it away. Not a warning while something is deliberately
   * serving — the loaded weights are supposed to be occupying the card.
   */
  readonly budgetAtRisk = computed(() => {
    if (this.serving()) {
      return false;
    }
    const gpu = this.gpu();
    return gpu !== undefined && gpu.freeMiB < this.hardware().budgetMiB;
  });
}
