import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { CAPTURE_MODES, appendCapture, dailyPageName, findMode } from '../lib/modes';
import { writeCachedPage } from '../lib/page-cache';
import { useVoiceCapture } from '../lib/voice';
import { modKey, useIsNarrow } from '../lib/device';
import { CloseIcon, MicIcon, SparkIcon, StopIcon } from './Icons';

/**
 * Capture — the braindump box.
 *
 * The reason this exists: you are often not arriving to *read* your notes, you
 * are arriving to get a thought out of your head before it's gone. Landing in a
 * file browser costs three taps and the thought. So there is one surface that
 * is nothing but a cursor, and the only decision on it is a label.
 *
 * A phone opens straight into it and it fills the screen, because that is the
 * whole session. On a desktop it is a card over whatever you were reading,
 * reached by ⌘⇧C or the bolt in the header — the note behind it stays visible,
 * and Escape puts you back on the line you were on.
 *
 * Everything captured lands in the day's page as ordinary markdown — the labels
 * are a shortcut for formatting, not a separate storage system.
 */
export function Capture({ onClose }: { onClose: () => void }) {
  const { workspace, toast, openPage, refreshPages, preferences, setPreferences } = useApp();

  const [text, setText] = useState('');
  // The mode you last used is the mode you open in, and it is the same value
  // the settings panel edits — one preference, not two places remembering it.
  const [modeId, setModeId] = useState(preferences.captureMode);
  const [saving, setSaving] = useState(false);
  const [tidy, setTidy] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mode = findMode(modeId);
  const narrow = useIsNarrow();

  // Voice appends straight into the same box, so speaking and typing are the
  // same act — you can dictate a sentence and then fix a word by hand.
  const voice = useVoiceCapture(
    useCallback((chunk: string) => {
      setText((current) => (current ? `${current} ${chunk}` : chunk));
    }, []),
  );

  useEffect(() => {
    // Delay one frame so mobile keyboards actually open.
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    setPreferences({ captureMode: modeId });
  }, [setPreferences, modeId]);

  useEffect(() => {
    if (voice.error) toast(voice.error, 'error');
  }, [voice.error, toast]);

  const chooseMode = (id: string) => {
    setModeId(id);
    inputRef.current?.focus();
  };

  const save = useCallback(
    async (thenOpen: boolean) => {
      const raw = text.trim();
      if (!raw || saving) return;

      setSaving(true);
      if (voice.recording) voice.stop();

      const page = dailyPageName();
      try {
        let content = raw;

        // Tidying is opt-in and only ever offered for spoken input, where the
        // transcript genuinely is a mess. Typed text is left exactly as typed.
        if (tidy && workspace.ai.available()) {
          try {
            const res = await fetch('/api/ai/complete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt: raw, mode: 'braindump' }),
            });
            if (res.ok) {
              const cleaned = (await res.text()).trim();
              if (cleaned) content = cleaned;
            }
          } catch {
            toast('Could not tidy that up — saving it as spoken.', 'info');
          }
        }

        const block = mode.format(content, new Date());
        let existing = '';
        try {
          existing = (await workspace.space.read(page)).text;
        } catch {
          existing = '';
        }

        const next = appendCapture(existing, block, new Date());
        const meta = await workspace.space.write(page, next);
        // The revision travels with the event: an editor holding this page open
        // behind the capture screen has to adopt it, or its next keystroke
        // collides with the append that just happened.
        writeCachedPage(page, next, meta.rev);
        workspace.events.emit('page:save', { page, text: next, rev: meta.rev });
        await refreshPages();

        setText('');
        voice.reset();
        toast(thenOpen ? 'Saved.' : `Saved to ${page}.`, 'success');

        if (thenOpen) openPage(page);
        else inputRef.current?.focus();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setSaving(false);
      }
    },
    [text, saving, voice, tidy, workspace, mode, refreshPages, toast, openPage],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save(false);
    }
    if (event.key === 'Escape') onClose();
  };

  const preview = voice.interim ? `${text ? `${text} ` : ''}${voice.interim}` : text;

  return (
    <>
      {/* Only a card has anything behind it to protect. On a phone the surface
          is the screen, and a scrim under it would dim nothing. */}
      {!narrow && <div className="capture-scrim" onMouseDown={onClose} />}

      <div className="capture" role="dialog" aria-modal="true" aria-label="Quick capture">
        <div className="capture-head">
          <button className="icon-button" onClick={onClose} aria-label="Close capture">
            <CloseIcon />
          </button>
          <div className="modes" role="group" aria-label="Capture mode">
            {CAPTURE_MODES.map((option) => (
              <button
                key={option.id}
                className="mode"
                aria-pressed={option.id === modeId}
                onClick={() => chooseMode(option.id)}
              >
                <span className="mode-glyph" aria-hidden="true">
                  {option.glyph}
                </span>
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="capture-body">
          <textarea
            ref={inputRef}
            className="capture-input"
            value={preview}
            placeholder={mode.placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            // Interim speech is a preview of what the browser thinks it heard,
            // not text yet — editing it would fight the recognizer.
            readOnly={Boolean(voice.interim)}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            aria-label="What do you want to capture?"
          />
        </div>

        <div className="capture-foot">
          {voice.supported && (
            <button
              className="mic"
              data-recording={voice.recording}
              onClick={() => (voice.recording ? voice.stop() : voice.start())}
              aria-label={voice.recording ? 'Stop recording' : 'Start voice capture'}
              aria-pressed={voice.recording}
            >
              {voice.recording ? <StopIcon /> : <MicIcon />}
            </button>
          )}

          <div className="capture-hint">
            {voice.recording ? (
              'Listening — talk it through.'
            ) : workspace.ai.available() && voice.transcript ? (
              <label className="capture-tidy">
                <input
                  type="checkbox"
                  checked={tidy}
                  onChange={(e) => setTidy(e.target.checked)}
                />
                <SparkIcon />
                Tidy up
              </label>
            ) : (
              // The keys are only worth the line where there is a keyboard to
              // press them on.
              `Goes to ${dailyPageName()}${narrow ? '' : ` · ${modKey}↵ saves, Esc closes`}`
            )}
          </div>

          <button
            className="button"
            data-variant="primary"
            disabled={!text.trim() || saving}
            onClick={() => void save(false)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
