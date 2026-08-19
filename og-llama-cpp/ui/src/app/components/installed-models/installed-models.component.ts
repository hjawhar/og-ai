import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { BytesPipe } from '../../pipes/bytes.pipe';
import { VerdictBadgeComponent } from '../verdict-badge/verdict-badge.component';
import type { InstalledModel, ServeRequest } from '../../models/state.model';

/**
 * The weights on this machine, each with the verdict for the context in the row's
 * input. Serving is one action; deleting is the other, and it is the only one that
 * cannot be taken back, so it goes through a modal confirmation that names every
 * file it will unlink. The flag Serve passes comes from the verdict, so what launches
 * is exactly what the page claimed would fit; whether Delete is allowed comes from
 * `blocked`, so what the page refuses is exactly what the server refuses.
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
  /** File currently being deleted, so only its button shows as working. */
  readonly deleting = input<string | null>(null);

  readonly serveRequested = output<ServeRequest>();
  readonly deleteRequested = output<string>();

  /** Per-row context override, keyed by file. Empty means "use the default". */
  private readonly ctxByFile = signal<Record<string, number>>({});

  /** The row awaiting confirmation, and the only thing the dialog renders. Null while closed. */
  protected readonly pendingDelete = signal<InstalledModel | null>(null);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('confirmDialog');

  constructor() {
    // Open state follows the selection, not the click, and it is applied after render rather
    // than during it: the dialog's contents — including the Cancel button that has to take
    // focus — are @if'd on that selection, so showModal() has no autofocus target until they
    // exist. The write phase is named explicitly because this only writes; both calls are
    // no-ops when the dialog is already in the state asked for, and the effect is only dirty
    // when the selection or the element itself changed.
    afterRenderEffect({
      write: () => {
        const element = this.dialog()?.nativeElement;
        if (element === undefined) {
          return;
        }
        if (this.pendingDelete() === null) {
          element.close();
        } else {
          element.showModal();
        }
      },
    });
  }

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

  /**
   * The one path that deletes, reached only from the dialog's own confirm button. The row is
   * left alone afterwards: the next poll is what removes it, and a refusal the poll cannot show
   * arrives as the banner the service already sets. Closing here rather than in the template
   * keeps the emit and the close in one order.
   */
  confirmDelete(): void {
    const model = this.pendingDelete();
    if (model === null) {
      return;
    }
    this.deleteRequested.emit(model.file);
    this.dialog()?.nativeElement.close();
  }

  /** Why Serve is off, in the same words the size cell used: the two reasons are different bugs. */
  titleFor(model: InstalledModel): string {
    const incomplete = model.incomplete;
    if (incomplete === undefined) {
      return 'Launch through serve.ts';
    }
    return incomplete.reason === 'downloading'
      ? 'Still downloading: a .part file sits beside it'
      : 'Truncated: the file is shorter than its own tensor table needs';
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
