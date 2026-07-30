import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Running code Spark wrote.
 *
 * The reason this exists in a notes app is narrow and worth stating, because it
 * decides the whole shape: some questions about a folder of markdown are
 * arithmetic, not reading. How many hours did I log this month, what does the
 * spend column add up to, turn this CSV into a table, chart the weight column.
 * A model that answers those by reasoning over text gets them subtly wrong; a
 * model that writes six lines of Python gets them right, and you can read the
 * six lines.
 *
 * **It is off by default and switched on in the environment, not in Settings.**
 * Whether this machine will execute generated code is a property of the machine.
 *
 * Four runtimes, and the differences between them are real:
 *
 * | `SPARK_SANDBOX` | What it actually isolates |
 * | --- | --- |
 * | `off` | the tool does not exist |
 * | `docker` | no network, a memory and process cap, and the only host path in the container is the work directory. **This is the one to use.** |
 * | `python`, `node` | a subprocess with a scrubbed environment, a timeout and a temp working directory — and **nothing else**. It can read every file the server can, including your whole space, and it can reach the network. |
 * | anything else | treated as a command template; see `commandFor` |
 *
 * Be precise about that third row, because it is the one that is easy to
 * misdescribe: a local subprocess is a *convenience*, not a boundary. It stops a
 * script from stumbling into the API key and from running forever. It does not
 * stop a script that means harm. It is offered because a personal server on a
 * laptop with no Docker is a real situation, and it says exactly this in the
 * settings panel and in the system prompt, so nobody switches it on believing
 * otherwise.
 *
 * The command template is the escape hatch, and it is why there is no vendor SDK
 * here: pointing this at E2B, Firecracker or a remote runner is a string in the
 * environment rather than a dependency and a rewrite.
 *
 * What deliberately crosses the boundary is small: files go in only when the
 * caller names them, and what comes back is stdout, stderr, and whatever was
 * written to `out/`.
 */

export type Language = 'python' | 'javascript';

export interface SandboxRequest {
  language: Language;
  code: string;
  /** Files to place in the working directory, by name. */
  files?: Array<{ name: string; bytes: Uint8Array }>;
}

export interface SandboxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Files the script wrote to `out/`. */
  produced: Array<{ name: string; bytes: Uint8Array }>;
  /** Set when the run was killed rather than finishing. */
  timedOut?: boolean;
}

/** Per stream. Enough to read, small enough not to fill a context window. */
const MAX_OUTPUT = 24_000;

/** Files a script may hand back, and how big each may be. */
const MAX_PRODUCED = 8;
const MAX_PRODUCED_BYTES = 4 * 1024 * 1024;

const ENTRY: Record<Language, string> = { python: 'main.py', javascript: 'main.js' };
const LOCAL_BIN: Record<Language, string> = { python: 'python3', javascript: 'node' };
const IMAGE: Record<Language, string> = {
  python: 'python:3.12-alpine',
  javascript: 'node:22-alpine',
};

export type SandboxRuntime = 'off' | 'docker' | 'python' | 'node' | 'command';

export function sandboxRuntime(): SandboxRuntime {
  const raw = config.sandbox.runtime.trim().toLowerCase();
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'docker') return 'docker';
  if (raw === 'python' || raw === 'python3') return 'python';
  if (raw === 'node') return 'node';
  return 'command';
}

export const sandboxEnabled = (): boolean => sandboxRuntime() !== 'off';

/**
 * How the runtime should be described, to the person and to the model.
 *
 * The local case says what it does *not* protect, in the sentence a person reads
 * before turning it on. A sandbox that oversells itself is worse than no sandbox,
 * because it is the description people act on.
 */
export function describeSandbox(): string {
  const runtime = sandboxRuntime();
  switch (runtime) {
    case 'off':
      return 'Code execution is off.';
    case 'docker':
      return `Docker (${config.sandbox.image || 'an official base image'}), no network, 512 MB, nothing of yours mounted but the working directory.`;
    case 'command':
      return `A command of your own: ${config.sandbox.runtime}`;
    default:
      return `${LOCAL_BIN[runtime === 'python' ? 'python' : 'javascript']} as a plain subprocess on this machine. The API key is kept out of its environment and it is killed after ${Math.round(config.sandbox.timeoutMs / 1000)}s, but it can read any file the server can and it can reach the network. Use Docker if that matters.`;
  }
}

/**
 * Runs one script in a fresh directory that is deleted afterwards.
 *
 * Every path in and out of the sandbox goes through this function, so there is
 * one place to read to know what the boundary is.
 */
export async function runCode(request: SandboxRequest): Promise<SandboxResult> {
  const runtime = sandboxRuntime();
  if (runtime === 'off') {
    throw new Error('Code execution is switched off on this server.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'spark-sandbox-'));
  try {
    await writeFile(join(dir, ENTRY[request.language]), request.code, 'utf8');
    await mkdir(join(dir, 'out'), { recursive: true });

    for (const file of request.files ?? []) {
      // Only the basename: a script asking for `../../secrets` gets `secrets`.
      const base = file.name.split(/[/\\]/).pop() || 'input';
      await writeFile(join(dir, base), file.bytes);
    }

    const { command, args } = commandFor(runtime, request.language, dir);
    const outcome = await execute(command, args, dir);

    return { ...outcome, produced: await collect(join(dir, 'out')) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The command line for each runtime.
 *
 * `--network none` is the flag that matters: without it a container is a fine
 * place to exfiltrate a file from. The rest are limits rather than boundaries.
 */
function commandFor(
  runtime: SandboxRuntime,
  language: Language,
  dir: string,
): { command: string; args: string[] } {
  const entry = ENTRY[language];

  if (runtime === 'docker') {
    return {
      command: 'docker',
      args: [
        'run', '--rm',
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--pids-limit', '128',
        // Not `--read-only`: a script legitimately writes to `out/`, and a
        // temp-file-writing library that fails on a read-only root produces a
        // confusing error rather than a safer run.
        '--volume', `${dir}:/work`,
        '--workdir', '/work',
        config.sandbox.image.trim() || IMAGE[language],
        language === 'python' ? 'python' : 'node',
        entry,
      ],
    };
  }

  if (runtime === 'command') {
    // A template, split on spaces, with `{file}` and `{dir}` filled in. Space
    // splitting means a path with a space in it will not work, which is a real
    // limitation and a fair trade for not shipping a shell parser — and the
    // directory this substitutes is one we made, under the system temp dir.
    const parts = config.sandbox.runtime
      .trim()
      .split(/\s+/)
      .map((part) => part.replace('{file}', entry).replace('{dir}', dir).replace('{lang}', language));
    return { command: parts[0], args: parts.slice(1) };
  }

  return { command: LOCAL_BIN[language], args: [entry] };
}

function execute(
  command: string,
  args: string[],
  cwd: string,
): Promise<Omit<SandboxResult, 'produced'>> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      // A scrubbed environment, not the server's. The server's holds the API key.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1000, config.sandbox.timeoutMs));

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
    });

    const finish = (ok: boolean, extra = '') => {
      clearTimeout(timer);
      resolve({
        ok,
        stdout: cap(stdout),
        stderr: cap(stderr + extra),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };

    child.on('error', (err) =>
      // The usual cause is the runtime not being installed, which is a setup
      // problem and reads nothing like a failing script, so it says so.
      finish(false, `\nCould not start "${command}": ${err.message}`),
    );
    child.on('close', (code) =>
      finish(!timedOut && code === 0, timedOut ? `\nKilled after ${config.sandbox.timeoutMs} ms.` : ''),
    );
  });
}

async function collect(dir: string): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const produced: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const entry of entries.slice(0, MAX_PRODUCED)) {
    if (!entry.isFile()) continue;
    try {
      const bytes = await readFile(join(dir, entry.name));
      if (bytes.byteLength <= MAX_PRODUCED_BYTES) produced.push({ name: entry.name, bytes });
    } catch {
      /* vanished, or unreadable */
    }
  }
  return produced;
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n[truncated: ${text.length} characters of output]`
    : text;
}
