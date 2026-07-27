import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice capture for brain-dumping.
 *
 * Uses the browser's own speech recognition, so a dump never leaves the device
 * unless the user later asks the AI to tidy it up. Transcription is continuous
 * and interim results are surfaced live — talking into a blank screen with no
 * feedback for thirty seconds is unnerving, and seeing the words appear is what
 * makes it feel like thinking out loud rather than dictating.
 */

// The API is still vendor-prefixed in most browsers and untyped in lib.dom.
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string }> & { isFinal: boolean }
  >;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getRecognition(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = (): boolean => getRecognition() !== null;

export interface VoiceCapture {
  supported: boolean;
  recording: boolean;
  /** Text finalized so far this session. */
  transcript: string;
  /** The phrase currently being spoken, not yet final. */
  interim: string;
  error: string | null;
  start(): void;
  stop(): void;
  reset(): void;
}

export function useVoiceCapture(
  onFinalChunk?: (text: string) => void,
): VoiceCapture {
  const [recording, setRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantsRecordingRef = useRef(false);
  const onFinalRef = useRef(onFinalChunk);
  onFinalRef.current = onFinalChunk;

  const stop = useCallback(() => {
    wantsRecordingRef.current = false;
    recognitionRef.current?.stop();
    setRecording(false);
    setInterim('');
  }, []);

  const start = useCallback(() => {
    const Recognition = getRecognition();
    if (!Recognition) {
      setError('This browser has no speech recognition.');
      return;
    }
    if (recognitionRef.current) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else interimText += text;
      }

      if (finalText) {
        const cleaned = finalText.trim();
        setTranscript((prev) => (prev ? `${prev} ${cleaned}` : cleaned));
        onFinalRef.current?.(cleaned);
      }
      setInterim(interimText);
    };

    recognition.onerror = (event) => {
      // `no-speech` and `aborted` fire constantly during normal pauses.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(
        event.error === 'not-allowed'
          ? 'Microphone access was denied.'
          : `Speech recognition error: ${event.error}`,
      );
      wantsRecordingRef.current = false;
      setRecording(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      // Browsers cut the session off after a pause; restart so a long, halting
      // brain-dump isn't silently truncated mid-thought.
      if (wantsRecordingRef.current) {
        try {
          start();
        } catch {
          setRecording(false);
        }
      }
    };

    recognitionRef.current = recognition;
    wantsRecordingRef.current = true;
    setError(null);

    try {
      recognition.start();
      setRecording(true);
    } catch (err) {
      recognitionRef.current = null;
      setError(err instanceof Error ? err.message : 'Could not start recording.');
    }
  }, []);

  const reset = useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
  }, []);

  // Never leave the microphone open when the component goes away.
  useEffect(
    () => () => {
      wantsRecordingRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  return {
    supported: voiceSupported(),
    recording,
    transcript,
    interim,
    error,
    start,
    stop,
    reset,
  };
}
