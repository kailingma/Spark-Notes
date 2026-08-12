import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
 * **The runtime is chosen in the environment, not in Settings.** Whether this
 * machine will execute generated code is a property of the machine. What is *in*
 * Settings is the person's permission (`sparkCanRun`, off until asked for), so
 * there are two gates and this file only ever describes the outer one.
 *
 * Five runtimes, and the differences between them are real:
 *
 * | `SPARK_SANDBOX` | What it actually isolates |
 * | --- | --- |
 * | `auto` | **the default.** Docker if the daemon answers at boot, otherwise the local interpreter. Resolved once, so the description never disagrees with what will run. |
 * | `off` | the tool does not exist |
 * | `docker` | no network, a memory and process cap, and the only host path in the container is the work directory. **This is the one to use.** |
 * | `python`, `node` | a subprocess with a scrubbed environment, a timeout and a working directory — and **nothing else**. It can read every file the server can, including your whole space, and it can reach the network. |
 * | anything else | treated as a command template; see `commandFor` |
 *
 * Be precise about that fourth row, because it is the one that is easy to
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
 * ## The place to work
 *
 * A run gets `.spark/workspace/` — one directory, outside the space, that
 * **survives between runs**. That is the difference between a calculator and
 * somewhere to work: a script can write an intermediate file and the next one can
 * read it, which is how any multi-step job actually goes. It is outside the space
 * because scratch work is not notes — three attempts at a chart do not belong in
 * the page list, in search or in git — and it is listable and readable through
 * tools, so Spark can see what it left there rather than guessing.
 *
 * Set `SPARK_SANDBOX_PERSIST=false` to go back to a fresh temporary directory per
 * run. What deliberately crosses the boundary is still small: files go in only
 * when the caller names them, and what comes back is stdout, stderr, and whatever
 * was written to `out/`.
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

/**
 * What `auto` resolved to, and when.
 *
 * Probing per call would mean `describeSandbox()` and the run itself could
 * disagree — the prompt promising a container and a subprocess doing the work —
 * and a `docker info` on every tool call is a second of latency for an answer
 * that usually does not change while the server is up. So it's still cached,
 * just not forever: a daemon that dies mid-session (a laptop put to sleep with
 * Docker Desktop, a `dockerd` restart) used to leave every later run failing
 * with a generic "could not start docker" for the rest of the process's life.
 * `AUTO_PROBE_TTL_MS` bounds how long that can last, and `invalidateAutoProbe`
 * (called from `runCode` when a docker run's own failure looks like the
 * daemon, not the script) recovers sooner than that when the failure itself
 * already told us.
 */
let resolvedAuto: SandboxRuntime | null = null;
let resolvedAutoAt = 0;
const AUTO_PROBE_TTL_MS = 60_000;

export function sandboxRuntime(): SandboxRuntime {
  const raw = config.sandbox.runtime.trim().toLowerCase();
  if (raw === 'auto' || raw === 'true' || raw === '1') {
    if (resolvedAuto === null || Date.now() - resolvedAutoAt > AUTO_PROBE_TTL_MS) {
      resolvedAuto = dockerAvailable() ? 'docker' : 'node';
      resolvedAutoAt = Date.now();
    }
    return resolvedAuto;
  }
  if (!raw || raw === 'off' || raw === 'false' || raw === '0') return 'off';
  if (raw === 'docker') return 'docker';
  if (raw === 'python' || raw === 'python3') return 'python';
  if (raw === 'node') return 'node';
  return 'command';
}

/** Forces the next `sandboxRuntime()` call to re-probe instead of trusting the TTL. */
function invalidateAutoProbe(): void {
  resolvedAuto = null;
}

/** Docker CLI's own wording for "the daemon isn't answering" — stable across versions. */
function looksLikeDaemonUnreachable(text: string): boolean {
  return /cannot connect to the docker daemon|is the docker daemon running|could not start "docker"/i.test(text);
}

export const sandboxEnabled = (): boolean => sandboxRuntime() !== 'off';

/**
 * Whether there is a Docker daemon to talk to.
 *
 * `docker info` rather than `--version`: the binary being installed says nothing
 * about the daemon being up, and a container that fails to start is a failed tool
 * call in the middle of someone's question rather than a fallback at boot.
 * Synchronous because this runs once, before anything is being awaited.
 */
function dockerAvailable(): boolean {
  try {
    const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 4000,
    });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * How the runtime should be described, to the person and to the model.
 *
 * The local case says what it does *not* protect, in the sentence a person reads
 * before turning it on. A sandbox that oversells itself is worse than no sandbox,
 * because it is the description people act on.
 */
export function describeSandbox(): string {
  const runtime = sandboxRuntime();
  const where = config.sandbox.persist
    ? ` The working directory is kept between runs, so a file written now is still there next time.`
    : '';
  switch (runtime) {
    case 'off':
      return 'Code execution is off.';
    case 'docker':
      return `Docker (${config.sandbox.image || 'an official base image'}), no network, 512 MB, nothing of yours mounted but the working directory.${where}`;
    case 'command':
      return `A command of your own: ${config.sandbox.runtime}${where}`;
    default:
      return `${LOCAL_BIN[runtime === 'python' ? 'python' : 'javascript']} as a plain subprocess on this machine. The API key is kept out of its environment and it is killed after ${Math.round(config.sandbox.timeoutMs / 1000)}s, but it can read any file the server can and it can reach the network. Use Docker if that matters.${where}`;
  }
}

/** The agent's directory, as a path. Created on first use, not at boot. */
export const workDir = (): string => config.sandbox.workDir;

/**
 * What is in the agent's directory.
 *
 * Offered as its own function because a persistent directory nobody can see the
 * contents of is worse than a temporary one: the model writes a file, forgets the
 * name, and spends three rounds guessing. Depth is capped rather than walked
 * fully — a script that generates a deep tree is a script whose listing nobody
 * wanted to read.
 */
export async function listWorkDir(limit = 200): Promise<Array<{ name: string; size: number; modified: number }>> {
  const root = workDir();
  const out: Array<{ name: string; size: number; modified: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const info = await stat(full);
          out.push({
            name: relative(root, full).split(/[\\/]/).join('/'),
            size: info.size,
            modified: info.mtimeMs,
          });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  };

  await walk(root, 0);
  return out.sort((a, b) => b.modified - a.modified);
}

/** Reads one file out of the agent's directory, refusing anything outside it. */
export async function readWorkFile(name: string, limit = 60_000): Promise<string> {
  const root = workDir();
  const full = resolve(root, name);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error('that path is outside the working directory.');
  }
  const text = await readFile(full, 'utf8');
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated: ${text.length} characters]` : text;
}

/**
 * Runs one script.
 *
 * Every path in and out of the sandbox goes through this function, so there is
 * one place to read to know what the boundary is. The directory is the persistent
 * one by default — see the header — and a fresh temporary one when
 * `SPARK_SANDBOX_PERSIST=false`, in which case it is deleted afterwards.
 */
export async function runCode(request: SandboxRequest): Promise<SandboxResult> {
  const runtime = sandboxRuntime();
  if (runtime === 'off') {
    throw new Error('Code execution is switched off on this server.');
  }

  const persistent = config.sandbox.persist;
  const dir = persistent ? workDir() : await mkdtemp(join(tmpdir(), 'spark-sandbox-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ENTRY[request.language]), request.code, 'utf8');
    // Emptied rather than merely created: `out/` is how a run hands files back,
    // and leaving last run's output in it would re-save the same attachment every
    // time a script that writes nothing is run.
    await rm(join(dir, 'out'), { recursive: true, force: true });
    await mkdir(join(dir, 'out'), { recursive: true });

    for (const file of request.files ?? []) {
      // The *path* is kept, not just the basename. A file named `files/hours.csv`
      // has to be openable as `files/hours.csv`, because that is the only name
      // the model has ever seen for it — flattening to the basename made every
      // first attempt fail on a file that was sitting right there. `safeRelative`
      // is what makes keeping the path safe.
      const target = join(dir, safeRelative(file.name));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);
    }

    // Named per run so a timeout can `docker kill` the container itself, not
    // just the CLI wrapper process — see `execute`.
    const containerName = `spark-run-${randomUUID()}`;
    const { command, args } = commandFor(runtime, request.language, dir, containerName);
    const outcome = await execute(command, args, dir, runtime === 'docker' ? containerName : undefined);

    if (runtime === 'docker' && !outcome.ok && looksLikeDaemonUnreachable(outcome.stderr)) {
      // The failure already told us the daemon is the problem, not the script —
      // no reason to make the next run wait out the rest of the TTL to find out.
      invalidateAutoProbe();
    }

    return { ...outcome, produced: await collect(join(dir, 'out')) };
  } finally {
    if (!persistent) await rm(dir, { recursive: true, force: true });
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
  containerName?: string,
): { command: string; args: string[] } {
  const entry = ENTRY[language];

  if (runtime === 'docker') {
    return {
      command: 'docker',
      args: [
        'run', '--rm',
        ...(containerName ? ['--name', containerName] : []),
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
  /** Set only for the docker runtime — see the timeout handler below. */
  containerName?: string,
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
      // `docker run` is a client talking to a daemon; killing this process
      // kills the client, not the container running under the daemon, so
      // `--rm` never gets a chance to fire and the container would otherwise
      // keep running as an orphan indefinitely. Best-effort and
      // fire-and-forget — the run is already being reported as timed out
      // either way, and a failed `docker kill` here just means the container
      // outlives the request, not that the request hangs.
      if (containerName) {
        spawn('docker', ['kill', containerName], { stdio: 'ignore' }).on('error', () => {});
      }
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

/**
 * A name turned into a path that cannot leave the working directory.
 *
 * Every segment is sanitised and `.`, `..` and empty segments are dropped, so
 * `../../etc/passwd` becomes `etc/passwd` — inside the sandbox, where it means
 * nothing. This is what lets the path be preserved rather than flattened.
 */
function safeRelative(name: string): string {
  const parts = name
    .split(/[/\\]/)
    .map((part) => part.replace(/[^\w.\- ]+/g, '-').trim())
    .filter((part) => part && part !== '.' && part !== '..');
  // Six levels is more than any real page name and stops a pathological one from
  // creating a deep tree in the temp directory.
  return parts.slice(0, 6).join('/') || 'input';
}
