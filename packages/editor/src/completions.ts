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
