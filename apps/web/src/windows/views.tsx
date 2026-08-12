import type { ReactNode } from 'react';
import type { WindowMode } from '@spark/plugin-sdk';
import { pageBasename } from '@spark/core';
import { NavigatorIcon, PlacesIcon, SettingsIcon } from '../components/Icons';
import { resolveVirtualPage } from '../virtual';
import { SettingsView } from '../virtual/SettingsView';
import { Navigator } from '../navigator/Navigator';
import { Places } from '../navigator/Places';
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
export const PLACES_VIEW = 'spark.places';

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
  /**
   * Refuses to exist twice, even when a duplicate is asked for.
   *
   * Almost nothing sets this. Everything else may be opened again deliberately
   * — dragged into a tab strip, or through "open another" — because a workbench
   * whose drag and drop implies two of something has to be able to produce two
   * of it. This is for views that are a *state of the app* rather than a
   * viewport onto something: two Settings modals are two copies of one thing
   * you are in the middle of doing.
   */
  single?: boolean;
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
    single: true,
    render: () => <SettingsView />,
  },

  [NAVIGATOR_VIEW]: {
    id: NAVIGATOR_VIEW,
    title: 'Navigator',
    icon: <NavigatorIcon />,
    defaultMode: 'sidebar-left',
    size: { width: 380, height: 620 },
    // The instance id is how the navigator finds out which surface it is on,
    // which is what closing it has to know: in a rail the last close toggles
    // the rail, floated it closes its own window.
    render: ({ instanceId }) => <Navigator instanceId={instanceId} />,
  },

  [PLACES_VIEW]: {
    id: PLACES_VIEW,
    title: 'Places',
    icon: <PlacesIcon />,
    defaultMode: 'sidebar-left',
    size: { width: 320, height: 480 },
    render: ({ instanceId }) => <Places instanceId={instanceId} />,
  },
};
