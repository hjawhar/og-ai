import { ChangeDetectionStrategy, Component, effect, ElementRef, input, viewChild } from '@angular/core';

/**
 * The launched process's own output, verbatim. There is no supervisor here to
 * interpret llama.cpp's log, so the log is what an operator reads when a launch
 * takes longer than expected — which for a 16 GiB file is normal.
 */
@Component({
  selector: 'og-server-log',
  templateUrl: './server-log.component.html',
  styleUrls: ['./server-log.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ServerLogComponent {
  readonly lines = input.required<readonly string[]>();

  private readonly pane = viewChild<ElementRef<HTMLPreElement>>('pane');

  constructor() {
    // Newest last, so the useful end is the bottom one.
    effect(() => {
      this.lines();
      const element = this.pane()?.nativeElement;
      if (element !== undefined) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }
}
