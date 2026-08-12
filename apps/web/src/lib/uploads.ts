import { filesApi, type StoredFile } from './spark-client';

/**
 * Putting a file into the space.
 *
 * One function, because until now uploading was something only the Spark chat
 * could do — it had the picker, the progress count and the error handling, and
 * nothing else in the app could attach a file at all. The behaviour is worth
 * exactly one implementation: choose, upload to `files/`, and hand back
 * markdown links, because a file in a notes app that nothing links to is a file
 * you will never find again.
 *
 * What lands on disk is an ordinary file with an ordinary name and what goes in
 * the note is an ordinary relative link — see AGENTS → Attachments for why
 * there is no attachment store with ids of its own.
 */

export interface UploadOutcome {
  stored: StoredFile[];
  /** Kept rather than swallowed: a failed upload has to be sayable. */
  failed: Array<{ name: string; reason: string }>;
}

/** Mirrors the server's own cap — see `MAX_UPLOAD` in `apps/server/src/files.ts`. Kept in sync by hand: it changes about as often as never. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Mirrors `MAX_ATTACHMENT_BYTES` in `apps/server/src/spark.ts` — the total a single turn's attachments may add up to. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** One upload in flight — a name to show, and a way to cancel just this one. */
export interface UploadHandle {
  id: string;
  name: string;
  cancel: () => void;
}

/**
 * The system file picker.
 *
 * Resolves with an empty list when it is dismissed. `cancel` covers the modern
 * browsers; the focus fallback is there because without it a dismissed picker
 * leaves a promise nothing ever settles, and the caller's "uploading…" state
 * with it.
 */
export function chooseFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple ?? true;
    if (options.accept) input.accept = options.accept;
    // Off screen rather than `display: none`: Safari has historically refused
    // to open the picker for an input that is not rendered at all.
    input.className = 'visually-hidden';

    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(files);
    };

    const onFocus = () => {
      // The picker is modal to the tab, so focus coming back means it is gone.
      // A frame of slack, because `change` fires after `focus` on some builds.
      window.setTimeout(() => finish([...(input.files ?? [])]), 300);
    };

    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', onFocus);

    document.body.append(input);
    input.click();
  });
}

/**
 * Uploads what was chosen, a few at a time.
 *
 * Bounded concurrency rather than one big `Promise.all`: a dozen photos
 * dropped at once would otherwise open a dozen simultaneous requests, and
 * one slow one (a phone on a bad connection) would rather be behind two
 * others than blocking all twelve. The server's own upload now creates each
 * file with an exclusive `wx` flag (see `FileStore.save`), so two uploads
 * racing to save the same name no longer risk overwriting one another —
 * that used to be the reason this ran one at a time.
 *
 * `onStart` fires just before each file's request goes out, handing back the
 * same handle `onSettle` will later receive once that file finishes (however
 * it finishes) — the caller's UI can show a row per in-flight file, let any
 * one of them be cancelled without touching the others, and remove its row
 * the moment it settles rather than waiting for the whole batch.
 */
export async function uploadFiles(
  files: File[],
  options: {
    onProgress?: (done: number, total: number) => void;
    onStart?: (handle: UploadHandle) => void;
    onSettle?: (handle: UploadHandle) => void;
    concurrency?: number;
  } = {},
): Promise<UploadOutcome> {
  const { onProgress, onStart, onSettle, concurrency = 3 } = options;
  const outcome: UploadOutcome = { stored: [], failed: [] };
  let done = 0;
  let cursor = 0;

  async function worker() {
    // Synchronous up to the first `await`, so concurrent workers never read
    // the same `cursor` value — no lock needed for a claim this cheap.
    while (cursor < files.length) {
      const file = files[cursor++];
      if (file.size > MAX_UPLOAD_BYTES) {
        outcome.failed.push({
          name: file.name,
          reason: `"${file.name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        });
        done++;
        onProgress?.(done, files.length);
        continue;
      }

      const controller = new AbortController();
      const handle: UploadHandle = { id: `${file.name}:${file.size}:${cursor}`, name: file.name, cancel: () => controller.abort() };
      onStart?.(handle);
      try {
        outcome.stored.push(await filesApi.upload(file, controller.signal));
      } catch (err) {
        outcome.failed.push({
          name: file.name,
          reason:
            err instanceof DOMException && err.name === 'AbortError'
              ? 'Cancelled.'
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
      onSettle?.(handle);
      done++;
      onProgress?.(done, files.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return outcome;
}

/** An image embeds; everything else is a link you can read the name of. */
export function markdownLinkFor(file: StoredFile): string {
  const label = file.name.replace(/^files\//, '');
  return file.mime.startsWith('image/') ? `![${label}](${file.name})` : `[${label}](${file.name})`;
}

/** What to say about a finished upload, in one line. */
export function describeUpload(outcome: UploadOutcome): { message: string; ok: boolean } {
  const { stored, failed } = outcome;
  if (failed.length === 0) {
    return {
      ok: true,
      message:
        stored.length === 1
          ? `Uploaded ${stored[0].name}.`
          : `Uploaded ${stored.length} files to files/.`,
    };
  }
  if (stored.length === 0) {
    return { ok: false, message: failed[0].reason };
  }
  return {
    ok: false,
    message: `Uploaded ${stored.length}, but ${failed.length} failed: ${failed[0].reason}`,
  };
}
