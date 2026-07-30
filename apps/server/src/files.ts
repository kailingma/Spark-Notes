import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Attachments.
 *
 * Uploads go to `files/` inside the space, as ordinary files with ordinary
 * names, and what Spark writes into a note is an ordinary markdown reference:
 * `![](files/scan.png)`, `[the contract](files/contract.pdf)`. That is the whole
 * design. A separate attachment store with its own ids would be a second
 * database and would break the promise that the notes still make sense if the
 * app is deleted — a relative link in a markdown file does not.
 *
 * `files/` is a normal folder, so uploads sync with git, appear in the
 * navigator, and can be deleted in Finder. The cost is that a large binary in a
 * git repo is a large binary in a git repo; the cap below is what keeps that
 * honest.
 */

export const FILES_DIR = 'files';

/** Per upload. Big enough for a scan or a slide deck, small enough to sync. */
export const MAX_UPLOAD = 20 * 1024 * 1024;

/** What may be sent to a model inline, base64, in one turn. */
const MAX_INLINE = 5 * 1024 * 1024;

export interface StoredFile {
  /** Page name, always `files/<something>`. */
  name: string;
  size: number;
  modified: number;
  mime: string;
}

/** What a file becomes when it travels to the model. */
export type FilePayload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'document'; mime: string; base64: string }
  | { kind: 'unsupported'; reason: string };

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.ts': 'text/plain',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.html': 'text/html',
  '.css': 'text/css',
  '.log': 'text/plain',
};

/** Extensions whose bytes are just text. Anything here can be read directly. */
const TEXTUAL = new Set([
  '.txt', '.md', '.csv', '.json', '.yml', '.yaml', '.ts', '.js', '.py',
  '.html', '.css', '.log', '.svg', '.tsv', '.sql', '.sh',
]);

/**
 * Images a model can look at. Deliberately not every image type: SVG is markup
 * that no vision endpoint accepts, and it reads better as text anyway.
 */
const VIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class FileStore {
  constructor(private readonly spaceRoot: string) {}

  get #dir(): string {
    return join(this.spaceRoot, FILES_DIR);
  }

  /**
   * Saves an upload under a safe, unique name.
   *
   * The name is sanitised rather than replaced by an id: `files/invoice-3.pdf`
   * is a link someone might read in a diff or type in a note, and
   * `files/a3f9c1.pdf` is not. Collisions get a numeric suffix instead of
   * overwriting, because two files called `screenshot.png` are two files.
   */
  async save(filename: string, bytes: Uint8Array): Promise<StoredFile> {
    if (bytes.byteLength > MAX_UPLOAD) {
      throw new Error(`That file is larger than ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB.`);
    }

    await mkdir(this.#dir, { recursive: true });
    const safe = await this.#uniqueName(sanitize(filename));
    await writeFile(join(this.#dir, safe), bytes);

    return {
      name: `${FILES_DIR}/${safe}`,
      size: bytes.byteLength,
      modified: Date.now(),
      mime: mimeOf(safe),
    };
  }

  async list(): Promise<StoredFile[]> {
    let entries;
    try {
      entries = await readdir(this.#dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map(async (entry) => {
          try {
            const info = await stat(join(this.#dir, entry.name));
            return {
              name: `${FILES_DIR}/${entry.name}`,
              size: info.size,
              modified: info.mtimeMs,
              mime: mimeOf(entry.name),
            } satisfies StoredFile;
          } catch {
            return null;
          }
        }),
    );

    return files
      .filter((file): file is StoredFile => file !== null)
      .sort((a, b) => b.modified - a.modified);
  }

  async bytes(name: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
    const buffer = await readFile(this.#pathFor(name));
    // A view over the same memory rather than the `Buffer` itself: a response
    // body wants a `Uint8Array<ArrayBuffer>`, and `Buffer`'s backing store is
    // `ArrayBufferLike` as far as the types are concerned. The offset matters —
    // `readFile` returns a slice of a pooled buffer, so ignoring it would hand
    // back somebody else's bytes.
    const bytes = new Uint8Array(
      buffer.buffer as ArrayBuffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    return { bytes, mime: mimeOf(name) };
  }

  /**
   * A file, in the shape a model can take it.
   *
   * Three kinds and an honest refusal, rather than a best effort at everything.
   * A PDF travels as a document block, which Anthropic reads natively; there is
   * deliberately no bundled PDF text extractor, because a bad one produces
   * plausible-looking nonsense and Spark would then quote it confidently.
   */
  async payload(name: string): Promise<FilePayload> {
    const path = this.#pathFor(name);
    const ext = extname(name).toLowerCase();
    const mime = mimeOf(name);

    let info;
    try {
      info = await stat(path);
    } catch {
      return { kind: 'unsupported', reason: `there is no file called "${name}"` };
    }

    if (TEXTUAL.has(ext)) {
      const text = await readFile(path, 'utf8');
      return {
        kind: 'text',
        text:
          text.length > 200_000
            ? `${text.slice(0, 200_000)}\n\n[truncated: the file is ${text.length} characters]`
            : text,
      };
    }

    if (info.size > MAX_INLINE) {
      return {
        kind: 'unsupported',
        reason: `"${name}" is ${Math.round(info.size / 1024 / 1024)} MB, too large to send. It is on disk and can be linked to.`,
      };
    }

    const base64 = (await readFile(path)).toString('base64');
    if (VIEWABLE.has(mime)) return { kind: 'image', mime, base64 };
    if (mime === 'application/pdf') return { kind: 'document', mime, base64 };

    return {
      kind: 'unsupported',
      reason: `"${name}" is a ${mime} file, which cannot be read as text or looked at. It is stored and can be linked to.`,
    };
  }

  #pathFor(name: string): string {
    // Only the basename is ever used, which is what makes traversal impossible
    // here: a name like `../../etc/passwd` collapses to `passwd`.
    const base = sanitize(name.replace(/^files\//i, ''));
    if (!base) throw new Error('that is not a file name');
    return join(this.#dir, base);
  }

  async #uniqueName(base: string): Promise<string> {
    const ext = extname(base);
    const stem = base.slice(0, base.length - ext.length) || 'file';

    for (let n = 0; n < 200; n++) {
      const candidate = n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
      try {
        await stat(join(this.#dir, candidate));
      } catch {
        return candidate;
      }
    }
    return `${stem}-${Date.now()}${ext}`;
  }
}

// ---------------------------------------------------------------------------

/** A filename that is safe on every filesystem and readable in a markdown link. */
export function sanitize(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+/, '')
    .slice(0, 120);
  return cleaned || `upload-${Date.now()}`;
}

export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
