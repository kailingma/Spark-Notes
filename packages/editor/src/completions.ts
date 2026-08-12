import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { SlashCommand } from '@spark/plugin-sdk';

/**
 * Completion sources. Both are deliberately quiet: they only fire on an
 * explicit trigger character, never mid-word, so typing prose never puts a
 * popup in your way.
 */

/** `/command` at the start of a word. */
export function slashCompletion(
  getCommands: () => SlashCommand[],
  runCommand: (command: SlashCommand) => void,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/(?:^|\s)\/([\w-]*)/);
    if (!match) return null;
    if (match.from === match.to && !context.explicit) return null;

    // `matchBefore` includes the leading whitespace; the slash is what we
    // actually want to replace.
    const slashAt = context.state.doc.sliceString(match.from, match.to).indexOf('/');
    const from = match.from + slashAt;

    const options: Completion[] = getCommands().map((command) => ({
      label: `/${command.name}`,
      detail: command.description,
      type: 'keyword',
      apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
        view.dispatch({ changes: { from: applyFrom, to: applyTo, insert: '' } });
        runCommand(command);
      },
    }));

    if (options.length === 0) return null;
    return { from, options, validFor: /^\/[\w-]*$/ };
  };
}

/**
 * `:shortcode` anywhere a word could start.
 *
 * The same curated set the popover-based `EmojiPicker` shows (see
 * `apps/web/src/components/pickers.tsx`) — this is not a second list to keep
 * in step, `getEmoji` is how the caller hands over the one that already
 * exists. Requires two characters after the colon before anything appears
 * (⌃Space forces it regardless): a bare `:` is ordinary punctuation —
 * "Note:", a timestamp, a URL's `https:` — far more often than it is the
 * start of a shortcode, and popping a list open on every one of them would
 * be the thing this file's own docstring warns against.
 */
export function emojiCompletion(
  getEmoji: () => Array<{ glyph: string; keywords: string }>,
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/(?:^|[^\w:]):[a-zA-Z0-9_+-]*/);
    if (!match) return null;

    const colonAt = context.state.doc.sliceString(match.from, match.to).indexOf(':');
    const from = match.from + colonAt;
    const typed = context.state.doc.sliceString(from + 1, context.pos).toLowerCase();
    if (typed.length < 2 && !context.explicit) return null;

    const options: Completion[] = getEmoji()
      .filter((entry) => entry.keywords.includes(typed))
      .slice(0, 30)
      .map((entry) => {
        const shortcode = entry.keywords.split(' ')[0];
        return {
          // `label` is what the autocompletion system matches the typed text
          // against — see `CompletionResult.options`'s own doc — and `from`
          // below points at the colon, so the span being matched is `:smi`,
          // not `smi`. A label of just the shortcode name never starts with
          // a colon and every option was silently filtered out by CodeMirror
          // itself before it ever reached the tooltip, no matter how many
          // options this function returned. `displayLabel` is what actually
          // renders, so the glyph still shows.
          label: `:${shortcode}`,
          displayLabel: `${entry.glyph}  ${shortcode}`,
          type: 'text',
          apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
            view.dispatch({ changes: { from: applyFrom, to: applyTo, insert: entry.glyph } });
          },
        };
      });

    if (options.length === 0) return null;
    return { from, options, validFor: /^:[a-zA-Z0-9_+-]*$/ };
  };
}

/** Page names inside `[[ ]]`. */
export function wikiLinkCompletion(getPages: () => string[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^\]\n]*/);
    if (!match) return null;

    const from = match.from + 2;
    const typed = context.state.doc.sliceString(from, match.to).toLowerCase();

    const options: Completion[] = getPages()
      .filter((page) => !typed || page.toLowerCase().includes(typed))
      .slice(0, 50)
      .map((page) => ({
        label: page,
        type: 'text',
        apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
          // Swallow a closing `]]` the editor already auto-inserted rather
          // than leaving `[[Page]]]]` behind.
          const after = view.state.doc.sliceString(applyTo, applyTo + 2);
          view.dispatch({
            changes: {
              from: applyFrom,
              to: after === ']]' ? applyTo + 2 : applyTo,
              insert: `${page}]]`,
            },
            selection: { anchor: applyFrom + page.length + 2 },
          });
        },
      }));

    if (options.length === 0) return null;
    return { from, options, validFor: /^[^\]\n]*$/ };
  };
}
