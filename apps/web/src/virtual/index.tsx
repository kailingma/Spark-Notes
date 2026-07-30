import type { ReactNode } from 'react';
import { normalizePageName } from '@spark/core';
import { MemoryIcon, SettingsIcon, SparkIcon, TagIcon, TaskIcon } from '../components/Icons';
import { MemoryView } from './MemoryView';
import { SparkView } from './SparkView';
import { TagIndexView, TagView } from './TagView';
import { TasksView } from './TasksView';

/**
 * Virtual pages: addressable, linkable, and backed by nothing on disk.
 *
 * Tasks, tag pages and Spark are *views over* the space, not documents in it.
 * Giving them real page names rather than special routes means `[[Tasks]]` and
 * `[[tags/idea]]` are ordinary links, they can be bookmarked, they show up in
 * backlinks, and — since the workbench treats a page as a page — they tile,
 * tile, window and rail like anything else. Nothing is written to disk, because the
 * editor is simply not mounted for them.
 */

export interface VirtualPage {
  /** Canonical name, as it would be written in a `[[link]]`. */
  name: string;
  title: string;
  subtitle?: string;
  /**
   * How the workbench should present it. A `page` goes in a tile; a `modal`
   * opens above the workbench and hands your place back when it closes. The
   * distinction is about what the thing *is*: Settings acts on the app, so it
   * should not cost you the note you were reading.
   */
  presentation: 'page' | 'modal';
  render: () => ReactNode;
}

/**
 * The Spark chat's page name.
 *
 * Named rather than spelled out at each call site because the workbench treats
 * it specially — classic mode sends it to the right rail instead of the editor
 * area — and a typo there would silently open a note called "Spark".
 */
export const SPARK_PAGE = 'Spark';

/** The virtual pages that exist regardless of content, for the navigator. */
export const VIRTUAL_INDEX: Array<{ name: string; title: string; icon: ReactNode }> = [
  { name: 'Tasks', title: 'Tasks', icon: <TaskIcon /> },
  { name: 'Tags', title: 'Tags', icon: <TagIcon /> },
  { name: 'Spark', title: 'Spark', icon: <SparkIcon /> },
  { name: 'Memory', title: 'Memory', icon: <MemoryIcon /> },
  { name: 'Settings', title: 'Settings', icon: <SettingsIcon /> },
];

const TAG_PAGE_RE = /^tags\/(.+)$/i;

export function resolveVirtualPage(rawName: string): VirtualPage | null {
  const name = normalizePageName(rawName);
  const lower = name.toLowerCase();

  if (lower === 'tasks') {
    return { name: 'Tasks', title: 'Tasks', presentation: 'page', render: () => <TasksView /> };
  }

  if (lower === 'tags') {
    return { name: 'Tags', title: 'Tags', presentation: 'page', render: () => <TagIndexView /> };
  }

  if (lower === 'spark') {
    return { name: 'Spark', title: 'Spark', presentation: 'page', render: () => <SparkView /> };
  }

  // A page rather than a modal, unlike Settings: what Spark knows is something
  // you read beside a note and argue with, not a control panel you visit and
  // leave.
  if (lower === 'memory') {
    return {
      name: 'Memory',
      title: 'Memory',
      subtitle: 'What Spark knows',
      presentation: 'page',
      render: () => <MemoryView />,
    };
  }

  if (lower === 'settings') {
    return {
      name: 'Settings',
      title: 'Settings',
      presentation: 'modal',
      // Rendered by the settings view registered with the workbench; a modal
      // never reaches this, but a direct render must still work if it ever does.
      render: () => null,
    };
  }

  const tag = TAG_PAGE_RE.exec(name);
  if (tag) {
    const label = tag[1];
    return {
      name: `tags/${label}`,
      title: `#${label}`,
      subtitle: 'Tag',
      presentation: 'page',
      render: () => <TagView tag={label} />,
    };
  }

  return null;
}

export function isVirtualPage(name: string): boolean {
  return resolveVirtualPage(name) !== null;
}

/** The virtual page a `#tag` links to. */
export function tagPageName(tag: string): string {
  return `tags/${tag.replace(/^#/, '')}`;
}
