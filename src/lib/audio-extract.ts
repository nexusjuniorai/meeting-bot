import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';

/**
 * Extract audio from a video file as a mono MP3.
 * Uses stream demux (no re-encode of video) — audio only output.
 * Produces 16kHz mono MP3 at 64kbps (~29MB/hr) — compact for base64 encoding.
 */
export async function extractAudio(inputPath: string, logger: Logger): Promise<string> {
  const outputPath = inputPath.replace(/\.(mp4|webm|mkv)$/i, '_audio.mp3');

  if (outputPath === inputPath) {
    throw new Error(`extractAudio: could not derive output path from ${inputPath}`);
  }

  logger.info(`Extracting audio: ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vn',                  // no video
      '-acodec', 'libmp3lame',
      '-ar', '16000',         // 16kHz sample rate — optimal for speech recognition
      '-ac', '1',             // mono — improves diarization accuracy
      '-b:a', '64k',          // 64kbps bitrate
      outputPath,
    ]);

    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    ff.on('close', (code) => {
      if (code === 0) {
        logger.info(`Audio extraction complete → ${path.basename(outputPath)}`);
        resolve();
      } else {
        logger.error('ffmpeg audio extraction failed', { code, stderr: stderr.slice(-500) });
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });

    ff.on('error', reject);
  });

  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(`Audio extraction produced empty or missing output: ${outputPath}`);
  }

  return outputPath;
}
