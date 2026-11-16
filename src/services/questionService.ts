import { collection, doc, onSnapshot, runTransaction, Unsubscribe, DocumentReference } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { Room, Round, QuestionDoc, ServiceResult } from '../types/game';
import { GAME_LIMITS } from '../constants/gameLimits';
import {
  getAddQuestionBlockReason,
  getQuestionCount,
  getRemainingQuestionSlots,
  isQuestionEditable,
  validateQuestionText,
  QUESTION_ALREADY_ASKED_MSG,
  getQuestionDeleteBlockReason,
  planQuestionRemoval,
  QUESTION_NOT_FOUND_MSG,
  QUESTION_DELETE_LOCKED_MSG,
} from '../lib/questionRules';

/** The ONLY place that builds question document ids. */
export const questionDocId = (roundNumber: number): string => `q_${roundNumber}`;

export function questionDocRef(roomId: string, roundNumber: number): DocumentReference {
  if (!db) throw new Error('Firestore not initialized.');
  return doc(db, 'rooms', roomId, 'questions', questionDocId(roundNumber));
}

/** HOST: Adds one or more questions in a single Firestore transaction. */
export async function addQuestions(roomId: string, texts: string[]): Promise<ServiceResult> {
  if (!db) throw new Error('Firestore not initialized.');
  const database = db;

  if (texts.length === 0) return { success: false, error: 'No questions to add.' };

  const cleanedTexts: string[] = [];
  for (const raw of texts) {
    const v = validateQuestionText(raw);
    if (!v.valid) return { success: false, error: v.error };
    cleanedTexts.push(v.clean);
  }

  const roomRef = doc(database, 'rooms', roomId);
  try {
    await runTransaction(database, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error('Room not found.');
      const room = roomSnap.data() as Omit<Room, 'id'>;

      const blockReason = getAddQuestionBlockReason(room);
      if (blockReason) throw new Error(blockReason);

      const remaining = getRemainingQuestionSlots(room);
      if (cleanedTexts.length > remaining) {
        throw new Error(
          `Only ${remaining} more question(s) can be added (maximum ${GAME_LIMITS.MAX_QUESTIONS_PER_GAME}).`,
        );
      }

      const count = getQuestionCount(room);
      const newCount = count + cleanedTexts.length;

      // If one of the new questions belongs to the round waiting in the lobby, keep that round doc in sync.
      const roundRef = doc(database, 'rooms', roomId, 'rounds', room.currentRoundId ?? `round_${room.currentRoundNumber}`);
      const needsRoundSync =
        room.status === 'LOBBY' &&
        room.currentRoundNumber >= count + 1 &&
        room.currentRoundNumber <= newCount;
      const roundSnap = needsRoundSync ? await tx.get(roundRef) : null;

      const now = Date.now();
      for (let i = 0; i < cleanedTexts.length; i++) {
        const roundNumber = count + i + 1;
        tx.set(questionDocRef(roomId, roundNumber), {
          roundNumber,
          text: cleanedTexts[i],
          createdAt: now,
          updatedAt: now,
        });
      }

      tx.update(
        roomRef,
        newCount > room.settings.totalRounds
          ? { questionCount: newCount, 'settings.totalRounds': newCount, updatedAt: now }
          : { questionCount: newCount, updatedAt: now }
      );

      if (roundSnap && roundSnap.exists() && (roundSnap.data() as Round).status === 'LOBBY') {
        const targetText = cleanedTexts[room.currentRoundNumber - (count + 1)];
        if (targetText !== undefined) {
          tx.update(roundRef, { question: targetText });
        }
      }
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to add questions.' };
  }
}

/** HOST: Adds the next question. Rules (cap, status) come from questionRules. Raises totalRounds if needed. */
export async function addQuestion(roomId: string, text: string): Promise<ServiceResult> {
  return addQuestions(roomId, [text]);
}

/** HOST: Edits a question that has not been asked yet. */
export async function editQuestion(roomId: string, roundNumber: number, text: string): Promise<ServiceResult> {
  if (!db) throw new Error('Firestore not initialized.');
  const database = db;
  const v = validateQuestionText(text);
  if (!v.valid) return { success: false, error: v.error };

  const roomRef = doc(database, 'rooms', roomId);
  const qRef = questionDocRef(roomId, roundNumber);
  try {
    await runTransaction(database, async (tx) => {
      // ALL reads first
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error('Room not found.');
      const room = roomSnap.data() as Omit<Room, 'id'>;
      const qSnap = await tx.get(qRef);
      if (!qSnap.exists()) throw new Error('Question not found.');
      if (!isQuestionEditable(roundNumber, room.currentRoundNumber, room.status)) {
        throw new Error(QUESTION_ALREADY_ASKED_MSG);
      }
      let roundRef: DocumentReference | null = null;
      let roundExists = false;
      if (roundNumber === room.currentRoundNumber) {
        roundRef = doc(database, 'rooms', roomId, 'rounds', `round_${roundNumber}`);
        const roundSnap = await tx.get(roundRef);
        roundExists = roundSnap.exists();
        if (roundExists && (roundSnap.data() as Round).status !== 'LOBBY') {
          throw new Error(QUESTION_ALREADY_ASKED_MSG);
        }
      }
      // THEN writes
      tx.update(qRef, { text: v.clean, updatedAt: Date.now() });
      if (roundRef && roundExists) tx.update(roundRef, { question: v.clean });
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to edit question.' };
  }
}

/** HOST: Deletes a question that has not been asked yet and shifts subsequent questions. */
export async function deleteQuestion(roomId: string, roundNumber: number): Promise<ServiceResult> {
  if (!db) throw new Error('Firestore not initialized.');
  const database = db;

  const roomRef = doc(database, 'rooms', roomId);
  try {
    await runTransaction(database, async (tx) => {
      // 1. read the room doc; throw 'Room not found.' if missing.
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error('Room not found.');
      const room = roomSnap.data() as Omit<Room, 'id'>;

      // 2. reason = getQuestionDeleteBlockReason(room, roundNumber); throw new Error(reason) if not null.
      const reason = getQuestionDeleteBlockReason(room, roundNumber);
      if (reason) throw new Error(reason);

      // 3. count = getQuestionCount(room). Read question docs questionDocRef(roomId, n) for n = roundNumber..count.
      const count = getQuestionCount(room);
      const questionSnaps = [];
      for (let n = roundNumber; n <= count; n++) {
        const qSnap = await tx.get(questionDocRef(roomId, n));
        if (!qSnap.exists()) throw new Error(QUESTION_NOT_FOUND_MSG);
        questionSnaps.push(qSnap);
      }
      const tailTexts = questionSnaps.map((s) => (s.data() as QuestionDoc).text);

      // 4. only if roundNumber === room.currentRoundNumber: read the round doc `round_${roundNumber}` exactly like editQuestion does;
      // if it exists and its status !== 'LOBBY' throw new Error(QUESTION_DELETE_LOCKED_MSG).
      let roundRef: DocumentReference | null = null;
      let roundExists = false;
      if (roundNumber === room.currentRoundNumber) {
        roundRef = doc(database, 'rooms', roomId, 'rounds', `round_${roundNumber}`);
        const roundSnap = await tx.get(roundRef);
        roundExists = roundSnap.exists();
        if (roundExists && (roundSnap.data() as Round).status !== 'LOBBY') {
          throw new Error(QUESTION_DELETE_LOCKED_MSG);
        }
      }

      // THEN WRITES:
      const plan = planQuestionRemoval(tailTexts, roundNumber);
      const now = Date.now();
      for (const u of plan.updates) {
        tx.update(questionDocRef(roomId, u.roundNumber), { text: u.text, updatedAt: now });
      }
      tx.delete(questionDocRef(roomId, plan.deleteRoundNumber));
      tx.update(roomRef, { questionCount: count - 1, updatedAt: now });
      if (roundRef && roundExists) {
        tx.update(roundRef, { question: plan.updates[0]?.text ?? '' });
      }
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Failed to delete question.' };
  }
}

/** Realtime list of questions sorted by round number. */
export function subscribeToQuestions(roomId: string, callback: (questions: QuestionDoc[]) => void): Unsubscribe {
  if (!db) return () => {};
  return onSnapshot(collection(db, 'rooms', roomId, 'questions'), (snap) => {
    const list = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<QuestionDoc, 'id'>) }))
      .sort((a, b) => a.roundNumber - b.roundNumber);
    callback(list);
  });
}

