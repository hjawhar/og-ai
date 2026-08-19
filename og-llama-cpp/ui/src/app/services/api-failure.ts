import { HttpErrorResponse } from '@angular/common/http';

/**
 * One sentence for a failed call, shared by every service that talks to `ui/server`.
 *
 * The API answers failures as plain text or as `{ error }`, and the browser turns an unreachable
 * port into a status of 0 with nothing else to say. Both banners on the page — the polled snapshot
 * and the Hub explorer — must read the same way, so the translation lives here rather than being
 * half-reimplemented next to each caller.
 */
export function describeFailure(cause: unknown): string {
  if (cause instanceof HttpErrorResponse) {
    // status 0 is the browser refusing to say more: the API is down or the port moved.
    if (cause.status === 0) {
      return 'Cannot reach the model API. Is `bun run ui` still running on 127.0.0.1:8130?';
    }
    const detail = messageFromBody(cause.error);
    return detail === null
      ? `${cause.status} ${cause.statusText} from ${cause.url ?? 'the API'}`
      : `${cause.status} ${cause.statusText}: ${detail}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function messageFromBody(body: unknown): string | null {
  if (typeof body === 'string' && body.trim() !== '') {
    return body.trim();
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: unknown };
    if (typeof error === 'string' && error.trim() !== '') {
      return error.trim();
    }
  }
  return null;
}
