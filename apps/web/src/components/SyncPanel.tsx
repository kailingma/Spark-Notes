import { useEffect, useState } from 'react';
import type { GitStatus } from '@spark/core';
import { useApp } from '../app-context';

/**
 * Sync setup and control.
 *
 * Spark runs in **online mode** by default and on every page load: reads and
 * writes go straight to the server, so what's on screen is what's on disk and
 * there is no local replica to fall out of date. **Sync mode** adds git —
 * pulling, committing and pushing on a timer — and stays opt-in, because
 * pushing to someone's repository on their behalf should be a choice they made
 * rather than a default they discover later.
 */
export function SyncPanel({ onClose }: { onClose: () => void }) {
  const { workspace, config, sync, toast } = useApp();
  const [git, setGit] = useState<GitStatus | null>(workspace.sync.git);
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void workspace.sync.refresh().then(setGit);
  }, [workspace]);

  const connectGitHub = () => {
    // A popup keeps the editor mounted; the server posts back when it's done.
    window.open('/api/auth/github', 'spark-github', 'width=680,height=760');
  };

  const attachRemote = async () => {
    const url = remote.trim();
    if (!url) return;
    setBusy(true);
    try {
      const res = await fetch('/api/git/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remote: url }),
      });
      if (!res.ok) throw new Error(await res.text());
      setGit((await res.json()) as GitStatus);
      toast('Repository connected.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const enableSync = async () => {
    setBusy(true);
    try {
      const ok = await workspace.sync.enableSyncMode();
      if (!ok) toast('Connect GitHub and a repository first.', 'error');
      else toast('Sync mode on.', 'success');
      setGit(workspace.sync.git);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      setGit(await workspace.sync.syncNow());
    } finally {
      setBusy(false);
    }
  };

  const needsAuth = !config.user;
  const needsRemote = Boolean(config.user) && !git?.configured;
  const ready = Boolean(git?.configured && git?.authenticated);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Sync"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>Sync</h2>
        <p>
          You're in <strong>online mode</strong> — every keystroke saves straight to the server,
          and what you see is the file on disk. Turn on sync mode to also push your notes to a
          git repository on a schedule.
        </p>

        {/* Step 1 — GitHub account */}
        {needsAuth ? (
          <>
            <p>
              {config.githubAuth
                ? 'Connect a GitHub account so Spark can pull and push on your behalf.'
                : 'GitHub sign-in is not configured on this server. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, then restart it.'}
            </p>
            <div className="dialog-actions">
              <button className="button" data-variant="ghost" onClick={onClose}>
                Close
              </button>
              <button
                className="button"
                data-variant="primary"
                disabled={!config.githubAuth}
                onClick={connectGitHub}
              >
                Connect GitHub
              </button>
            </div>
          </>
        ) : needsRemote ? (
          <>
            <p>
              Signed in as <strong>{config.user?.login}</strong>. Point the space at a repository
              to sync with.
            </p>
            <input
              className="field"
              value={remote}
              placeholder="https://github.com/you/notes.git"
              onChange={(event) => setRemote(event.target.value)}
              aria-label="Repository URL"
            />
            <div className="dialog-actions">
              <button className="button" data-variant="ghost" onClick={onClose}>
                Close
              </button>
              <button
                className="button"
                data-variant="primary"
                disabled={busy || !remote.trim()}
                onClick={() => void attachRemote()}
              >
                {busy ? 'Connecting…' : 'Use this repository'}
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="sync-facts">
              <Row label="Account" value={config.user?.login ?? '—'} />
              <Row label="Repository" value={git?.remote ?? '—'} />
              <Row label="Branch" value={git?.branch ?? '—'} />
              <Row
                label="Local changes"
                value={git?.dirty ? `${git.dirty} uncommitted` : 'none'}
              />
              <Row
                label="Ahead / behind"
                value={`${git?.ahead ?? 0} / ${git?.behind ?? 0}`}
              />
              <Row label="Mode" value={sync.mode === 'sync' ? 'Sync mode' : 'Online only'} />
            </dl>

            {git && git.conflicts.length > 0 && (
              <div className="banner banner-inline" data-kind="warning">
                <p>
                  {git.conflicts.length} page{git.conflicts.length === 1 ? '' : 's'} need a manual
                  fix: {git.conflicts.slice(0, 3).join(', ')}
                  {git.conflicts.length > 3 ? '…' : ''}. Open them and delete the{' '}
                  <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers.
                </p>
              </div>
            )}

            <div className="dialog-actions">
              <button className="button" data-variant="ghost" onClick={onClose}>
                Close
              </button>
              {sync.mode === 'sync' ? (
                <>
                  <button
                    className="button"
                    onClick={() => {
                      workspace.sync.disableSyncMode();
                      toast('Back to online mode.', 'info');
                    }}
                  >
                    Turn off
                  </button>
                  <button
                    className="button"
                    data-variant="primary"
                    disabled={busy}
                    onClick={() => void syncNow()}
                  >
                    {busy ? 'Syncing…' : 'Sync now'}
                  </button>
                </>
              ) : (
                <button
                  className="button"
                  data-variant="primary"
                  disabled={busy || !ready}
                  onClick={() => void enableSync()}
                >
                  {busy ? 'Starting…' : 'Turn on sync mode'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="sync-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The nudge toward sync mode.
 *
 * Shown once per device, and only when sync would actually work — there's no
 * point asking someone to enable something that would immediately fail.
 */
export function SyncPrompt({ onOpen }: { onOpen: () => void }) {
  const { workspace, sync } = useApp();
  const [dismissed, setDismissed] = useState(() =>
    workspace.settings.get('app.syncPromptDismissed', false),
  );
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    void workspace.sync.refresh().then((git) => {
      setEligible(Boolean(git?.configured && git?.authenticated));
    });
  }, [workspace]);

  if (dismissed || !eligible || sync.mode === 'sync') return null;

  const dismiss = () => {
    workspace.settings.set('app.syncPromptDismissed', true);
    setDismissed(true);
  };

  return (
    <div className="banner">
      <p>
        This space is connected to a git repository, but sync mode is off — nothing is being
        pushed.
      </p>
      <div className="banner-actions">
        <button className="button" data-variant="ghost" onClick={dismiss}>
          Not now
        </button>
        <button className="button" data-variant="primary" onClick={onOpen}>
          Turn on sync
        </button>
      </div>
    </div>
  );
}
