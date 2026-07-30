import { useEffect, useState } from 'react';
import { encodePageName } from '@spark/core';
import { useApp } from '../app-context';
import { tagPageName } from './index';

interface Mention {
  page: string;
  line: number;
  text: string;
}

/**
 * A tag's page: everywhere that tag is used.
 *
 * A tag nobody has written yet still has a page — it just says so. That's the
 * point of making tags addressable: you can link to `#project/spark` before it
 * means anything, and the page fills in as you use it.
 */
export function TagView({ tag }: { tag: string }) {
  const { openPage } = useApp();
  const [mentions, setMentions] = useState<Mention[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMentions(null);

    void (async () => {
      try {
        const res = await fetch(`/api/tags/${encodePageName(tag)}`);
        const found = res.ok ? ((await res.json()) as Mention[]) : [];
        if (!cancelled) setMentions(found);
      } catch {
        if (!cancelled) setMentions([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tag]);

  const byPage = new Map<string, Mention[]>();
  for (const mention of mentions ?? []) {
    const list = byPage.get(mention.page);
    if (list) list.push(mention);
    else byPage.set(mention.page, [mention]);
  }

  return (
    <div className="listing">
      <div className="listing-inner">
        <h1>#{tag}</h1>
        <p className="listing-sub">
          {mentions === null
            ? 'Looking…'
            : mentions.length === 0
              ? 'Nothing uses this tag yet. Write it on any page and it will appear here.'
              : `${mentions.length} mention${mentions.length === 1 ? '' : 's'} across ${byPage.size} page${byPage.size === 1 ? '' : 's'}`}
        </p>

        {[...byPage.entries()].map(([page, entries]) => (
          <section className="listing-group" key={page}>
            <h2 className="listing-group-title">
              <button onClick={() => openPage(page)}>{page}</button>
            </h2>
            {entries.map((entry) => (
              <button
                className="listing-line"
                key={`${page}:${entry.line}`}
                onClick={() => openPage(page, entry.line)}
              >
                {entry.text}
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Every tag in the space, as a way in to the individual tag pages. */
export function TagIndexView() {
  const { openPage } = useApp();
  const [tags, setTags] = useState<Array<{ tag: string; count: number }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/tags');
        const found = res.ok ? ((await res.json()) as Array<{ tag: string; count: number }>) : [];
        if (!cancelled) setTags(found);
      } catch {
        if (!cancelled) setTags([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="listing">
      <div className="listing-inner">
        <h1>Tags</h1>
        <p className="listing-sub">
          {tags === null
            ? 'Looking…'
            : tags.length === 0
              ? 'No tags yet. Write #something on any page.'
              : `${tags.length} tag${tags.length === 1 ? '' : 's'} in this space`}
        </p>

        <div className="tag-cloud">
          {(tags ?? []).map(({ tag, count }) => (
            <button
              className="tag-chip"
              key={tag}
              onClick={() => openPage(tagPageName(tag))}
            >
              #{tag}
              <span className="tag-chip-count">{count}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
