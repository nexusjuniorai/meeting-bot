import { spawn, ChildProcess } from 'child_process';
import { Logger } from 'winston';
import fs from 'fs';

/**
 * Records audio from PulseAudio virtual_output.monitor using ffmpeg.
 * Captures all audio played through Chrome (including WebRTC from other
 * meeting participants), which getDisplayMedia tab capture misses in
 * headless/Xvfb environments.
 */
export class PulseAudioRecorder {
  private ffmpegProcess: ChildProcess | null = null;
  private outputPath: string;
  private logger: Logger;

  constructor(outputPath: string, logger: Logger) {
    this.outputPath = outputPath;
    this.logger = logger;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ffmpegArgs = [
          '-y',
          '-loglevel', 'warning',
          // Audio input from PulseAudio monitor (captures all Chrome audio output)
          '-f', 'pulse',
          '-ac', '1',
          '-ar', '48000',
          '-i', 'virtual_output.monitor',
          // Encode as high-quality MP3 — ready for transcription without re-encoding
          '-acodec', 'libmp3lame',
          '-ar', '24000',       // 24kHz — preserves speech harmonics
          '-ac', '1',           // mono
          '-b:a', '192k',       // high bitrate for clarity
          '-af', 'highpass=f=80,lowpass=f=8000,loudnorm',
          this.outputPath,
        ];

        const ffmpegEnv = {
          ...process.env,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1001',
        };

        this.logger.info('Starting PulseAudio audio recorder', { outputPath: this.outputPath });

        this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: ffmpegEnv,
        });

        let stderrBuffer = '';
        this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          stderrBuffer += output;
          if (stderrBuffer.length > 4000) stderrBuffer = stderrBuffer.slice(-4000);
          if (output.includes('error') || output.includes('Error')) {
            this.logger.error('PulseAudio recorder ffmpeg error:', output.trim());
          }
        });

        let settled = false;

        this.ffmpegProcess.on('exit', (code, signal) => {
          this.logger.info('PulseAudio recorder exited', { code, signal });
          if (code !== 0 && code !== null && !settled) {
            settled = true;
            reject(new Error(`PulseAudio recorder exited with code ${code}: ${stderrBuffer.slice(-500)}`));
          }
        });

        this.ffmpegProcess.on('error', (error) => {
          this.logger.error('PulseAudio recorder process error:', error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

        // Give ffmpeg time to initialize
        setTimeout(() => {
          if (settled) return;
          if (this.ffmpegProcess && !this.ffmpegProcess.killed && this.ffmpegProcess.exitCode === null) {
            this.logger.info('PulseAudio audio recorder started successfully');
            settled = true;
            resolve();
          } else {
            settled = true;
            reject(new Error('PulseAudio recorder ffmpeg failed to start'));
          }
        }, 2000);
      } catch (error) {
        reject(error);
      }
    });
  }

  async stop(): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.ffmpegProcess) {
        this.logger.warn('No PulseAudio recorder process to stop');
        resolve(null);
        return;
      }

      let resolved = false;

      // Send 'q' to gracefully stop ffmpeg
      try {
        if (this.ffmpegProcess.stdin) {
          this.ffmpegProcess.stdin.write('q\n');
          this.ffmpegProcess.stdin.end();
        }
      } catch {
        this.ffmpegProcess.kill('SIGTERM');
      }

      const timeout = setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
          this.logger.warn('PulseAudio recorder did not exit after 10s, sending SIGTERM');
          this.ffmpegProcess.kill('SIGTERM');
          setTimeout(() => {
            if (this.ffmpegProcess && !this.ffmpegProcess.killed && !resolved) {
              this.ffmpegProcess.kill('SIGKILL');
            }
          }, 5000);
        }
      }, 10000);

      this.ffmpegProcess.on('exit', () => {
        if (!resolved) {
          clearTimeout(timeout);
          this.ffmpegProcess = null;
          resolved = true;
          // Verify the file exists and has content
          try {
            const stat = fs.statSync(this.outputPath);
            if (stat.size > 0) {
              this.logger.info('PulseAudio recording saved', { path: this.outputPath, sizeBytes: stat.size });
              resolve(this.outputPath);
            } else {
              this.logger.warn('PulseAudio recording file is empty');
              resolve(null);
            }
          } catch {
            this.logger.warn('PulseAudio recording file not found after stop');
            resolve(null);
          }
        }
      });

      if (this.ffmpegProcess.killed || this.ffmpegProcess.exitCode !== null) {
        clearTimeout(timeout);
        this.ffmpegProcess = null;
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }
    });
  }
}
