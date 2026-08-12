/**
 * Waiting for a person to say yes.
 *
 * Permissions are enforced by withholding tools — see `spark-tools.ts` — and that
 * covers "never". It cannot cover "yes, but tell me each time", which is what the
 * manual permission modes are, so this is the other half: the turn stops, the
 * browser is sent the call it is being asked about, and the loop resumes when an
 * answer arrives.
 *
 * The awkward part is that the turn is **one long response** and the answer has to
 * come in on **a different request**. So the promise cannot live in the route
 * closure; it lives here, keyed by the tool call id, and the approve endpoint
 * resolves it from outside. That is the whole reason this file exists.
 *
 * Three things make it safe to keep promises in a module-level map:
 *
 * - **Every wait has a deadline.** A browser that is closed mid-question would
 *   otherwise leave the entry, and the open response, there forever. On the
 *   deadline the call is refused, which the model can explain.
 * - **The request's abort signal clears it.** Pressing stop resolves the wait
 *   rather than leaving the loop parked on it.
 * - **An id can only be answered once.** It is deleted before the resolver runs,
 *   so a double-click cannot resume the loop twice.
 *
 * This is a personal server with one owner, so there is no question of one
 * person's approval reaching another's turn.
 */

export type ApprovalDecision = 'once' | 'always' | 'deny';

/** How long a question waits before it is treated as a no. */
const DEADLINE_MS = 10 * 60 * 1000;

const waiting = new Map<string, { settle: (decision: ApprovalDecision) => void; timer: NodeJS.Timeout }>();

/**
 * Tools a person has said "always" to, per conversation.
 *
 * In memory rather than in the chat file, and for the lifetime of the process: it
 * is a decision about *this sitting*, and a blanket allowance that quietly
 * survived a restart would be a permission change nobody made. Manual mode with
 * no way to stop being asked about `read_page` is manual mode nobody uses, which
 * is why the affordance exists at all.
 */
const standing = new Map<string, Set<string>>();

export function alwaysAllowed(chatId: string, tool: string): boolean {
  return standing.get(chatId)?.has(tool) ?? false;
}

export function allowAlways(chatId: string, tool: string): void {
  const set = standing.get(chatId) ?? new Set<string>();
  set.add(tool);
  standing.set(chatId, set);
}

/** Forgets a conversation's standing allowances. Called when a chat is deleted. */
export function forgetApprovals(chatId: string): void {
  standing.delete(chatId);
}

export function askApproval(id: string, signal?: AbortSignal): Promise<ApprovalDecision> {
  // An already-aborted turn must not open a wait that nothing will close.
  if (signal?.aborted) return Promise.resolve('deny');

  return new Promise<ApprovalDecision>((resolve) => {
    const settle = (decision: ApprovalDecision) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    function onAbort() {
      resolveApproval(id, 'deny');
    }

    const timer = setTimeout(() => resolveApproval(id, 'deny'), DEADLINE_MS);
    // Not worth holding the process open for.
    timer.unref?.();

    waiting.set(id, { settle, timer });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Answers a waiting question. False when there was nothing waiting on that id. */
export function resolveApproval(id: string, decision: ApprovalDecision): boolean {
  const entry = waiting.get(id);
  if (!entry) return false;
  // Deleted first: a second answer for the same id must find nothing.
  waiting.delete(id);
  clearTimeout(entry.timer);
  entry.settle(decision);
  return true;
}
