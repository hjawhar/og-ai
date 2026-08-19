import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { Fit } from '../../models/state.model';

/**
 * The verdict is the most important thing on the page: green means launch it,
 * amber means launch it with the flag shown underneath, red means this card will
 * page weights to host RAM and run ~8x slower.
 */
@Component({
  selector: 'og-verdict-badge',
  templateUrl: './verdict-badge.component.html',
  styleUrls: ['./verdict-badge.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VerdictBadgeComponent {
  readonly fit = input.required<Fit>();

  /** Amber and red are load-bearing here, so the mapping lives in one place. */
  readonly tone = computed<'fits' | 'flagged' | 'bad' | 'unknown'>(() => {
    switch (this.fit().verdict) {
      case 'gpu':
        return 'fits';
      case 'offload':
      case 'partial':
        return 'flagged';
      case 'cpu':
      case 'no':
        return 'bad';
      default:
        return 'unknown';
    }
  });

  /** A measured row beats arithmetic, and the badge says which one you are reading. */
  readonly isMeasured = computed(() => this.fit().label.includes('measured'));
}
