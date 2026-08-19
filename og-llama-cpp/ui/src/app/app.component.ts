import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { HardwarePanelComponent } from './components/hardware-panel/hardware-panel.component';
import { InstalledModelsComponent } from './components/installed-models/installed-models.component';
import { ModelCatalogComponent } from './components/model-catalog/model-catalog.component';
import { ServerLogComponent } from './components/server-log/server-log.component';
import { ServerStatusComponent } from './components/server-status/server-status.component';
import { MibPipe } from './pipes/mib.pipe';
import { ModelStateService } from './services/model-state.service';
import type { ServeRequest } from './models/state.model';

/**
 * One screen: what this machine is, what weights it has, what it can fetch, and
 * which of them will actually run well here. Every child is presentational — the
 * service owns the poll, the actions and the only copy of server state.
 */
@Component({
  selector: 'og-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [
    HardwarePanelComponent,
    InstalledModelsComponent,
    ModelCatalogComponent,
    ServerLogComponent,
    ServerStatusComponent,
    MibPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private readonly service = inject(ModelStateService);

  readonly state = this.service.state;
  readonly error = this.service.error;
  readonly ctx = this.service.ctx;

  /** Which catalogue row is mid-action, so exactly one control reads as working. */
  readonly busyKey = computed(() => {
    const pending = this.service.pending();
    return pending?.kind === 'download' || pending?.kind === 'cancel' ? pending.key : null;
  });

  readonly servingFile = computed(() => {
    const pending = this.service.pending();
    return pending?.kind === 'serve' ? pending.file : null;
  });

  readonly stopping = computed(() => this.service.pending()?.kind === 'stop');

  serve(request: ServeRequest): void {
    void this.service.serve(request);
    // The context the operator launched with becomes the one every verdict is
    // computed for: a page that disagrees with the running server is worse than
    // no page.
    if (request.ctx !== undefined) {
      this.service.setCtx(request.ctx);
    }
  }

  download(key: string): void {
    void this.service.download(key);
  }

  cancelDownload(key: string): void {
    void this.service.cancelDownload(key);
  }

  stopServer(): void {
    void this.service.stopServer();
  }
}
