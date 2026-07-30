import { createContext, useContext, type ReactNode } from 'react';

/**
 * Which open view a subtree belongs to.
 *
 * A virtual page renders through `resolveVirtualPage().render()`, which knows
 * nothing about windows — and should not, since the same view has to work when
 * a plugin opens it. But a view like the Spark chat needs to know *which*
 * instance it is, to ask the workbench what is beside it. One context is
 * cheaper than threading an id through every render function.
 */

const InstanceContext = createContext<string | null>(null);

export function ViewInstance({ id, children }: { id: string; children: ReactNode }) {
  return <InstanceContext.Provider value={id}>{children}</InstanceContext.Provider>;
}

/** Null when a view is rendered outside the workbench, which is allowed. */
export function useViewInstance(): string | null {
  return useContext(InstanceContext);
}
