import { useEffect, useState } from 'react';
import type { GitStatus } from '@spark/core';
import { useApp } from '../app-context';
import { ActionDialog } from './ActionDialog';

/**
 * Sync, as a glance and a button.
 *
 * This is an **action dialog**, not a modal view — it belongs to the thing you
 * pressed (the status bar, or the nudge below) and it goes away when you have
 * answered it. See `ActionDialog` for the distinction, which is the reason this
 * file no longer contains the setup flow it used to: *setting up* sync is a
 * place you go, with steps and fields and instructions, so it lives in
 * Settings → Sync. *Checking on* sync is a question, and questions live here.
 *
 * What survives is the part you want mid-sentence: what state sync is in, and
 * one press to reconcile now.
 */
export function SyncPanel({ onClose }: { onClose: () => void }) {
  const { workspace, config, sync, toast } = useApp();
  const [git, setGit] = useState<GitStatus | null>(workspace.sync.git);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void workspace.sync.refresh().then(setGit);
  }, [workspace]);

  const syncNow = async () => {
    setBusy(true);
    try {
      setGit(await workspace.sync.syncNow());
    } finally {
      setBusy(false);
    }
  };

  const openSettings = () => {
    onClose();
    workspace.ui.navigate('Settings');
  };

  const ready = Boolean(git?.configured && git?.authenticated);

  return (
    <ActionDialog
      title="Sync"
      onClose={onClose}
      actions={
        <>
          <button className="button" data-variant="ghost" onClick={onClose}>
            Close
          </button>
          <button className="button" onClick={openSettings}>
            Sync settings
          </button>
          {sync.mode === 'sync' ? (
            <button
              className="button"
              data-variant="primary"
              disabled={busy}
              onClick={() => void syncNow()}
            >
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          ) : (
            <button
              className="button"
              data-variant="primary"
              disabled={busy || !ready}
              title={ready ? undefined : 'Finish setting sync up first.'}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    const ok = await workspace.sync.enableSyncMode();
                    toast(ok ? 'Sync mode on.' : 'Finish setting sync up first.', ok ? 'success' : 'error');
                    setGit(workspace.sync.git);
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              Turn on sync mode
            </button>
          )}
        </>
      }
    >
      <p>
        {sync.mode === 'sync'
          ? 'Sync mode is on — your notes are pulled, committed and pushed on a timer.'
          : "You're in online mode: every keystroke saves straight to the server, and what you see is the file on disk. Nothing is being pushed anywhere."}
      </p>

      <dl className="sync-facts">
        <Row label="Account" value={config.user?.login ?? 'Not connected'} />
        <Row label="Repository" value={git?.remote ?? 'None'} />
        <Row label="Branch" value={git?.branch ?? '—'} />
        <Row label="Local changes" value={git?.dirty ? `${git.dirty} uncommitted` : 'none'} />
        <Row label="Ahead / behind" value={`${git?.ahead ?? 0} / ${git?.behind ?? 0}`} />
      </dl>

      {!ready && (
        <p>
          Sync is not set up yet. <strong>Sync settings</strong> walks through the four steps: a
          GitHub app, your account, a repository, and turning it on.
        </p>
      )}

      {git && git.conflicts.length > 0 && (
        <div className="banner banner-inline" data-kind="warning">
          <p>
            {git.conflicts.length} page{git.conflicts.length === 1 ? '' : 's'} need a manual fix:{' '}
            {git.conflicts.slice(0, 3).join(', ')}
            {git.conflicts.length > 3 ? '…' : ''}. Open them and delete the{' '}
            <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers.
          </p>
        </div>
      )}
    </ActionDialog>
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
