import type { ReactNode } from 'react';
import type { WindowMode } from '@spark/plugin-sdk';
import { pageBasename } from '@spark/core';
import { NavigatorIcon, SettingsIcon } from '../components/Icons';
import { resolveVirtualPage } from '../virtual';
import { SettingsView } from '../virtual/SettingsView';
import { Navigator } from '../navigator/Navigator';
import { PageView } from './PageView';

/**
 * The views the shell itself contributes.
 *
 * A plugin's view mounts into a bare element (`ViewDefinition.mount`), which is
 * the right contract for a `.js` file loaded from the space but a poor one for
 * a React tree that wants the app's context. So the shell keeps its own table
 * with a `render` that returns a node, and the workbench resolves a type
 * against this first and the plugin registry second. Everything downstream —
 * tabs, splits, windows, rails, drag and drop — treats the two identically.
 */

export const PAGE_VIEW = 'spark.page';
export const SETTINGS_VIEW = 'spark.settings';
export const NAVIGATOR_VIEW = 'spark.navigator';

export interface ShellViewContext {
  instanceId: string;
  params: Record<string, string>;
}

export interface ShellView {
  id: string;
  title: string;
  icon?: ReactNode;
  /** Where it goes when the caller didn't say. */
  defaultMode?: WindowMode;
  /** Preferred size as a floating window. */
  size?: { width: number; height: number };
  /** True when several instances with the same parameters make sense. */
  multiple?: boolean;
  /** Per-instance title, from the parameters it was opened with. */
  titleFor?: (params: Record<string, string>) => string;
  render: (ctx: ShellViewContext) => ReactNode;
}

export const SHELL_VIEWS: Record<string, ShellView> = {
  [PAGE_VIEW]: {
    id: PAGE_VIEW,
    title: 'Page',
    titleFor: (params) => {
      const page = params.page ?? '';
      if (!page) return 'Untitled';
      return resolveVirtualPage(page)?.title ?? pageBasename(page);
    },
    size: { width: 760, height: 620 },
    render: ({ instanceId, params }) => (
      <PageView instanceId={instanceId} page={params.page ?? ''} />
    ),
  },

  [SETTINGS_VIEW]: {
    id: SETTINGS_VIEW,
    title: 'Settings',
    icon: <SettingsIcon />,
    // Settings is something you do *to* the app rather than a document you read
    // beside your notes, so it opens above the workbench and gives the page you
    // were on back the moment you dismiss it.
    defaultMode: 'modal',
    size: { width: 880, height: 640 },
    render: () => <SettingsView />,
  },

  [NAVIGATOR_VIEW]: {
    id: NAVIGATOR_VIEW,
    title: 'Navigator',
    icon: <NavigatorIcon />,
    defaultMode: 'sidebar-left',
    // The instance id is how the navigator finds out which surface it is on,
    // which is what closing its last open half has to know: a rail closes, a
    // floating navigator closes its window.
    render: ({ instanceId }) => <Navigator instanceId={instanceId} />,
  },
};
