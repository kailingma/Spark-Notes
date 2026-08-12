import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { journalFolder } from '../lib/dirs';
import { CAPTURE_MODES, appendCapture, dailyPageName, findMode } from '../lib/modes';
import { ModeGlyph } from '../lib/mode-icons';
import { writeCachedPage } from '../lib/page-cache';
import { markdownLinkFor } from '../lib/uploads';
import { useVoiceCapture } from '../lib/voice';
import { useIsNarrow } from '../lib/device';
import { filesApi, sparkApi, type SparkMode, type SparkSettings, type StoredFile } from '../lib/spark-client';
import { CheckIcon, CloseIcon, MicIcon, SparkIcon, StopIcon } from './Icons';
import { anchorElement, PopoverMenu, usePopover } from './Popover';

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
 *
 * ## The model in here is not Spark
 *
 * "Tidy up" grew into a real feature — a model choice, attachments, a preview
 * you accept or reject — but it stayed deliberately *unlike* the chat, and the
 * distinction is the point of the screen. Spark is a conversation that can act.
 * This is a rewrite with a destination: it never answers, never converses, and
 * never adds a thought that was not there. It takes what you said and produces
 * the markdown you would have written if you had had the time, for one specific
 * page — today's.
 *
 * That is why it calls `/api/capture/shape` rather than the agent loop. One
 * input, no history, no tools, no round trip: routing it through the agent would
 * make the fastest surface in the app wait on the slowest one.
 *
 * The shaped text is shown *beside* what you said rather than replacing it,
 * because a model rewriting your words without showing you is the one thing this
 * screen must not do. You accept it, or you send what you actually wrote.
 */
export function Capture({ onClose }: { onClose: () => void }) {
  const { workspace, toast, openPage, refreshPages, preferences, setPreferences } = useApp();
  const journal = journalFolder(workspace);

  const [text, setText] = useState('');
  // The mode you last used is the mode you open in, and it is the same value
  // the settings panel edits — one preference, not two places remembering it.
  const [modeId, setModeId] = useState(preferences.captureMode);
  const [saving, setSaving] = useState(false);
  const [attached, setAttached] = useState<StoredFile[]>([]);
  const [settings, setSettings] = useState<SparkSettings | null>(null);

  /** The shaped version, once one has been asked for. */
  const [shaped, setShaped] = useState<string | null>(null);
  const [shaping, setShaping] = useState(false);
  const shapeAbort = useRef<AbortController | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mode = findMode(modeId);
  const narrow = useIsNarrow();

  useEffect(() => {
    void sparkApi.settings().then(setSettings);
  }, []);

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

  // A shaped version of text that has since been edited is a shaped version of
  // something else. Dropping it is the honest move: the alternative is a preview
  // that quietly stops matching what it claims to be a rewrite of.
  useEffect(() => {
    setShaped(null);
  }, [text]);

  const chooseMode = (id: string) => {
    setModeId(id);
    inputRef.current?.focus();
  };

  /**
   * Ask the model to shape it.
   *
   * Streams into the preview as it arrives, like every other model call in the
   * app: a capture is short, but a cold model is not fast, and a box that sits
   * blank for three seconds reads as a hang.
   */
  const shape = useCallback(async () => {
    const raw = text.trim();
    if (!raw || shaping) return;

    if (voice.recording) voice.stop();
    setShaping(true);
    setShaped('');

    const controller = new AbortController();
    shapeAbort.current = controller;

    try {
      // What is already on today's page, so the shaping matches its voice
      // rather than inventing a house style halfway down a journal entry.
      const page = dailyPageName(new Date(), journal);
      const existing = await workspace.space
        .read(page)
        .then((entry) => entry.text)
        .catch(() => '');

      const res = await fetch('/api/capture/shape', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: raw,
          mode: mode.label,
          page: existing,
          ...(attached.length > 0 ? { attachments: attached.map((file) => file.name) } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error((await res.text()) || 'Could not shape that.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let out = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
        setShaped(out);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setShaped(null);
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    } finally {
      shapeAbort.current = null;
      setShaping(false);
    }
  }, [text, shaping, voice, workspace, mode, attached, toast, journal]);

  const attach = useCallback(
    async (files: File[] | FileList | null) => {
      const list = [...(files ?? [])];
      for (const file of list) {
        try {
          // Awaited outside the updater: React runs an updater more than once,
          // and an upload inside one would upload twice. See AGENTS → Traps.
          const stored = await filesApi.upload(file);
          setAttached((current) => [...current, stored]);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      }
    },
    [toast],
  );

  const save = useCallback(
    async (thenOpen: boolean) => {
      // What is saved is what is on screen: the shaped version if one has been
      // accepted into the box, otherwise exactly what was typed.
      const raw = (shaped ?? text).trim();
      if (!raw || saving) return;

      setSaving(true);
      if (voice.recording) voice.stop();

      const page = dailyPageName(new Date(), journal);
      try {
        // Attachments are appended as ordinary markdown links, which is the same
        // thing Spark writes — a file in a notes app that nothing links to is a
        // file you will never find again.
        const links = attached.map((file) => markdownLinkFor(file)).join('\n');
        const block = mode.format(links ? `${raw}\n\n${links}` : raw, new Date());

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
        setShaped(null);
        setAttached([]);
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
    [text, shaped, saving, voice, attached, workspace, mode, refreshPages, toast, openPage, journal],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save(false);
    }
    if (event.key === 'Escape') {
      if (shaped !== null) {
        // Escape backs out of the preview before it backs out of the screen:
        // one key, one layer at a time, the same rule the popovers follow.
        setShaped(null);
        return;
      }
      onClose();
    }
  };

  const preview = voice.interim ? `${text ? `${text} ` : ''}${voice.interim}` : text;
  const ai = workspace.ai.available();

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
                  <option.icon size={14} />
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
            onPaste={(event) => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return;
              event.preventDefault();
              void attach(files);
            }}
            // Interim speech is a preview of what the browser thinks it heard,
            // not text yet — editing it would fight the recognizer.
            readOnly={Boolean(voice.interim)}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            aria-label="What do you want to capture?"
          />

          {/*
            The rewrite, shown beside what you said rather than instead of it.
            A model quietly replacing your words is the one thing this screen
            must not do, so accepting is a button and not a default.
          */}
          {shaped !== null && (
            <div className="capture-shaped">
              <header>
                <SparkIcon size={16} />
                <span>{shaping ? 'Shaping…' : 'Shaped'}</span>
                <span className="header-spacer" />
                {!shaping && (
                  <>
                    <button
                      className="button"
                      data-variant="primary"
                      onClick={() => {
                        // Accepting means it becomes the text. There is then no
                        // preview, because there is nothing left to compare.
                        const next = shaped.trim();
                        setText(next);
                        setShaped(null);
                        inputRef.current?.focus();
                      }}
                    >
                      <CheckIcon />
                      Use this
                    </button>
                    <button className="button" data-variant="ghost" onClick={() => setShaped(null)}>
                      Discard
                    </button>
                  </>
                )}
              </header>
              <pre>{shaped || ' '}</pre>
            </div>
          )}

          {attached.length > 0 && (
            <ul className="capture-files">
              {attached.map((file) => (
                <li key={file.name}>
                  <span>{file.name.replace(/^files\//, '')}</span>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${file.name}`}
                    title="Remove — the file stays in your space"
                    onClick={() =>
                      setAttached((current) => current.filter((entry) => entry.name !== file.name))
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
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

          {ai && (
            <>
              <button
                className="button capture-shape"
                disabled={!text.trim() || shaping}
                onClick={() => (shaping ? shapeAbort.current?.abort() : void shape())}
                title="Turn this into the markdown you would have written"
              >
                <SparkIcon size={16} />
                {shaping ? 'Stop' : 'Shape it'}
              </button>
              {settings && settings.modes.filter((entry) => entry.enabled).length > 1 && (
                <CaptureModel
                  modes={settings.modes.filter((entry) => entry.enabled)}
                  active={preferences.sparkModeId}
                  onPick={(sparkModeId) => setPreferences({ sparkModeId })}
                />
              )}
            </>
          )}

          <div className="capture-hint">
            {voice.recording ? 'Listening — talk it through.' : ''}
          </div>

          <button
            className="button"
            data-variant="primary"
            disabled={!(shaped ?? text).trim() || saving}
            onClick={() => void save(false)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Which model shapes it.
 *
 * The same preset list the chat uses, and the same preference — one choice, not
 * two places remembering it. Only shown when there is more than one to choose
 * from, because a switcher with one option is a label pretending to be a control.
 */
function CaptureModel({
  modes,
  active,
  onPick,
}: {
  modes: SparkMode[];
  active: string;
  onPick: (id: string) => void;
}) {
  const popover = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  const current = modes.find((mode) => mode.id === active) ?? modes[0];

  return (
    <button
      ref={ref}
      className="spark-dial"
      aria-label={`Model: ${current.label}`}
      title={`Shaping with ${current.label}`}
      onClick={() =>
        popover.open({
          label: 'Model',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'start',
          role: 'menu',
          render: ({ close }) => (
            <PopoverMenu
              close={close}
              entries={modes.map((mode) => ({
                id: mode.id,
                label: mode.label,
                icon: <ModeGlyph icon={mode.icon} kind={mode.iconKind} />,
                hint: mode.model || 'default model',
                run: () => onPick(mode.id),
              }))}
            />
          ),
        })
      }
    >
      <ModeGlyph icon={current.icon} kind={current.iconKind} />
      <span>{current.label}</span>
    </button>
  );
}
