import fs from 'fs';
import { Logger } from 'winston';
import config from '../config';
import { extractAudio } from '../lib/audio-extract';
import { transcribeWithOpenRouter } from './openrouterProvider';
import { transcribeWithDeepgram } from './deepgramProvider';

export interface TranscriptUtterance {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface TranscriptionResult {
  provider: string;
  model: string;
  language: string;
  fullText: string;
  utterances: TranscriptUtterance[];
  durationSeconds: number;
  transcribedAt: string;
}

function buildFullText(utterances: TranscriptUtterance[]): string {
  if (utterances.length === 0) return '';
  const lines: string[] = [];
  let currentSpeaker = '';
  for (const utt of utterances) {
    if (utt.speaker !== currentSpeaker) {
      if (lines.length > 0) lines.push('');
      lines.push(`${utt.speaker}:`);
      currentSpeaker = utt.speaker;
    }
    lines.push(utt.text);
  }
  return lines.join('\n');
}

export async function transcribeRecording(
  videoPath: string,
  meta: {
    participants: Array<{ name: string; action: string; ts: number }>;
    attendees: Array<{ name: string; email: string }>;
    captions?: Array<{ speaker: string; text: string; ts: number }>;
  },
  logger: Logger
): Promise<TranscriptionResult> {
  const { transcriptionProvider, transcriptionApiKey, transcriptionLanguage, transcriptionModel, transcriptionTimeoutMs } = config;

  if (!transcriptionApiKey) {
    throw new Error('TRANSCRIPTION_API_KEY is not configured');
  }

  // Extract unique participant names to help the model label speakers
  const participantNames = [
    ...new Set([
      ...meta.participants
        .filter((p) => p.action === 'join')
        .map((p) => p.name.split('\n')[0].trim()),
      ...meta.attendees.map((a) => a.name),
    ]),
  ].filter(Boolean);

  let audioPath: string | undefined;
  try {
    audioPath = await extractAudio(videoPath, logger);

    let utterances: TranscriptUtterance[];
    let durationSeconds: number;

    if (transcriptionProvider === 'deepgram') {
      const result = await transcribeWithDeepgram(
        audioPath,
        participantNames,
        meta.captions ?? [],
        meta.attendees,
        transcriptionLanguage,
        transcriptionModel,
        transcriptionApiKey,
        transcriptionTimeoutMs,
        logger
      );
      utterances = result.utterances;
      durationSeconds = result.durationSeconds;
    } else {
      // Default: openrouter
      const result = await transcribeWithOpenRouter(
        audioPath,
        participantNames,
        transcriptionLanguage,
        transcriptionModel,
        transcriptionApiKey,
        transcriptionTimeoutMs,
        logger
      );
      utterances = result.utterances;
      durationSeconds = result.durationSeconds;
    }

    return {
      provider: transcriptionProvider,
      model: transcriptionModel,
      language: transcriptionLanguage,
      fullText: buildFullText(utterances),
      utterances,
      durationSeconds,
      transcribedAt: new Date().toISOString(),
    };
  } finally {
    if (audioPath) {
      fs.promises.unlink(audioPath).catch(() => {/* non-fatal */});
    }
  }
}
