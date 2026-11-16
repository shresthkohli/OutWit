import { useState, useEffect, useCallback, useRef } from 'react';
import { APP_INFO } from '../constants/appInfo';
import {
  AiPromptDraft,
  createDefaultAiPromptDraft,
  sanitizeAiPromptDraft,
} from '../lib/aiPrompt';

export function useAiPromptDraft(
  roomCode: string | undefined,
  roomStatus: string | undefined,
  maxCount: number
): { draft: AiPromptDraft; updateDraft: (patch: Partial<AiPromptDraft>) => void } {
  const storageKey = roomCode
    ? `${APP_INFO.STORAGE_PREFIX}_ai_draft_${roomCode.toUpperCase()}`
    : null;

  const initialMaxRef = useRef(maxCount);

  const [draft, setDraft] = useState<AiPromptDraft>(() => {
    if (!storageKey) return createDefaultAiPromptDraft(maxCount);
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        return sanitizeAiPromptDraft(JSON.parse(stored), maxCount);
      }
    } catch {
      // Storage unavailable or JSON parse error
    }
    return createDefaultAiPromptDraft(maxCount);
  });

  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;

  const updateDraft = useCallback((patch: Partial<AiPromptDraft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      const key = storageKeyRef.current;
      if (key) {
        try {
          sessionStorage.setItem(key, JSON.stringify(next));
        } catch {
          // Storage unavailable or quota exceeded
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) {
        setDraft(sanitizeAiPromptDraft(JSON.parse(stored), initialMaxRef.current));
      }
    } catch {
      // Storage unavailable or JSON parse error
    }
  }, [storageKey]);

  useEffect(() => {
    if (roomStatus === 'GAME_FINISHED') {
      if (storageKey) {
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          // Storage unavailable
        }
      }
      setDraft(createDefaultAiPromptDraft(maxCount));
    }
  }, [roomStatus, storageKey, maxCount]);

  return { draft, updateDraft };
}
