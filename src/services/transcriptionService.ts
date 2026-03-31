import fs from 'fs';
import { Logger } from 'winston';
import config from '../config';
import { extractAudio, validateAudioHasContent } from '../lib/audio-extract';
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
    botDisplayName?: string;
    audioPath?: string;
  },
  logger: Logger
): Promise<TranscriptionResult> {
  const { transcriptionProvider, transcriptionApiKey, transcriptionLanguage, transcriptionModel, transcriptionTimeoutMs } = config;

  if (!transcriptionApiKey) {
    throw new Error('TRANSCRIPTION_API_KEY is not configured');
  }

  // Build set of bot name patterns to exclude from speaker list
  const botPatterns = ['notetaker', 'screenapp', 'aheadx', 'meeting bot', 'recorder'];
  const isBotName = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (meta.botDisplayName && lower === meta.botDisplayName.toLowerCase()) return true;
    return botPatterns.some((p) => lower.includes(p));
  };

  // Extract unique participant names, excluding the bot itself
  const participantNames = [
    ...new Set([
      ...meta.participants
        .filter((p) => p.action === 'join')
        .map((p) => p.name.split('\n')[0].trim()),
      ...meta.attendees.map((a) => a.name),
    ]),
  ].filter((n) => Boolean(n) && !isBotName(n));

  // Use pre-recorded PulseAudio audio if available, otherwise extract from video
  let audioPath: string | undefined;
  let audioFromPulse = false;
  try {
    if (meta.audioPath && fs.existsSync(meta.audioPath)) {
      logger.info('Using PulseAudio-captured audio for transcription', { audioPath: meta.audioPath });
      audioPath = meta.audioPath;
      audioFromPulse = true;
    } else {
      if (meta.audioPath) {
        logger.warn('PulseAudio audio path provided but file not found — falling back to video extraction', { audioPath: meta.audioPath });
      }
      audioPath = await extractAudio(videoPath, logger);
    }

    // Validate audio has actual content before sending to transcription
    if (!validateAudioHasContent(audioPath, logger)) {
      logger.warn('Audio is silent — returning empty transcription to avoid hallucinated output');
      return {
        provider: transcriptionProvider,
        model: transcriptionModel,
        language: transcriptionLanguage,
        fullText: '',
        utterances: [],
        durationSeconds: 0,
        transcribedAt: new Date().toISOString(),
      };
    }

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
        meta.captions ?? [],
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
    // Clean up extracted audio (but not PulseAudio file — GoogleMeetBot manages its own cleanup)
    if (audioPath && !audioFromPulse) {
      fs.promises.unlink(audioPath).catch(() => {/* non-fatal */});
    }
  }
}
