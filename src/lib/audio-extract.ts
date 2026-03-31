import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';

/**
 * Extract audio from a video file as a mono MP3.
 * Uses stream demux (no re-encode of video) — audio only output.
 * Produces 24kHz mono MP3 at 128kbps — preserves speech detail for accurate transcription.
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
      '-ar', '24000',         // 24kHz — preserves speech harmonics better than 16kHz
      '-ac', '1',             // mono
      '-b:a', '128k',         // 128kbps — retains clarity for transcription models
      '-af', 'highpass=f=80,lowpass=f=8000,loudnorm', // filter noise, normalize volume
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

/**
 * Detect whether an audio file contains actual speech or is effectively silent.
 * Uses ffmpeg's volumedetect filter to measure peak and mean volume.
 * Returns true if the audio has meaningful content above the silence threshold.
 */
export function validateAudioHasContent(audioPath: string, logger: Logger): boolean {
  try {
    // Use execFileSync to avoid shell injection — ffmpeg writes volumedetect to stderr
    // so we capture it via stdio configuration
    let output: string;
    try {
      execFileSync('ffmpeg', ['-i', audioPath, '-af', 'volumedetect', '-f', 'null', '-'], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      output = '';
    } catch (err: any) {
      // ffmpeg writes volumedetect stats to stderr and may exit with code 0 or 1
      // The stderr output contains the data we need regardless of exit code
      output = err?.stderr ?? '';
    }

    // Parse mean_volume and max_volume from ffmpeg output
    const meanMatch = output.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    const maxMatch = output.match(/max_volume:\s*([-\d.]+)\s*dB/);

    const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -91;
    const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : -91;

    logger.info('Audio volume analysis', { meanVolume, maxVolume, audioPath: path.basename(audioPath) });

    // -90 dB is essentially digital silence. Real speech is typically -30 to -10 dB mean.
    // Threshold at -60 dB to catch very quiet recordings while rejecting silence.
    if (meanVolume < -60 && maxVolume < -50) {
      logger.warn('Audio file appears to be silent or near-silent — skipping transcription', {
        meanVolume,
        maxVolume,
        audioPath: path.basename(audioPath),
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.warn('Audio validation failed — proceeding with transcription anyway', { error: (err as Error)?.message });
    return true; // Default to proceeding if validation itself fails
  }
}
