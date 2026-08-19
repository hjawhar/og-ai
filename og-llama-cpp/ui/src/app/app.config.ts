import { provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import type { ApplicationConfig } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';

/**
 * There is one screen and no routing: the page is a live view of one machine.
 * Zoneless change detection is the default posture for a signal-only app — the
 * polling service is the only thing that changes state, and it does so through
 * signals.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch()),
  ],
};
