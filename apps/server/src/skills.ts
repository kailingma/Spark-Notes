import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { config } from './config.js';

/**
 * Skills: procedures the person teaches Spark once.
 *
 * A skill is a folder in the space with a `SKILL.md` in it — the same shape as
 * `_plugins/`, for the same reason. It is markdown you can read, edit and sync,
 * and it survives the app.
 *
 * ```
 * _skills/
 *   weekly-review/
 *     SKILL.md          frontmatter + instructions
 *     template.md       anything else the instructions refer to
 * ```
 *
 * The load-bearing decision is **progressive disclosure**. Only each skill's
 * name, description and `when` line go into the system prompt; the instructions
 * are fetched by a tool when a skill is actually chosen. That is what makes the
 * feature scale: twenty skills cost twenty lines of context rather than twenty
 * documents, so there is no pressure to keep the folder small, and a skill can be
 * as long as the procedure really is.
 *
 * Frontmatter is parsed as plain `key: value` lines rather than with a YAML
 * dependency. A skill file is written by a person or by Spark, both of which can
 * manage four flat keys, and the failure mode of a real YAML parser here would be
 * a skill that silently stops loading because of an indent.
 */

export interface SkillMeta {
  /** Folder name — how a skill is referred to everywhere. */
  name: string;
  /** What it does. This is what the model sees. */
  description: string;
  /** When to reach for it. Optional, but it is what makes the choice good. */
  when?: string;
}

export interface Skill extends SkillMeta {
  /** The instructions. Only loaded on demand. */
  body: string;
  /** Other files in the skill's folder, as page names. */
  files: string[];
}

/** Where skills live, relative to the space. */
export const SKILLS_DIR = '_skills';

const MAX_SKILLS = 60;
const MAX_BODY = 40_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;

export class SkillStore {
  constructor(private readonly spaceRoot: string) {}

  get #dir(): string {
    return join(this.spaceRoot, SKILLS_DIR);
  }

  #dirFor(name: string): string {
    if (!NAME_RE.test(name)) {
      throw new Error(
        `"${name}" is not a valid skill name. Use lowercase letters, numbers and hyphens.`,
      );
    }
    return join(this.#dir, name);
  }

  /** Every skill's metadata, without its instructions. */
  async list(): Promise<SkillMeta[]> {
    let entries;
    try {
      entries = await readdir(this.#dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && NAME_RE.test(entry.name))
        .slice(0, MAX_SKILLS)
        .map(async (entry): Promise<SkillMeta | null> => {
          try {
            const raw = await readFile(join(this.#dir, entry.name, 'SKILL.md'), 'utf8');
            const { front } = splitFrontmatter(raw);
            return {
              name: entry.name,
              description: front.description ?? '(no description)',
              when: front.when,
            };
          } catch {
            // A folder without a readable SKILL.md is not a skill. Skipping it
            // silently is right: the folder may be half-written.
            return null;
          }
        }),
    );

    return skills
      .filter((skill): skill is SkillMeta => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<Skill> {
    const dir = this.#dirFor(name);
    let raw: string;
    try {
      raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
    } catch {
      throw new Error(`There is no skill called "${name}". Use list_skills to see what there is.`);
    }

    const { front, body } = splitFrontmatter(raw);
    let files: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      files = entries
        .filter((entry) => entry.isFile() && entry.name !== 'SKILL.md')
        .map((entry) => entry.name)
        .sort();
    } catch {
      /* just the one file */
    }

    return {
      name,
      description: front.description ?? '(no description)',
      when: front.when,
      body: body.slice(0, MAX_BODY),
      files,
    };
  }

  /**
   * Reads a file that belongs to a skill.
   *
   * Its own reader rather than going through the space, because a skill may
   * legitimately carry a `.py` or a `.sql` and the space only serves markdown
   * and a short list of verbatim extensions. Containment is checked after
   * resolution, the same rule `pathFor` follows.
   */
  async readFile(name: string, file: string): Promise<string> {
    const dir = this.#dirFor(name);
    const full = resolve(dir, file);
    const rel = relative(dir, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('that path is outside the skill.');
    }
    try {
      return (await readFile(full, 'utf8')).slice(0, MAX_BODY);
    } catch {
      throw new Error(`"${file}" is not a file in the "${name}" skill.`);
    }
  }

  /**
   * Writes a skill, which is how Spark gets better at things.
   *
   * The person tells Spark how they want something done, Spark writes it down
   * here, and every later conversation starts already knowing. That is the same
   * loop as memory, one level up: a convention is a rule, a skill is a
   * procedure, and a procedure is too long to sit in the prompt forever.
   */
  async write(
    name: string,
    skill: { description: string; when?: string; body: string },
  ): Promise<{ page: string }> {
    const dir = this.#dirFor(name);
    await mkdir(dir, { recursive: true });

    const front = [
      '---',
      `name: ${oneLine(name)}`,
      `description: ${oneLine(skill.description)}`,
      ...(skill.when ? [`when: ${oneLine(skill.when)}`] : []),
      '---',
      '',
    ].join('\n');

    const body = skill.body.trim().slice(0, MAX_BODY);
    await writeFile(join(dir, 'SKILL.md'), `${front}${body}\n`, 'utf8');
    return { page: `${SKILLS_DIR}/${name}/SKILL` };
  }

  /**
   * The catalogue, as the system prompt carries it.
   *
   * Three lines each at most. If this ever grows past a screen, the answer is a
   * `find_skill` tool rather than a longer prompt.
   */
  describe(skills: SkillMeta[]): string | null {
    if (skills.length === 0) return null;

    const lines = skills.map((skill) => {
      const when = skill.when ? ` Use it when ${lowerFirst(skill.when)}` : '';
      return `- **${skill.name}** — ${skill.description}${when}`;
    });

    return [
      '## Skills',
      '',
      'Procedures this person has written down, or asked you to write down, for jobs they want done a particular way. You are told only what each one is for; call `read_skill` to get the instructions, and follow them over your own instincts. Reach for one whenever the job matches, without being asked to.',
      '',
      ...lines,
    ].join('\n');
  }
}

/** The single instance, over the configured space. */
export const skills = new SkillStore(config.spaceDir);

// ---------------------------------------------------------------------------

/** Splits `---\nkey: value\n---\nbody`. Absent frontmatter is not an error. */
function splitFrontmatter(raw: string): { front: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { front: {}, body: raw.trim() };

  const front: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) front[key] = value;
  }

  return { front, body: raw.slice(match[0].length).trim() };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
