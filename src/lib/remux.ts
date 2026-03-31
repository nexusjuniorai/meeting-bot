import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from 'winston';

/**
 * Remux a raw MediaRecorder WebM into a seekable MP4.
 * Uses stream copy (no re-encode) — fast, zero quality loss.
 * Adds moov atom at the front (faststart) for immediate playback.
 */
export async function remuxToMp4(inputPath: string, logger: Logger): Promise<string> {
  const outputPath = inputPath.replace(/\.(webm|mkv)$/i, '.mp4');

  if (outputPath === inputPath) {
    logger.warn('remuxToMp4: output path equals input path, skipping');
    return inputPath;
  }

  logger.info(`Remuxing ${path.basename(inputPath)} → ${path.basename(outputPath)}`);

  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);

    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    ff.on('close', (code) => {
      if (code === 0) {
        logger.info(`Remux complete → ${path.basename(outputPath)}`);
        resolve();
      } else {
        logger.error('ffmpeg remux failed', { code, stderr: stderr.slice(-500) });
        reject(new Error(`ffmpeg exited ${code}`));
      }
    });

    ff.on('error', reject);
  });

  // Validate output before deleting source to avoid data loss on silent ffmpeg failures
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error(`Remux produced empty or missing output: ${outputPath}`);
  }

  try {
    await fs.promises.unlink(inputPath);
  } catch { /* non-fatal */ }

  return outputPath;
}
