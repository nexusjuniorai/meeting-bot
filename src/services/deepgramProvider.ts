import fs from 'fs';
import axios from 'axios';
import { Logger } from 'winston';
import { TranscriptUtterance } from './transcriptionService';

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
  punctuated_word?: string;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  confidence: number;
  transcript: string;
  speaker: number;
  words: DeepgramWord[];
}

/**
 * Build a speaker label → name map by cross-referencing Deepgram's speaker IDs
 * with the participant names collected from the Google Meet CC DOM scraper.
 *
 * Strategy: Deepgram utterances have start/end times. Caption entries have a ts
 * (epoch ms). We convert caption timestamps to relative seconds from the earliest
 * caption, then vote: for each Deepgram speaker ID, tally which participant name
 * appears most often in overlapping caption segments.
 */
function buildSpeakerMap(
  utterances: DeepgramUtterance[],
  captions: Array<{ speaker: string; text: string; ts: number }>,
  attendees: Array<{ name: string; email: string }>
): Record<number, string> {
  if (captions.length === 0) {
    return {};
  }

  const minTs = Math.min(...captions.map((c) => c.ts));
  const captionsRelative = captions
    .filter((c) => c.speaker && c.speaker !== 'Unknown')
    .map((c) => ({
      speaker: c.speaker,
      tSec: (c.ts - minTs) / 1000,
    }));

  const votes: Record<number, Record<string, number>> = {};

  for (const utt of utterances) {
    if (!votes[utt.speaker]) votes[utt.speaker] = {};
    for (const cap of captionsRelative) {
      if (cap.tSec >= utt.start - 5 && cap.tSec <= utt.end + 5) {
        votes[utt.speaker][cap.speaker] = (votes[utt.speaker][cap.speaker] ?? 0) + 1;
      }
    }
  }

  const speakerMap: Record<number, string> = {};
  for (const [speakerIdStr, nameCounts] of Object.entries(votes)) {
    const speakerId = Number(speakerIdStr);
    const entries = Object.entries(nameCounts);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      speakerMap[speakerId] = entries[0][0];
    }
  }

  return speakerMap;
}

export async function transcribeWithDeepgram(
  audioPath: string,
  participantNames: string[],
  captions: Array<{ speaker: string; text: string; ts: number }>,
  attendees: Array<{ name: string; email: string }>,
  language: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
  logger: Logger
): Promise<{ utterances: TranscriptUtterance[]; durationSeconds: number }> {
  logger.info('Reading audio file for Deepgram transcription', { audioPath });
  const audioBuffer = await fs.promises.readFile(audioPath);

  logger.info('Sending audio to Deepgram', { model, language });

  const params = new URLSearchParams({
    model,
    language,
    diarize: 'true',
    utterances: 'true',
    punctuate: 'true',
  });

  const response = await axios.post(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    audioBuffer,
    {
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/mpeg',
      },
      timeout: timeoutMs,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }
  );

  const deepgramUtterances: DeepgramUtterance[] = response.data?.results?.utterances ?? [];
  if (deepgramUtterances.length === 0) {
    logger.warn('Deepgram returned no utterances');
    return { utterances: [], durationSeconds: 0 };
  }

  const speakerMap = buildSpeakerMap(deepgramUtterances, captions, attendees);

  const usedGenericLabels = new Set<number>();
  const genericLabelMap: Record<number, string> = {};
  let genericCounter = 1;

  const utterances: TranscriptUtterance[] = deepgramUtterances.map((u) => {
    let speakerName = speakerMap[u.speaker];
    if (!speakerName) {
      if (!genericLabelMap[u.speaker]) {
        genericLabelMap[u.speaker] = `Speaker ${genericCounter++}`;
        usedGenericLabels.add(u.speaker);
      }
      speakerName = genericLabelMap[u.speaker];
    }
    return {
      speaker: speakerName,
      text: u.transcript,
      startTime: u.start,
      endTime: u.end,
    };
  });

  const durationSeconds = deepgramUtterances.at(-1)?.end ?? 0;

  return { utterances, durationSeconds };
}
