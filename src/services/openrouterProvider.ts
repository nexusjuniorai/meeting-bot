import fs from 'fs';
import axios from 'axios';
import { Logger } from 'winston';
import { TranscriptUtterance } from './transcriptionService';

interface OpenRouterUtterance {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

function buildCaptionContext(captions: Array<{ speaker: string; text: string; ts: number }>): string {
  if (captions.length === 0) return '';

  const filtered = captions.filter((c) => c.speaker && c.speaker !== 'Unknown');
  if (filtered.length === 0) return '';

  const minTs = Math.min(...filtered.map((c) => c.ts));
  const lines = filtered.map((c) => {
    const tSec = ((c.ts - minTs) / 1000).toFixed(1);
    return `[${tSec}s] ${c.speaker}: ${c.text}`;
  });

  return `\n\nIMPORTANT — The meeting platform captured these live captions during the recording. Use them as ground truth for BOTH the words spoken AND who said them. The captions are accurate for speaker names but may have minor text differences — always prefer what you actually hear in the audio for exact wording, but use these captions to confirm speaker identity and approximate content:\n\n${lines.join('\n')}`;
}

function buildPrompt(participantNames: string[], captions: Array<{ speaker: string; text: string; ts: number }>, language: string): string {
  const nameList = participantNames.length > 0
    ? `The HUMAN meeting participants are: ${participantNames.join(', ')}.`
    : 'The participant names are unknown.';

  const languageInstruction = language === 'auto'
    ? 'Detect the language spoken and transcribe every spoken word accurately in that language. Do NOT translate.'
    : `Transcribe every spoken word accurately in the original language (${language}). Do NOT translate.`;

  const captionContext = buildCaptionContext(captions);

  return `You are a precise meeting transcription assistant. Your ONLY task is to transcribe exactly what is said in the audio — nothing more, nothing less.

${nameList}

CRITICAL RULES:
- ${languageInstruction}
- Transcribe ONLY words that are actually spoken in the audio. Do NOT invent, hallucinate, or fabricate any speech.
- If a section of audio is unclear or silent, skip it. Do NOT guess or fill in words.
- Only attribute speech to participants who actually speak. If only one or two people talk, the transcript should only contain those speakers.
- Do NOT attribute speech to ALL participants just because they are listed. Many participants may be silent listeners.
- There is a recording bot in this meeting that does NOT speak. Never attribute any speech to a bot or notetaker.
- Identify speakers by matching voices to the participant names provided. If you cannot confidently match a voice, use "Speaker 1", "Speaker 2", etc.
- Group consecutive speech from the same speaker into a single segment.
- Estimate start and end times in seconds from the beginning of the audio.
- Accuracy is paramount. It is better to omit unclear words than to guess wrong.
${captionContext}

Return ONLY a valid JSON object in this exact format, with no markdown, no explanation:
{
  "utterances": [
    { "speaker": "Name", "text": "...", "startTime": 0.0, "endTime": 5.2 }
  ],
  "durationSeconds": 0.0
}`;
}

export async function transcribeWithOpenRouter(
  audioPath: string,
  participantNames: string[],
  captions: Array<{ speaker: string; text: string; ts: number }>,
  language: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
  logger: Logger
): Promise<{ utterances: TranscriptUtterance[]; durationSeconds: number }> {
  logger.info('Reading audio file for OpenRouter transcription', { audioPath });
  const audioBuffer = await fs.promises.readFile(audioPath);
  const audioBase64 = audioBuffer.toString('base64');

  const prompt = buildPrompt(participantNames, captions, language);

  logger.info('Sending audio to OpenRouter', {
    model,
    language,
    participants: participantNames,
    captionCount: captions.length,
  });

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: {
                data: audioBase64,
                format: 'mp3',
              },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://aheadx.ai',
        'X-Title': 'AheadX Notetaker',
      },
      timeout: timeoutMs,
    }
  );

  const content: string = response.data?.choices?.[0]?.message?.content ?? '';
  if (!content) {
    throw new Error('OpenRouter returned empty content');
  }

  let parsed: { utterances?: OpenRouterUtterance[]; durationSeconds?: number };
  try {
    parsed = JSON.parse(content);
  } catch {
    logger.error('OpenRouter response is not valid JSON', { content: content.slice(0, 500) });
    throw new Error('OpenRouter response could not be parsed as JSON');
  }

  if (!Array.isArray(parsed.utterances)) {
    logger.error('OpenRouter response missing utterances array', { parsed });
    throw new Error('OpenRouter response missing utterances array');
  }

  const utterances: TranscriptUtterance[] = parsed.utterances.map((u) => ({
    speaker: String(u.speaker ?? 'Unknown'),
    text: String(u.text ?? ''),
    startTime: Number(u.startTime ?? 0),
    endTime: Number(u.endTime ?? 0),
  }));

  return {
    utterances,
    durationSeconds: Number(parsed.durationSeconds ?? 0),
  };
}
