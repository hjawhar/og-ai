import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { ServerState } from '../../models/state.model';

/**
 * Is something serving, what is it serving, and how does a client reach it. The
 * dot is deliberately the only "is it alive" indicator on the page — two would
 * eventually disagree.
 */
@Component({
  selector: 'og-server-status',
  templateUrl: './server-status.component.html',
  styleUrls: ['./server-status.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerStatusComponent {
  readonly server = input.required<ServerState>();
  readonly stopping = input(false);

  readonly stopRequested = output<void>();

  readonly served = computed(() => this.server().models[0]);

  /**
   * Ready means it named a model, not merely that the port answered: llama.cpp
   * binds and returns 503 while it loads, and a green dot over a server that
   * cannot answer a request yet is the kind of lie this page exists to avoid.
   */
  readonly ready = computed(() => this.server().reachable && this.served() !== undefined);

  /** The exact command a client needs; copyable because it is meant to be pasted. */
  readonly clientHint = computed(() => {
    const server = this.server();
    const id = this.served()?.id;
    return id === undefined
      ? `og --endpoint ${server.url} -m <model>`
      : `og --endpoint ${server.url} -m ${id}`;
  });

  async copyHint(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.clientHint());
    } catch {
      // Clipboard permission denied: the text is on screen and selectable anyway.
    }
  }
}
