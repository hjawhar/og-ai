import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import { BytesPipe } from '../../pipes/bytes.pipe';
import { VerdictBadgeComponent } from '../verdict-badge/verdict-badge.component';
import type { InstalledModel, ServeRequest } from '../../models/state.model';

/**
 * The weights on this machine, each with the verdict for the context in the row's
 * input. Serving is the one action; the flag it will pass comes from the verdict,
 * so what launches is exactly what the page claimed would fit.
 */
@Component({
  selector: 'og-installed-models',
  templateUrl: './installed-models.component.html',
  styleUrls: ['./installed-models.component.scss'],
  imports: [BytesPipe, VerdictBadgeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstalledModelsComponent {
  readonly models = input.required<readonly InstalledModel[]>();
  readonly modelsDir = input.required<string>();
  readonly defaultCtx = input.required<number>();
  /** File currently being launched, so only its button shows as working. */
  readonly serving = input<string | null>(null);

  readonly serveRequested = output<ServeRequest>();

  /** Per-row context override, keyed by file. Empty means "use the default". */
  private readonly ctxByFile = signal<Record<string, number>>({});

  ctxFor(model: InstalledModel): number {
    return this.ctxByFile()[model.file] ?? this.defaultCtx();
  }

  setCtx(model: InstalledModel, raw: string): void {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value) || value < 512) {
      return;
    }
    this.ctxByFile.update((current) => ({ ...current, [model.file]: value }));
  }

  serve(model: InstalledModel): void {
    const suggestion = model.fit.suggestion;
    // Always explicit: an unset --n-cpu-moe would inherit serve.ts's default
    // profile split, which has nothing to do with this file.
    const ncmoe = suggestion?.startsWith('--n-cpu-moe') ? Number.parseInt(suggestion.split(' ')[1] ?? '0', 10) : 0;
    this.serveRequested.emit({
      file: model.file,
      ctx: this.ctxFor(model),
      ncmoe: Number.isFinite(ncmoe) ? ncmoe : 0,
      alias: model.file.replace(/\.gguf$/i, ''),
    });
  }

  chipsFor(model: InstalledModel): string[] {
    const chips: string[] = [];
    if (model.arch !== undefined) chips.push(model.arch);
    if (model.layers !== undefined) chips.push(`${model.layers} layers`);
    if (model.experts !== undefined) chips.push(`${model.experts} experts`);
    if (model.trainedContext !== undefined) chips.push(`trained ctx ${model.trainedContext}`);
    return chips;
  }
}
