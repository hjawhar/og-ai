import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { HardwarePanelComponent } from './components/hardware-panel/hardware-panel.component';
import { InstalledModelsComponent } from './components/installed-models/installed-models.component';
import { ModelHubComponent } from './components/model-hub/model-hub.component';
import { ServerLogComponent } from './components/server-log/server-log.component';
import { ServerStatusComponent } from './components/server-status/server-status.component';
import { MibPipe } from './pipes/mib.pipe';
import { ModelStateService } from './services/model-state.service';
import type { ServeRequest } from './models/state.model';

/**
 * One screen: what this machine is, what weights it has, what it can fetch from Hugging Face,
 * and which of them will actually run well here. The children that render the snapshot are
 * presentational; the service owns the poll, the actions and the only copy of server state.
 * The Hub browser is the one child with state of its own, because which preset is on screen and
 * what is half-typed in its box are nobody else's business.
 */
@Component({
  selector: 'og-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  imports: [
    HardwarePanelComponent,
    InstalledModelsComponent,
    ModelHubComponent,
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

  readonly servingFile = computed(() => {
    const pending = this.service.pending();
    return pending?.kind === 'serve' ? pending.file : null;
  });

  readonly deletingFile = computed(() => {
    const pending = this.service.pending();
    return pending?.kind === 'delete' ? pending.file : null;
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

  deleteModel(file: string): void {
    void this.service.deleteModel(file);
  }

  stopServer(): void {
    void this.service.stopServer();
  }
}
