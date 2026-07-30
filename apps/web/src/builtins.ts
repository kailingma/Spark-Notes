import { definePlugin, type PluginDefinition, type SparkApi } from '@spark/plugin-sdk';
import { fontsPlugin } from './fonts';
import { themesPlugin } from './themes';

/**
 * Built-in plugins.
 *
 * These use exactly the same `SparkApi` a third-party plugin gets — no
 * privileged internals. If something here is possible, it's possible in a file
 * you drop into `_plugins/`, which is the only way to know the plugin surface
 * is actually good enough.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Markdown snippets and structural edits. `|` marks the resting cursor. */
const markdownPlugin = definePlugin({
  id: 'core.markdown',
  name: 'Markdown essentials',
  description: 'Slash commands and structural editing for markdown.',

  activate(spark: SparkApi) {
    const snippets: Array<[string, string, string]> = [
      ['task', 'Checkbox task', '- [ ] |'],
      ['todo', 'Checkbox task', '- [ ] |'],
      ['code', 'Fenced code block', '```|\n\n```'],
      ['quote', 'Blockquote', '> |'],
      ['divider', 'Horizontal rule', '\n---\n\n|'],
      ['table', 'Table', '| | |\n|---|---|\n| | |\n\n|'],
      ['link', 'Link', '[|]()'],
      ['h1', 'Heading 1', '# |'],
      ['h2', 'Heading 2', '## |'],
      ['h3', 'Heading 3', '### |'],
    ];

    for (const [name, description, snippet] of snippets) {
      spark.slash.register({ name, description, snippet });
    }

    spark.slash.register({
      name: 'date',
      description: "Today's date",
      run: (editor) => editor.replaceSelection(isoDate()),
    });
    spark.slash.register({
      name: 'time',
      description: 'Current time',
      run: (editor) => editor.replaceSelection(clockTime()),
    });
    spark.slash.register({
      name: 'now',
      description: 'Date and time',
      run: (editor) => editor.replaceSelection(`${isoDate()} ${clockTime()}`),
    });

    spark.commands.register({
      id: 'markdown.bold',
      name: 'Bold',
      category: 'Format',
      run: () => spark.editor.toggleWrap('**'),
    });
    spark.commands.register({
      id: 'markdown.italic',
      name: 'Italic',
      category: 'Format',
      run: () => spark.editor.toggleWrap('*'),
    });
    spark.commands.register({
      id: 'markdown.code',
      name: 'Inline code',
      category: 'Format',
      run: () => spark.editor.toggleWrap('`'),
    });
    spark.commands.register({
      id: 'markdown.highlight',
      name: 'Highlight',
      category: 'Format',
      run: () => spark.editor.toggleWrap('=='),
    });
  },
});

/**
 * AI, kept on a short leash.
 *
 * Every entry point is a command or a slash command the user typed. Nothing
 * observes keystrokes, nothing pre-fetches, and nothing runs without a visible
 * action — "powerful but not intrusive" has to mean the model never speaks
 * first.
 */
const aiPlugin = definePlugin({
  id: 'core.ai',
  name: 'AI assist',
  description: 'On-demand writing help. Never runs on its own.',

  activate(spark: SparkApi) {
    /**
     * AI commands stay listed in the palette even with no key configured.
     * Hiding them made the feature undiscoverable — you cannot tell a missing
     * feature from an unconfigured one. Listed-but-explaining is honest.
     */
    const requireAi = (): boolean => {
      if (spark.ai.available()) return true;
      spark.ui.toast('AI is off. Add a provider and key in Settings → AI.', 'error');
      return false;
    };

    /** Streams a completion into the document at the cursor as it arrives. */
    const streamInto = async (prompt: string, system?: string) => {
      const start = spark.editor.selection().to;
      let written = 0;

      spark.editor.setSelection(start);
      try {
        await spark.ai.stream(
          prompt,
          (chunk) => {
            spark.editor.replaceRange(start + written, start + written, chunk);
            written += chunk.length;
          },
          { system },
        );
      } catch (err) {
        spark.ui.toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };

    spark.commands.register({
      id: 'ai.continue',
      name: 'Continue writing',
      category: 'AI',
      key: 'Mod-Shift-Enter',
      run: async () => {
        if (!requireAi()) return;
        const before = spark.editor.text().slice(0, spark.editor.selection().from);
        if (!before.trim()) {
          spark.ui.toast('Write a line or two first, then continue.', 'info');
          return;
        }
        await streamInto(
          `Continue this note in the same voice and format. Return only the continuation — do not repeat what is already written.\n\n---\n${before.slice(-4000)}`,
        );
      },
    });

    spark.commands.register({
      id: 'ai.rewrite',
      name: 'Tidy up selection',
      category: 'AI',
      run: async () => {
        if (!requireAi()) return;
        const selected = spark.editor.selectedText();
        if (!selected) {
          spark.ui.toast('Select the text you want tidied.', 'info');
          return;
        }
        const { from, to } = spark.editor.selection();
        let output = '';
        try {
          await spark.ai.stream(
            `Tidy up this note: fix grammar and clarity, keep the author's voice and meaning, keep the markdown structure. Return only the rewritten text.\n\n---\n${selected}`,
            (chunk) => {
              output += chunk;
            },
          );
          spark.editor.replaceRange(from, to, output.trim());
        } catch (err) {
          spark.ui.toast(err instanceof Error ? err.message : String(err), 'error');
        }
      },
    });

    spark.commands.register({
      id: 'ai.ask',
      name: 'Ask about this page',
      category: 'AI',
      run: async () => {
        if (!requireAi()) return;
        const question = await spark.ui.prompt('Ask about this page');
        if (!question) return;
        // Anchor the answer at the end of the note, under the question.
        spark.editor.insert(`\n\n**${question}**\n\n`, spark.editor.text().length);
        await streamInto(
          `Here is a note:\n\n---\n${spark.editor.text().slice(0, 8000)}\n---\n\nAnswer this question about it: ${question}`,
        );
      },
    });

    spark.slash.register({
      name: 'ai',
      description: 'Write something with AI',
      run: async () => {
        if (!requireAi()) return;
        const prompt = await spark.ui.prompt('What should Spark write?');
        if (!prompt) return;
        await streamInto(prompt);
      },
    });
  },
});

/**
 * Fonts before themes, because that is the order the settings panel lists them
 * in — a theme names the pack it wants by id, and *that* is resolved when the
 * stylesheet is built rather than when either one registers, so a slow plugin
 * cannot leave a theme without its typography.
 */
export const builtinPlugins: PluginDefinition[] = [
  markdownPlugin,
  aiPlugin,
  fontsPlugin,
  themesPlugin,
];
