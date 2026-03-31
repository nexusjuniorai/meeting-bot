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

function buildPrompt(participantNames: string[], language: string): string {
  const nameList = participantNames.length > 0
    ? `The known meeting participants are: ${participantNames.join(', ')}.`
    : 'The participant names are unknown.';

  const languageInstruction = language === 'auto'
    ? 'Detect the language spoken and transcribe every spoken word accurately in that language. Do NOT translate.'
    : `Transcribe every spoken word accurately in the original language (${language}). Do NOT translate.`;

  return `You are a meeting transcription assistant. Your task is to transcribe the audio recording and identify each speaker.

${nameList}

Instructions:
- ${languageInstruction}
- Identify each distinct speaker by their voice and assign them a name from the participant list above.
- If a speaker cannot be matched to a known name, label them "Speaker 1", "Speaker 2", etc.
- Group consecutive speech from the same speaker into a single segment.
- Estimate start and end times in seconds from the beginning of the audio.

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
  language: string,
  model: string,
  apiKey: string,
  timeoutMs: number,
  logger: Logger
): Promise<{ utterances: TranscriptUtterance[]; durationSeconds: number }> {
  logger.info('Reading audio file for OpenRouter transcription', { audioPath });
  const audioBuffer = await fs.promises.readFile(audioPath);
  const audioBase64 = audioBuffer.toString('base64');

  const prompt = buildPrompt(participantNames, language);

  logger.info('Sending audio to OpenRouter', { model, language, participants: participantNames });

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
