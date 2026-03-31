import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import config from '../config';
import { getCorrelationIdLog } from '../util/logger';

const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
stealthPlugin.enabledEvasions.delete('media.codecs');
chromium.use(stealthPlugin);

export type BotType = 'microsoft' | 'google' | 'zoom';

function attachBrowserErrorHandlers(browser: Browser, context: BrowserContext, page: Page, correlationId: string) {
  const log = getCorrelationIdLog(correlationId);

  browser.on('disconnected', () => {
    console.log(`${log} Browser has disconnected!`);
  });

  context.on('close', () => {
    console.log(`${log} Browser has closed!`);
  });

  page.on('crash', (page) => {
    console.error(`${log} Page has crashed! ${page?.url()}`);
  });

  page.on('close', (page) => {
    console.log(`${log} Page has closed! ${page?.url()}`);
  });
}

async function launchBrowserWithTimeout(launchFn: () => Promise<Browser>, timeoutMs: number, correlationId: string): Promise<Browser> {
  let timeoutId: NodeJS.Timeout;
  let finished = false;

  return new Promise((resolve, reject) => {
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!finished) {
        finished = true;
        reject(new Error(`Browser launch timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    // Start launch
    launchFn()
      .then(result => {
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          console.log(`${getCorrelationIdLog(correlationId)} Browser launch function success!`);
          resolve(result);
        }
      })
      .catch(err => {
        console.error(`${getCorrelationIdLog(correlationId)} Error launching browser`, err);
        if (!finished) {
          finished = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
  });
}

export interface BrowserContextOptions {
  /** Base64-encoded Playwright storageState JSON */
  storageStateB64?: string;
}

async function createBrowserContext(url: string, correlationId: string, botType: BotType = 'google', options?: BrowserContextOptions): Promise<Page> {
  const size = { width: 1280, height: 720 };

  // Base browser args used by all bots
  const baseBrowserArgs: string[] = [
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--window-size=${size.width},${size.height}`,
    '--auto-accept-this-tab-capture',
    '--enable-features=MediaRecorder',
    '--enable-audio-service-out-of-process',
    '--autoplay-policy=no-user-gesture-required',
    // Performance flags — reduce startup and idle overhead
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
  ];

  // Fake device args - only for Microsoft Teams
  // Teams needs fake devices to interact with pre-join screen toggles,
  // but actual recording is done via ffmpeg (X11 + PulseAudio)
  const fakeDeviceArgs: string[] = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ];

  // Google Meet and Zoom use browser-based recording (getDisplayMedia + MediaRecorder)
  // and don't need fake devices:
  // - Google Meet: clicks "Continue without microphone and camera"
  // - Zoom: expects "Cannot detect your camera/microphone" notifications
  const browserArgs = botType === 'microsoft'
    ? [...baseBrowserArgs, ...fakeDeviceArgs]
    : baseBrowserArgs;

  // Teams-specific display args: kiosk mode prevents address bar from showing in ffmpeg recording
  // Google Meet and Zoom don't need this since they use tab capture (getDisplayMedia)
  const displayArgs = botType === 'microsoft'
    ? ['--kiosk', '--start-maximized']
    : [];

  console.log(`${getCorrelationIdLog(correlationId)} Launching browser for ${botType} bot (fake devices: ${botType === 'microsoft'})`);

  const browser = await launchBrowserWithTimeout(
    async () => await chromium.launch({
      headless: false,
      args: [
        ...browserArgs,
        ...displayArgs,
      ],
      ignoreDefaultArgs: ['--mute-audio'],
      executablePath: config.chromeExecutablePath,
    }),
    60000,
    correlationId
  );

  const linuxX11UserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

  // Decode base64 storageState if provided (signs in the bot with a Google account)
  let storageState: { cookies: any[]; origins: any[] } | undefined;
  if (options?.storageStateB64) {
    try {
      const json = Buffer.from(options.storageStateB64, 'base64').toString('utf-8');
      storageState = JSON.parse(json);
      console.log(`${getCorrelationIdLog(correlationId)} Loaded storageState from GOOGLE_BOT_AUTH_STATE (${options.storageStateB64.length} chars base64)`);
    } catch (err) {
      console.error(`${getCorrelationIdLog(correlationId)} Failed to decode GOOGLE_BOT_AUTH_STATE — bot will join as guest`, err);
    }
  }

  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: size,
    ignoreHTTPSErrors: true,
    userAgent: linuxX11UserAgent,
    ...(storageState && { storageState }),
    // Record video only in development for debugging
    ...(process.env.NODE_ENV === 'development' && {
      recordVideo: {
        dir: './debug-videos/',
        size: size,
      },
    }),
  });

  // Grant permissions so Teams will play audio (Teams requires this unlike Google Meet)
  await context.grantPermissions(['microphone', 'camera'], { origin: url });

  const page = await context.newPage();

  // Attach common error handlers
  attachBrowserErrorHandlers(browser, context, page, correlationId);

  console.log(`${getCorrelationIdLog(correlationId)} Browser launched successfully!`);

  return page;
}

export default createBrowserContext;
