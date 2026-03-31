import { JoinParams } from './AbstractMeetBot';
import { BotStatus, WaitPromise } from '../types';
import config from '../config';
import { UnsupportedMeetingError, WaitingAtLobbyRetryError } from '../error';
import { patchBotStatus } from '../services/botService';
import { handleUnsupportedMeetingError, handleWaitingAtLobbyError, MeetBotBase } from './MeetBotBase';
import { v4 } from 'uuid';
import { IUploader } from '../middleware/disk-uploader';
import { Logger } from 'winston';
import { browserLogCaptureCallback } from '../util/logger';
import { getWaitingPromise } from '../lib/promise';
import { retryActionWithWait } from '../util/resilience';
import { uploadDebugImage } from '../services/bugService';
import createBrowserContext from '../lib/chromium';
import { GOOGLE_LOBBY_MODE_HOST_TEXT, GOOGLE_REQUEST_DENIED, GOOGLE_REQUEST_TIMEOUT } from '../constants';
import { vp9MimeType, webmMimeType } from '../lib/recording';
import { PulseAudioRecorder } from '../lib/pulseAudioRecorder';
import { detectGoogleMeetLobbyPageState } from './google-meet-lobby-state';
import * as path from 'path';
import * as fs from 'fs';

export class GoogleMeetBot extends MeetBotBase {
  private _logger: Logger;
  private _correlationId: string;
  private _meetUrl: string = '';
  constructor(logger: Logger, correlationId: string) {
    super();
    this.slightlySecretId = v4();
    this._logger = logger;
    this._correlationId = correlationId;
  }

  async join({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader }: JoinParams): Promise<void> {
    const _state: BotStatus[] = ['processing'];

    const handleUpload = async () => {
      this._logger.info('Begin recording upload to server', { userId, teamId });
      const uploadResult = await uploader.uploadRecordingToRemoteStorage();
      this._logger.info('Recording upload result', { uploadResult, userId, teamId });
      return uploadResult;
    };

    try {
      const pushState = (st: BotStatus) => _state.push(st);
      await this.joinMeeting({ url, name, bearerToken, teamId, timezone, userId, eventId, botId, uploader, pushState });

      // Finish the upload from the temp video
      const uploadResult = await handleUpload();

      if (_state.includes('finished') && !uploadResult) {
        _state.splice(_state.indexOf('finished'), 1, 'failed');
      }

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
    } catch(error) {
      if (!_state.includes('finished')) 
        _state.push('failed');

      await patchBotStatus({ botId, eventId, provider: 'google', status: _state, token: bearerToken }, this._logger);
      
      if (error instanceof WaitingAtLobbyRetryError) {
        await handleWaitingAtLobbyError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      if (error instanceof UnsupportedMeetingError) {
        await handleUnsupportedMeetingError({ token: bearerToken, botId, eventId, provider: 'google', error }, this._logger);
      }

      throw error;
    }
  }

  /**
   * Navigate through the Google account chooser, password page, and any intermediate
   * consent/confirmation pages until the browser is back on meet.google.com.
   * Handles: account selection → password entry → consent interstitials → redirect back.
   */
  private async navigateGoogleAccountFlow(meetUrl: string, userId?: string, teamId?: string): Promise<void> {
    const maxSteps = 10;
    for (let step = 0; step < maxSteps; step++) {
      const pageUrl = this.page.url();
      const pageBody = await this.page.evaluate(() => document.body.innerText || '');

      this._logger.info(`Account flow step ${step + 1}/${maxSteps}`, {
        pageUrl: pageUrl.slice(0, 120),
        bodySnippet: pageBody.slice(0, 300),
        userId,
        teamId,
      });

      // If we're back on Meet, we're done (use startsWith to avoid matching continue= query param)
      if (pageUrl.startsWith('https://meet.google.com')) {
        this._logger.info('Back on Google Meet after account flow', { userId, teamId });
        return;
      }

      // Login succeeded but Google lost the continue redirect (e.g. myaccount.google.com)
      // — navigate directly to the meeting
      if (!pageUrl.includes('accounts.google.com') && !pageUrl.includes('meet.google.com')) {
        this._logger.info('Login succeeded but landed on wrong page — navigating to meeting URL', { pageUrl: pageUrl.slice(0, 120), userId, teamId });
        await this.page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000);
        continue;
      }

      // Account chooser — select the first account
      if (pageBody.includes('Choose an account') || pageBody.includes('Use another account')) {
        const accountLinks = await this.page.locator('a[data-email], div[data-email]').all();
        if (accountLinks.length > 0) {
          await accountLinks[0].click({ timeout: 5000 });
          this._logger.info('Clicked account in chooser', { userId, teamId });
          await this.page.waitForTimeout(3000);
          continue;
        }
        // Fallback: click the first listed item
        const firstAccount = this.page.locator('li').first();
        if (await firstAccount.count() > 0) {
          await firstAccount.click({ timeout: 5000 });
          this._logger.info('Clicked first list item in account chooser (fallback)', { userId, teamId });
          await this.page.waitForTimeout(3000);
          continue;
        }
      }

      // Password page — fill password and submit
      if (pageBody.includes('Enter your password') || pageBody.includes('Enter a password')) {
        if (!config.googleBotPassword) {
          this._logger.warn('Password page detected but GOOGLE_BOT_PASSWORD is not set — cannot authenticate', { userId, teamId });
          break;
        }
        try {
          const passwordInput = this.page.locator('input[type="password"]').first();
          await passwordInput.fill(config.googleBotPassword, { timeout: 5000 });
          this._logger.info('Filled password field', { userId, teamId });
          await this.page.waitForTimeout(500);

          const nextBtn = this.page.locator('button', { hasText: /^Next$/i }).first();
          if (await nextBtn.count() > 0) {
            await nextBtn.click({ timeout: 5000 });
            this._logger.info('Clicked Next after password entry', { userId, teamId });
          }
          await this.page.waitForTimeout(4000);
          continue;
        } catch(e) {
          this._logger.warn('Failed to fill password', { error: e, userId, teamId });
        }
      }

      // Email/identifier page — fill email if shown (rare, but possible if cookies are fully cleared)
      if (pageBody.includes('Email or phone') || pageBody.includes('Sign in with your Google Account')) {
        if (!config.googleBotEmail) {
          this._logger.warn('Email page detected but GOOGLE_BOT_EMAIL is not set — cannot authenticate', { userId, teamId });
          break;
        }
        try {
          const emailInput = this.page.locator('input[type="email"]').first();
          await emailInput.fill(config.googleBotEmail, { timeout: 5000 });
          this._logger.info('Filled email field', { userId, teamId });
          await this.page.waitForTimeout(500);

          const nextBtn = this.page.locator('button', { hasText: /^Next$/i }).first();
          if (await nextBtn.count() > 0) {
            await nextBtn.click({ timeout: 5000 });
            this._logger.info('Clicked Next after email entry', { userId, teamId });
          }
          await this.page.waitForTimeout(3000);
          continue;
        } catch(e) {
          this._logger.warn('Failed to fill email', { error: e, userId, teamId });
        }
      }

      // "Something went wrong" error — click Restart/Try again
      if (pageBody.includes('Something went wrong') || pageBody.includes('something went wrong')) {
        this._logger.warn('Google showed "Something went wrong" — clicking Restart/Try again', { userId, teamId });
        try {
          const restartBtn = this.page.locator('button, a', { hasText: /Restart|Try again/i }).first();
          if (await restartBtn.count() > 0) {
            await restartBtn.click({ timeout: 5000 });
            await this.page.waitForTimeout(3000);
            continue;
          }
        } catch { /* fall through */ }
        // If no button found, navigate fresh
        await this.page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000);
        continue;
      }

      // Recovery phone/email prompts — skip them
      if (
        pageBody.includes('Add a recovery phone') ||
        pageBody.includes('Don\'t get locked out') ||
        pageBody.includes('Confirm your recovery email') ||
        pageBody.includes('Confirm your recovery phone') ||
        pageBody.includes('Keep your account secure')
      ) {
        this._logger.info('Recovery/security prompt detected — attempting to skip', { userId, teamId });
        const skipTexts = ['Skip', 'Not now', 'Remind me later', 'Done'];
        let skipped = false;
        for (const text of skipTexts) {
          try {
            const btn = this.page.locator('button, a', { hasText: new RegExp(`^${text}$`, 'i') }).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
              await btn.click({ timeout: 5000 });
              this._logger.info(`Clicked "${text}" to skip recovery prompt`, { userId, teamId });
              skipped = true;
              await this.page.waitForTimeout(3000);
              break;
            }
          } catch { /* try next */ }
        }
        if (skipped) continue;
      }

      // 2-Step Verification / CAPTCHA — cannot solve programmatically, bail out
      if (
        pageBody.includes('2-Step Verification') ||
        pageBody.includes('Verify it\'s you') ||
        pageBody.includes('Confirm that it\'s you') ||
        pageBody.includes('This device isn\'t recognized')
      ) {
        this._logger.error('Google 2-Step Verification or identity challenge detected — cannot proceed. Disable 2FA on the bot account.', { userId, teamId });
        break;
      }

      // Consent / confirmation interstitials — click through (but NOT "Next" alone, to avoid looping on password page)
      const consentTexts = ['Continue', 'Allow', 'OK', 'Accept', 'Confirm', 'I agree'];
      let clickedConsent = false;
      for (const text of consentTexts) {
        try {
          const btn = this.page.locator('button, input[type="submit"], input[type="button"]', { hasText: new RegExp(`^${text}$`, 'i') }).first();
          if (await btn.count() > 0 && await btn.isVisible()) {
            await btn.click({ timeout: 5000 });
            this._logger.info(`Clicked "${text}" in account flow interstitial`, { userId, teamId });
            clickedConsent = true;
            await this.page.waitForTimeout(3000);
            break;
          }
        } catch { /* button not clickable — try next */ }
      }
      if (clickedConsent) continue;

      // Nothing we recognized — wait a moment and check again (redirect may be in progress)
      this._logger.warn('Account flow — unrecognized page, waiting for redirect', {
        pageUrl: pageUrl.slice(0, 120),
        bodySnippet: pageBody.slice(0, 300),
        userId,
        teamId,
      });
      await this.page.waitForTimeout(3000);
    }

    // If we exhausted steps and still aren't on Meet, navigate directly
    if (!this.page.url().startsWith('https://meet.google.com')) {
      this._logger.warn('Account flow exhausted — navigating directly to meeting URL', { userId, teamId });
      await this.page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(3000);
    }
  }

  private async joinMeeting({ url, name, teamId, userId, eventId, botId, pushState, uploader }: JoinParams & { pushState(state: BotStatus): void }): Promise<void> {
    this._logger.info('Launching browser...');
    this._meetUrl = url;

    let isSignedIn = !!config.googleBotAuthState;

    this.page = await createBrowserContext(url, this._correlationId, 'google',
      isSignedIn ? { storageStateB64: config.googleBotAuthState } : undefined
    );

    this._logger.info('Navigating to Google Meet URL...');
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    if (!isSignedIn) {
      // Guest flow: dismiss device check to skip camera/mic setup
      const dismissDeviceCheck = async () => {
        try {
          this._logger.info('Clicking Continue without microphone and camera button...');
          await retryActionWithWait(
            'Clicking the "Continue without microphone and camera" button',
            async () => {
              await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).waitFor({ timeout: 30000 });
              await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).click();
            },
            this._logger,
            1,
            15000,
          );
        } catch (dismissError) {
          this._logger.info('Continue without microphone and camera button is probably missing!...');
        }
      };

      await dismissDeviceCheck();
    } else {
      this._logger.info('Bot is signed in with Google account — skipping device check dialog');
    }

    const verifyItIsOnGoogleMeetPage = async (): Promise<'SIGN_IN_PAGE' | 'GOOGLE_MEET_PAGE' | 'UNSUPPORTED_PAGE' | null> => {
      try {
        const detectSignInPage = async () => {
          let result = false;
          const url = await this.page.url();
          if (url.startsWith('https://accounts.google.com/')) {
            this._logger.info('Google Meet bot is on the sign in page...', { userId, teamId });
            result = true;
          }
          const signInPage = await this.page.locator('h1', { hasText: 'Sign in' });
          if (await signInPage.count() > 0 && await signInPage.isVisible()) {
            this._logger.info('Google Meet bot is on the page with "Sign in" heading...', { userId, teamId });
            result = result && true;
          }
          return result;
        };
        const pageUrl = await this.page.url();
        if (!pageUrl.startsWith('https://meet.google.com')) {
          const signInPage = await detectSignInPage();
          return signInPage ? 'SIGN_IN_PAGE' : 'UNSUPPORTED_PAGE';
        }
        return 'GOOGLE_MEET_PAGE';
      } catch(e) {
        this._logger.error('Error verifying if Google Meet bot is on the Google Meet page...', { error: e, message: e?.message });
        return null;
      }
    };

    let googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();

    // --- Signed-in bot landed on accounts.google.com — clear stale cookies and do a fresh login ---
    if (googleMeetPageStatus === 'SIGN_IN_PAGE' && isSignedIn) {
      this._logger.warn('Signed-in bot redirected to Google account page — clearing stale cookies and navigating fresh', { userId, teamId });
      // Clear expired storageState cookies, then navigate to Meet again for a clean sign-in flow
      await this.page.context().clearCookies();
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(2000);

      try {
        await this.navigateGoogleAccountFlow(url, userId, teamId);
      } catch(e) {
        this._logger.warn('Account flow navigation failed', { error: e, userId, teamId });
      }

      // Re-check after account flow
      googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();

      if (googleMeetPageStatus !== 'GOOGLE_MEET_PAGE') {
        // Password login didn't work — fall back to guest mode
        this._logger.warn('Password login failed — clearing cookies and falling back to guest mode', { userId, teamId });
        await this.page.context().clearCookies();
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        isSignedIn = false;

        // Guest flow: dismiss device check
        try {
          await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).waitFor({ timeout: 15000 });
          await this.page.getByRole('button', { name: 'Continue without microphone and camera' }).click();
          this._logger.info('Dismissed device check dialog (guest fallback)');
        } catch { /* may be missing */ }

        // Final verify — if meeting truly requires sign-in, we can't join
        googleMeetPageStatus = await verifyItIsOnGoogleMeetPage();
        if (googleMeetPageStatus !== 'GOOGLE_MEET_PAGE') {
          this._logger.info('Meeting requires sign in even for guests — cannot join', { googleMeetPageStatus, userId, teamId });
          throw new UnsupportedMeetingError('Meeting requires sign in', googleMeetPageStatus);
        }
      }
    } else if (googleMeetPageStatus === 'SIGN_IN_PAGE') {
      // Guest bot on sign-in page — meeting requires auth, can't join
      this._logger.info('Exiting now as meeting requires sign in...', { googleMeetPageStatus, userId, teamId });
      throw new UnsupportedMeetingError('Meeting requires sign in', googleMeetPageStatus);
    }

    if (googleMeetPageStatus === 'UNSUPPORTED_PAGE') {
      this._logger.info('Google Meet bot is on the unsupported page...', { googleMeetPageStatus, userId, teamId });
    }

    if (!isSignedIn) {
      // Guest flow: fill name input
      this._logger.info('Waiting for the input field to be visible...');
      await retryActionWithWait(
        'Waiting for the input field',
        async () => await this.page.waitForSelector('input[type="text"][aria-label="Your name"]', { timeout: 10000 }),
        this._logger,
        3,
        15000,
        async () => {
          await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'text-input-field-wait', userId, this._logger, botId);
        }
      );

      this._logger.info('Filling the input field with the name...');
      await this.page.fill('input[type="text"][aria-label="Your name"]', name ? name : 'ScreenApp Notetaker');
    } else {
      // Signed-in flow: Google account name + avatar are used automatically.
      // Wait briefly for the pre-join screen to render.
      this._logger.info('Signed-in mode — using Google account profile name and avatar');
      await this.page.waitForTimeout(2000);

      // Turn off mic and camera on the pre-join screen if toggles are present
      try {
        const micButton = this.page.locator('button[aria-label*="microphone"], button[data-is-muted]').first();
        if (await micButton.count() > 0) {
          const ariaLabel = await micButton.getAttribute('aria-label');
          if (ariaLabel && !ariaLabel.toLowerCase().includes('unmute')) {
            await micButton.click({ timeout: 3000 });
            this._logger.info('Muted microphone on pre-join screen');
          }
        }
      } catch { /* mic toggle not found — ok */ }

      try {
        const camButton = this.page.locator('button[aria-label*="camera"]').first();
        if (await camButton.count() > 0) {
          const ariaLabel = await camButton.getAttribute('aria-label');
          if (ariaLabel && !ariaLabel.toLowerCase().includes('turn on')) {
            await camButton.click({ timeout: 3000 });
            this._logger.info('Turned off camera on pre-join screen');
          }
        }
      } catch { /* camera toggle not found — ok */ }
    }
    
    await retryActionWithWait(
      'Clicking the "Ask to join" button',
      async () => {
        // --- Handle account chooser redirect before looking for the join button ---
        const currentUrl = this.page.url();
        const bodyText = await this.page.evaluate(() => document.body.innerText || '');

        if (currentUrl.includes('accounts.google.com') || bodyText.includes('Choose an account')) {
          this._logger.warn('Account chooser detected before join click — navigating through Google account flow', { userId, teamId });
          try {
            await this.navigateGoogleAccountFlow(url, userId, teamId);
          } catch(e) {
            this._logger.warn('Failed to recover from account chooser before join click', { error: e, userId, teamId });
          }
          // Throw to retry — page should now be back on Meet with the join button
          throw new Error('Recovered from account chooser — retrying join click');
        }

        // --- Handle pre-join loading state ---
        if (
          currentUrl.startsWith('https://meet.google.com') &&
          (bodyText.includes('Getting ready...') || bodyText.includes("You'll be able to join in just a moment"))
        ) {
          this._logger.info('Pre-join page is still loading — will retry', { userId, teamId });
          throw new Error('Pre-join page still loading');
        }

        // --- Try to click the join button ---
        const possibleTexts = [
          'Ask to join',
          'Join now',
          'Join anyway',
        ];

        let buttonClicked = false;

        for (const text of possibleTexts) {
          try {
            const button = await this.page.locator('button', { hasText: new RegExp(text.toLocaleLowerCase(), 'i') }).first();
            if (await button.count() > 0) {
              await button.click({ timeout: 5000 });
              buttonClicked = true;
              this._logger.info(`Success clicked using "${text}" action...`);
              break;
            }
          } catch(err) {
            this._logger.warn(`Unable to click using "${text}" action...`);
          }
        }

        // Log diagnostics before throwing so we can debug without screenshots
        if (!buttonClicked) {
          this._logger.warn('Join button not found — page diagnostics', {
            pageUrl: this.page.url(),
            bodyTextSnippet: bodyText.slice(0, 500),
            userId,
            teamId,
          });
          throw new Error('Unable to complete the join action...');
        }
      },
      this._logger,
      5,
      10000,
      async () => {
        await uploadDebugImage(await this.page.screenshot({ type: 'png', fullPage: true }), 'ask-to-join-button-click', userId, this._logger, botId);
      }
    );

    // Do this to ensure meeting bot has joined the meeting

    try {
      const wanderingTime = config.joinWaitTime * 60 * 1000; // Give some time to admit the bot

      let waitTimeout: NodeJS.Timeout;
      let waitInterval: NodeJS.Timeout;

      const waitAtLobbyPromise = new Promise<boolean>((resolveWaiting) => {
        waitTimeout = setTimeout(() => {
          clearInterval(waitInterval);
          resolveWaiting(false);
        }, wanderingTime);

        waitInterval = setInterval(async () => {
          try {
            // Always check page state via evaluate — fast, non-blocking, no selector timeouts
            const pageSnapshot = await this.page.evaluate(() => {
              const bodyText = document.body.innerText || '';
              const pageUrl = window.location.href;
              const leaveBtn = document.querySelector(
                'button[aria-label="Leave call"], button[aria-label="Leave"], button[aria-label="End call"]'
              );
              const peopleBtn = document.querySelector('button[aria-label^="People"]');
              const hasJoinActionButton = Array.from(document.querySelectorAll('button')).some((button) => {
                const label = ((button.textContent || button.getAttribute('aria-label') || '') as string).trim();
                return /^(Ask to join|Join now|Join anyway)$/i.test(label);
              });

              return {
                bodyText,
                pageUrl,
                hasLeaveButton: Boolean(leaveBtn),
                peopleButtonLabel: peopleBtn?.getAttribute('aria-label') || '',
                hasJoinActionButton,
              };
            });

            const pageState = detectGoogleMeetLobbyPageState(pageSnapshot, {
              lobbyWaitText: GOOGLE_LOBBY_MODE_HOST_TEXT,
              requestTimeout: GOOGLE_REQUEST_TIMEOUT,
              requestDenied: GOOGLE_REQUEST_DENIED,
            });
            const pageBodyText = pageSnapshot.bodyText;

            this._logger.info('Lobby polling — page state', { pageState, userId, teamId });

            if (pageState === 'ACCOUNT_CHOOSER') {
              this._logger.warn('Bot redirected to Google account chooser during lobby — navigating through Google account flow', { userId, teamId });
              try {
                await this.navigateGoogleAccountFlow(url, userId, teamId);
              } catch(e) {
                this._logger.warn('Failed to recover from account chooser during lobby', { error: e, userId, teamId });
              }
            } else if (pageState === 'PREJOIN_LOADING') {
              // Signed-in Meet prejoin is still rendering — keep polling
            } else if (pageState === 'JOIN_ACTION_REQUIRED') {
              this._logger.info('Lobby polling — prejoin page requires another join action', { userId, teamId });

              const possibleTexts = [
                'Ask to join',
                'Join now',
                'Join anyway',
              ];

              let buttonClicked = false;

              for (const text of possibleTexts) {
                try {
                  const button = this.page.locator('button', { hasText: new RegExp(text, 'i') }).first();
                  if (await button.count() > 0) {
                    await button.click({ timeout: 5000 });
                    buttonClicked = true;
                    this._logger.info(`Lobby polling — clicked "${text}" action...`, { userId, teamId });
                    break;
                  }
                } catch(err) {
                  this._logger.warn(`Lobby polling — unable to click using "${text}" action...`, { userId, teamId });
                }
              }

              if (!buttonClicked) {
                this._logger.warn('Lobby polling — no join action button could be clicked', { userId, teamId });
              }
            } else if (pageState === 'WAITING_FOR_HOST_TO_ADMIT_BOT') {
              // Still waiting — do nothing, keep polling
            } else if (pageState === 'WAITING_REQUEST_TIMEOUT') {
              this._logger.info('Lobby Mode: Google Meet Bot join request timed out...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(false);
            } else if (pageState === 'DENIED') {
              this._logger.info('Google Meet Bot is denied access to the meeting...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(false);
            } else if (pageState === 'IN_CALL') {
              this._logger.info('Google Meet Bot is entering the meeting...', { userId, teamId });
              clearInterval(waitInterval);
              clearTimeout(waitTimeout);
              resolveWaiting(true);
            } else if (pageState === 'UNKNOWN') {
              this._logger.info('Lobby polling — UNKNOWN state, body text snapshot', { bodyText: pageBodyText?.slice(0, 500), userId, teamId });
            }
          } catch(e) {
            this._logger.warn('Lobby polling error (will retry)', { error: e });
          }
        }, 3000);
      });

      const waitingAtLobbySuccess = await waitAtLobbyPromise;
      if (!waitingAtLobbySuccess) {
        const bodyText = await this.page.evaluate(() => document.body.innerText);

        const userDenied = (bodyText || '')?.includes(GOOGLE_REQUEST_DENIED);

        this._logger.error('Cant finish wait at the lobby check', { userDenied, waitingAtLobbySuccess, bodyText });

        // Don't retry lobby errors - if user doesn't admit bot, retrying won't help
        throw new WaitingAtLobbyRetryError('Google Meet bot could not enter the meeting...', bodyText ?? '', false, 0);
      }
    } catch(lobbyError) {
      this._logger.info('Closing the browser on error...', lobbyError);
      await this.page.context().browser()?.close();

      throw lobbyError;
    }

    pushState('joined');

    try {
      this._logger.info('Waiting for the "Got it" button...');
      await this.page.waitForSelector('button:has-text("Got it")', { timeout: 15000 });

      this._logger.info('Going to click all visible "Got it" buttons...');

      let gotItButtonsClicked = 0;
      let previousButtonCount = -1;
      let consecutiveNoChangeCount = 0;
      const maxConsecutiveNoChange = 2; // Stop if button count doesn't change for 2 consecutive iterations

      while (true) {
        const visibleButtons = await this.page.locator('button:visible', {
          hasText: 'Got it',
        }).all();
      
        const currentButtonCount = visibleButtons.length;
        
        if (currentButtonCount === 0) {
          break;
        }
        
        // Check if button count hasn't changed (indicating we might be stuck)
        if (currentButtonCount === previousButtonCount) {
          consecutiveNoChangeCount++;
          if (consecutiveNoChangeCount >= maxConsecutiveNoChange) {
            this._logger.warn(`Button count hasn't changed for ${maxConsecutiveNoChange} iterations, stopping`);
            break;
          }
        } else {
          consecutiveNoChangeCount = 0;
        }
        
        previousButtonCount = currentButtonCount;

        for (const btn of visibleButtons) {
          try {
            await btn.click({ timeout: 5000 });
            gotItButtonsClicked++;
            this._logger.info(`Clicked a "Got it" button #${gotItButtonsClicked}`);
            
            await this.page.waitForTimeout(2000);
          } catch (err) {
            this._logger.warn('Click failed, possibly already dismissed', { error: err });
          }
        }
      
        await this.page.waitForTimeout(2000);
      }
    } catch (error) {
      // Log and ignore this error
      this._logger.info('"Got it" modals might be missing...', { error });
    }

    // Dismiss "Microphone not found" and "Camera not found" notifications if present
    try {
      this._logger.info('Checking for device notifications (microphone/camera)...');
      const hasDeviceNotification = await this.page.evaluate(() => {
        return document.body.innerText.includes('Microphone not found') ||
               document.body.innerText.includes('Make sure your microphone is plugged in') ||
               document.body.innerText.includes('Camera not found') ||
               document.body.innerText.includes('Make sure your camera is plugged in');
      });

      if (hasDeviceNotification) {
        this._logger.info('Found device notification (microphone/camera), attempting to dismiss...');
        // Try to find and click all close buttons
        const closeButtonsCount = await this.page.evaluate(() => {
          const allButtons = Array.from(document.querySelectorAll('button'));
          const closeButtons = allButtons.filter((btn) => {
            const ariaLabel = btn.getAttribute('aria-label');
            const hasCloseIcon = btn.querySelector('svg') !== null;
            return (ariaLabel?.toLowerCase().includes('close') ||
                    ariaLabel?.toLowerCase().includes('dismiss') ||
                    (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
          });

          let clickedCount = 0;
          closeButtons.forEach((btn) => {
            if (btn?.offsetParent !== null) {
              btn.click();
              clickedCount++;
            }
          });
          return clickedCount;
        });

        if (closeButtonsCount > 0) {
          this._logger.info(`Successfully dismissed ${closeButtonsCount} device notification(s)`);
          await this.page.waitForTimeout(1000);
        } else {
          this._logger.warn('Could not find close button for device notifications');
        }
      }
    } catch (error) {
      this._logger.info('Error checking/dismissing device notifications...', { error });
    }

    // Enable closed captions before recording
    await this.enableCaptions();
    await this.page.waitForTimeout(1000); // Give CC container time to appear

    // Recording the meeting page
    this._logger.info('Begin recording...');
    await this.recordMeetingPage({ teamId, eventId, userId, botId, uploader });

    pushState('finished');
  }

  private async enableCaptions(): Promise<void> {
    this._logger.info('Attempting to enable closed captions...');

    // Strategy 1: aria-label based (most stable across UI updates)
    try {
      const ccButton = this.page.locator('button[aria-label="Turn on captions"]');
      if (await ccButton.count() > 0) {
        await ccButton.click({ timeout: 5000 });
        this._logger.info('Captions enabled via aria-label button');
        return;
      }
    } catch (err) {
      this._logger.info('CC aria-label button not found, trying alternatives...');
    }

    // Strategy 2: Keyboard shortcut (works regardless of UI changes)
    try {
      this._logger.info('Trying keyboard shortcut to enable captions (c key)...');
      await this.page.keyboard.press('c');
      await this.page.waitForTimeout(1000);
      // Verify captions appeared by looking for any caption-like container
      const hasCaptions = await this.page.evaluate(() => {
        return !!(
          document.querySelector('[aria-live="polite"][role="region"]') ||
          document.querySelector('[data-is-persistent-banner]') ||
          document.querySelector('div[jsname="YSxPC"]') ||
          // Look for any element with caption-related attributes
          document.querySelector('[aria-label*="caption" i]') ||
          document.querySelector('[aria-label="Turn off captions"]')
        );
      });
      if (hasCaptions) {
        this._logger.info('Captions enabled via keyboard shortcut');
        return;
      }
    } catch (err) {
      this._logger.info('Keyboard shortcut for captions did not work...');
    }

    // Strategy 3: More Options menu → captions toggle
    try {
      const moreOptions = this.page.locator('button[aria-label="More options"]');
      if (await moreOptions.count() > 0) {
        await moreOptions.click({ timeout: 5000 });
        await this.page.waitForTimeout(500);
        // Try multiple selectors for the captions menu item
        const captionsMenuItem = this.page.locator([
          'li[aria-label*="captions" i]',
          'span:has-text("Turn on captions")',
          'span:has-text("Captions")',
          '[role="menuitem"]:has-text("captions")',
        ].join(', ')).first();
        if (await captionsMenuItem.count() > 0) {
          await captionsMenuItem.click({ timeout: 5000 });
          this._logger.info('Captions enabled via More Options menu');
          return;
        }
        // Close the menu if we couldn't find the item
        await this.page.keyboard.press('Escape');
      }
    } catch (err) {
      this._logger.warn('Could not enable captions via More Options menu');
    }

    // Strategy 4: Brute-force search for any CC/captions button
    try {
      const found = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const text = (btn.textContent || '').toLowerCase();
          if ((label.includes('caption') || text.includes('caption')) &&
              !label.includes('turn off') && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (found) {
        this._logger.info('Captions enabled via brute-force button search');
        return;
      }
    } catch (err) {
      this._logger.warn('Brute-force caption button search failed');
    }

    this._logger.warn('Failed to enable captions — all strategies exhausted. Caption scraper will capture nothing.');
  }

  private async recordMeetingPage(
    { teamId, userId, eventId, botId, uploader }: 
    { teamId: string, userId: string, eventId?: string, botId?: string, uploader: IUploader }
  ): Promise<void> {
    const duration = config.maxRecordingDuration * 60 * 1000;
    const inactivityLimit = config.inactivityLimit * 60 * 1000;

    // Capture and send the browser console logs to Node.js context
    this.page?.on('console', async msg => {
      try {
        await browserLogCaptureCallback(this._logger, msg);
      } catch(err) {
        this._logger.info('Playwright chrome logger: Failed to log browser messages...', err?.message);
      }
    });

    await this.page.exposeFunction('screenAppSendData', async (slightlySecretId: string, data: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;

      const buffer = Buffer.from(data, 'base64');
      await uploader.saveDataToTempFile(buffer);
    });

    await this.page.exposeFunction('screenAppMeetEnd', (slightlySecretId: string) => {
      if (slightlySecretId !== this.slightlySecretId) return;
      try {
        this._logger.info('Attempt to end meeting early...');
        waitingPromise.resolveEarly();
      } catch (error) {
        console.error('Could not process meeting end event', error);
      }
    });

    // Start PulseAudio audio recorder (captures WebRTC audio that getDisplayMedia misses)
    let pulseAudioRecorder: PulseAudioRecorder | null = null;
    const audioRecordingPath = path.join(process.cwd(), 'dist', '_tempvideo', userId, `${botId || 'audio'}_pulse_audio.mp3`);
    try {
      await fs.promises.mkdir(path.dirname(audioRecordingPath), { recursive: true });

      // Diagnostic: check PulseAudio state before starting recorder
      try {
        const { execFileSync } = await import('child_process');
        const pactlInfo = execFileSync('pactl', ['info'], { encoding: 'utf-8', timeout: 5000 });
        const defaultSink = pactlInfo.split('\n').find(l => l.includes('Default Sink'))?.trim() || 'unknown';
        const sources = execFileSync('pactl', ['list', 'sources', 'short'], { encoding: 'utf-8', timeout: 5000 }).trim();
        const sinkInputs = execFileSync('pactl', ['list', 'sink-inputs', 'short'], { encoding: 'utf-8', timeout: 5000 }).trim();
        this._logger.info('PulseAudio diagnostics', { defaultSink, sources, sinkInputs: sinkInputs || '(none)' });
      } catch(e) {
        this._logger.warn('PulseAudio diagnostics failed', { error: (e as Error)?.message });
      }

      pulseAudioRecorder = new PulseAudioRecorder(audioRecordingPath, this._logger);
      await pulseAudioRecorder.start();
    } catch (err) {
      this._logger.warn('PulseAudio recorder failed to start — will fall back to extracting audio from video', { error: (err as Error)?.message });
      pulseAudioRecorder = null;
    }

    // Caption and participant tracking arrays (populated from browser context)
    const captions: Array<{ speaker: string; text: string; ts: number }> = [];
    const participantEvents: Array<{ name: string; action: 'join' | 'leave'; ts: number }> = [];

    await this.page.exposeFunction('screenAppSendCaption', (raw: string) => {
      try {
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          captions.push(...entries);
        }
      } catch (err) {
        this._logger.warn('Failed to parse caption data', { error: err });
      }
    });

    await this.page.exposeFunction('screenAppSendParticipant', (raw: string) => {
      try {
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          participantEvents.push(...entries);
        }
      } catch (err) {
        this._logger.warn('Failed to parse participant data', { error: err });
      }
    });

    // Inject the MediaRecorder code into the browser context using page.evaluate
    await this.page.evaluate(
      async ({ teamId, duration, inactivityLimit, userId, slightlySecretId, activateInactivityDetectionAfter, activateInactivityDetectionAfterMinutes, primaryMimeType, secondaryMimeType }: 
      { teamId:string, userId: string, duration: number, inactivityLimit: number, slightlySecretId: string, activateInactivityDetectionAfter: string, activateInactivityDetectionAfterMinutes: number, primaryMimeType: string, secondaryMimeType: string }) => {
        let timeoutId: NodeJS.Timeout;
        let inactivityParticipantDetectionTimeout: NodeJS.Timeout;
        let inactivitySilenceDetectionTimeout: NodeJS.Timeout;
        let isOnValidGoogleMeetPageInterval: NodeJS.Timeout;

        const sendChunkToServer = async (chunk: ArrayBuffer) => {
          function arrayBufferToBase64(buffer: ArrayBuffer) {
            let binary = '';
            const bytes = new Uint8Array(buffer);
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
          }
          const base64 = arrayBufferToBase64(chunk);
          await (window as any).screenAppSendData(slightlySecretId, base64);
        };

        async function startRecording() {
          console.log('Will activate the inactivity detection after', activateInactivityDetectionAfter);

          // Check for the availability of the mediaDevices API
          if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            console.error('MediaDevices or getDisplayMedia not supported in this browser.');
            return;
          }
          
          const stream: MediaStream = await (navigator.mediaDevices as any).getDisplayMedia({
            video: true,
            audio: {
              autoGainControl: false,
              channels: 2,
              channelCount: 2,
              echoCancellation: false,
              noiseSuppression: false,
              sampleRate: 48000,
              sampleSize: 16,
            },
            preferCurrentTab: true,
          });

          // Check if we actually got audio tracks
          const audioTracks = stream.getAudioTracks();
          const hasAudioTracks = audioTracks.length > 0;
          
          if (!hasAudioTracks) {
            console.warn('No audio tracks available for silence detection. Will rely only on presence detection.');
          }

          let options: MediaRecorderOptions = {};
          if (MediaRecorder.isTypeSupported(primaryMimeType)) {
            console.log(`Media Recorder will use ${primaryMimeType} codecs...`);
            options = { mimeType: primaryMimeType };
          }
          else {
            console.warn(`Media Recorder did not find primary mime type codecs ${primaryMimeType}, Using fallback codecs ${secondaryMimeType}`);
            options = { mimeType: secondaryMimeType };
          }

          const mediaRecorder = new MediaRecorder(stream, { ...options, audioBitsPerSecond: 128_000 });

          mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            if (!event.data.size) {
              console.warn('Received empty chunk...');
              return;
            }
            try {
              const arrayBuffer = await event.data.arrayBuffer();
              sendChunkToServer(arrayBuffer);
            } catch (error) {
              console.error('Error uploading chunk:', error);
            }
          };

          // Start recording with 2-second intervals
          const chunkDuration = 2000;
          mediaRecorder.start(chunkDuration);

          let dismissModalsInterval: NodeJS.Timeout;
          let lastDimissError: Error | null = null;

          const stopTheRecording = async () => {
            mediaRecorder.stop();
            stream.getTracks().forEach((track) => track.stop());

            // Cleanup recording timer
            clearTimeout(timeoutId);

            // Cancel the perpetural checks
            if (inactivityParticipantDetectionTimeout) {
              clearTimeout(inactivityParticipantDetectionTimeout);
            }
            if (inactivitySilenceDetectionTimeout) {
              clearTimeout(inactivitySilenceDetectionTimeout);
            }

            if (loneTest) {
              clearTimeout(loneTest);
            }

            if (isOnValidGoogleMeetPageInterval) {
              clearInterval(isOnValidGoogleMeetPageInterval);
            }

            if (dismissModalsInterval) {
              clearInterval(dismissModalsInterval);
              if (lastDimissError && lastDimissError instanceof Error) {
                console.error('Error dismissing modals:', { lastDimissError, message: lastDimissError?.message });
              }
            }

            // Begin browser cleanup
            (window as any).screenAppMeetEnd(slightlySecretId);
          };

          let loneTest: NodeJS.Timeout;
          let detectionFailures = 0;
          let loneTestDetectionActive = true;
          const maxDetectionFailures = 10; // Track up to 10 consecutive failures
          let lastBadgeLogTime = 0; // Track last time we logged badge count

          function detectLoneParticipantResilient(): void {
            const re = /^[0-9]+$/;

            function getContributorsCount(): number | undefined {
              function findPeopleButton() {
                try {
                  // 1. Try to locate using attribute "starts with"
                  let btn: Element | null | undefined = document.querySelector('button[aria-label^="People -"]');
                  if (btn) return btn;

                  // 2. Try to locate using attribute "contains"
                  btn = document.querySelector('button[aria-label*="People"]');
                  if (btn) return btn;

                  // 3. Try via aria-labelledby pointing to element with "People" text
                  const allBtns = Array.from(document.querySelectorAll('button[aria-labelledby]'));
                  btn = allBtns.find(b => {
                    const labelledBy = b.getAttribute('aria-labelledby');
                    if (labelledBy) {
                      const labelElement = document.getElementById(labelledBy);
                      if (labelElement && labelElement.textContent?.trim() === 'People') {
                        return true;
                      }
                    }
                    return false;
                  });
                  if (btn) return btn;

                  // 4. Try via regex on aria-label (for more complex patterns)
                  const allBtnsWithLabel = Array.from(document.querySelectorAll('button[aria-label]'));
                  btn = allBtnsWithLabel.find(b => {
                    const label = b.getAttribute('aria-label');
                    return label && /^People - \d+ joined$/.test(label);
                  });
                  if (btn) return btn;

                  // 5. Fallback: Look for button with a child icon containing "people"
                  btn = allBtnsWithLabel.find(b =>
                    Array.from(b.querySelectorAll('i')).some(i =>
                      i.textContent && i.textContent.trim() === 'people'
                    )
                  );
                  if (btn) return btn;

                  // 6. Not found
                  return null;
                } catch (error) {
                  console.log('Error finding people button:', error);
                  return null;
                }
              }

              // Find participant count badge near People button (doesn't require opening panel)
              try {
                const peopleBtn = findPeopleButton();
                // console.log('[Detection] People button found:', !!peopleBtn);

                if (peopleBtn) {
                  // Search INSIDE the button (descendants) and nearby (parent container)
                  const searchRoots = [
                    peopleBtn, // Search inside button itself
                    peopleBtn.parentElement,
                    peopleBtn.parentElement?.parentElement
                  ].filter(Boolean);

                  // console.log('[Detection] Searching', searchRoots.length, 'containers');

                  for (const searchRoot of searchRoots) {
                    if (!searchRoot) continue;

                    // Method 1: Look for data-avatar-count attribute (most reliable)
                    const avatarSpan = searchRoot.querySelector('[data-avatar-count]');
                    if (avatarSpan) {
                      const countAttr = avatarSpan.getAttribute('data-avatar-count');
                      // console.log('[Detection] Method 1 SUCCESS - data-avatar-count:', countAttr);
                      const count = Number(countAttr);
                      if (!isNaN(count) && count > 0) {
                        return count;
                      }
                    }

                    // Method 2: Fallback - Look for number in badge div
                    const badgeDiv = searchRoot.querySelector('div.egzc7c') as HTMLElement;
                    if (badgeDiv) {
                      const text = ((badgeDiv.innerText || badgeDiv.textContent) ?? '').trim();
                      if (text.length > 0 && text.length <= 3 && re.test(text)) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 2 SUCCESS - Badge text:', text);
                          return count;
                        }
                      }
                    }
                  }

                  // Method 3: Last resort - search for short numbers in People button area
                  const mainSearchRoot = peopleBtn.parentElement?.parentElement || peopleBtn;
                  const allDivs = Array.from(mainSearchRoot.querySelectorAll('div'));
                  for (const div of allDivs) {
                    const text = ((div as HTMLElement).innerText || div.textContent || '').trim();
                    if (text.length > 0 && text.length <= 3 && re.test(text)) {
                      const isVisible = (div as HTMLElement).offsetParent !== null;
                      if (isVisible) {
                        const count = Number(text);
                        if (!isNaN(count) && count > 0) {
                          // console.log('[Detection] Method 3 SUCCESS - Found number:', count);
                          return count;
                        }
                      }
                    }
                  }
                  // console.log('[Detection] All methods failed to find count');
                } else {
                  // console.log('[Detection] People button NOT found');
                }
              } catch (error) {
                console.log('Error finding participant badge:', error);
              }

              return undefined;
            }
          
            function retryWithBackoff(): void {
              loneTest = setTimeout(function check() {
                if (!loneTestDetectionActive) {
                  if (loneTest) {
                    clearTimeout(loneTest);
                  }
                  return;
                }
                let contributors: number | undefined;
                try {
                  contributors = getContributorsCount();

                  // Log participant count once per minute
                  if (typeof contributors !== 'undefined') {
                    const now = Date.now();
                    if (now - lastBadgeLogTime > 60000) {
                      console.log('Participant detection check - Count:', contributors);
                      lastBadgeLogTime = now;
                    }
                  }

                  if (typeof contributors === 'undefined') {
                    detectionFailures++;
                    console.warn('Meet participant detection failed, retrying. Failure count:', detectionFailures);
                    // Log for debugging
                    if (detectionFailures >= maxDetectionFailures) {
                      console.log('Persistent detection failures:', { bodyText: `${document.body.innerText?.toString()}` });
                      loneTestDetectionActive = false;
                    }
                    retryWithBackoff();
                    return;
                  }
                  detectionFailures = 0;
                  if (contributors < 2) {
                    console.log('Bot is alone, ending meeting.');
                    loneTestDetectionActive = false;
                    stopTheRecording();
                    return;
                  }
                } catch (err) {
                  detectionFailures++;
                  console.error('Detection error:', err, detectionFailures);
                  retryWithBackoff();
                  return;
                }
                retryWithBackoff();
              }, 5000);
            }
          
            retryWithBackoff();
          }

          const detectIncrediblySilentMeeting = () => {
            // Only run silence detection if we have audio tracks
            if (!hasAudioTracks) {
              console.warn('Skipping silence detection - no audio tracks available. This may be due to browser permissions or Google Meet audio sharing settings.');
              console.warn('Meeting will rely on presence detection and max duration timeout.');
              return;
            }

            try {
              const audioContext = new AudioContext();
              const mediaSource = audioContext.createMediaStreamSource(stream);
              const analyser = audioContext.createAnalyser();

              /* Use a value suitable for the given use case of silence detection
                 |
                 |____ Relatively smaller FFT size for faster processing and less sampling
              */
              analyser.fftSize = 256;

              mediaSource.connect(analyser);

              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              
              // Sliding silence period
              let silenceDuration = 0;
              let totalChecks = 0;
              let audioActivitySum = 0;
              let lastActivityLogTime = 0;

              // Audio gain/volume
              const silenceThreshold = 10;

              let monitor = true;

              const monitorSilence = () => {
                try {
                  analyser.getByteFrequencyData(dataArray);

                  const audioActivity = dataArray.reduce((a, b) => a + b) / dataArray.length;
                  audioActivitySum += audioActivity;
                  totalChecks++;

                  // Log silence detection status once per minute
                  const now = Date.now();
                  if (now - lastActivityLogTime > 60000) {
                    const avgActivity = (audioActivitySum / totalChecks).toFixed(2);
                    console.log('Silence detection check - Avg:', avgActivity, 'Current:', audioActivity.toFixed(2), 'Threshold:', silenceThreshold);
                    lastActivityLogTime = now;
                  }

                  if (audioActivity < silenceThreshold) {
                    silenceDuration += 100; // Check every 100ms
                    if (silenceDuration >= inactivityLimit) {
                        console.warn('Detected silence in Google Meet and ending the recording on team:', userId, teamId);
                        console.log('Silence detection stats - Avg audio activity:', (audioActivitySum / totalChecks).toFixed(2), 'Checks performed:', totalChecks);
                        monitor = false;
                        stopTheRecording();
                    }
                  } else {
                    silenceDuration = 0;
                  }

                  if (monitor) {
                    // Recursively queue the next check
                    setTimeout(monitorSilence, 100);
                  }
                } catch (error) {
                  console.error('Error in silence monitoring:', error);
                  console.warn('Silence detection failed - will rely on presence detection and max duration timeout.');
                  // Stop monitoring on error
                  monitor = false;
                }
              };

              // Go silence monitor
              monitorSilence();
            } catch (error) {
              console.error('Failed to initialize silence detection:', error);
              console.warn('Silence detection initialization failed - will rely on presence detection and max duration timeout.');
            }
          };

          /**
           * Perpetual checks for inactivity detection
           */
          inactivityParticipantDetectionTimeout = setTimeout(() => {
            detectLoneParticipantResilient();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          inactivitySilenceDetectionTimeout = setTimeout(() => {
            detectIncrediblySilentMeeting();
          }, activateInactivityDetectionAfterMinutes * 60 * 1000);

          const detectModalsAndDismiss = () => {
            let dismissModalErrorCount = 0;
            const maxDismissModalErrorCount = 10;
            dismissModalsInterval = setInterval(() => {
              try {
                const buttons = document.querySelectorAll('button');
                const dismissButtons = Array.from(buttons).filter((button) => button?.offsetParent !== null && button?.innerText?.includes('Got it'));
                if (dismissButtons.length > 0) {
                  console.log('Found "Got it" button, clicking it...', dismissButtons[0]);
                  dismissButtons[0].click();
                }

                // Dismiss "Microphone not found" and "Camera not found" notifications
                const bodyText = document.body.innerText;
                if (bodyText.includes('Microphone not found') ||
                    bodyText.includes('Make sure your microphone is plugged in') ||
                    bodyText.includes('Camera not found') ||
                    bodyText.includes('Make sure your camera is plugged in')) {
                  console.log('Found device notification (microphone/camera), attempting to dismiss...');
                  // Look for close button (X) near the notification
                  const allButtons = Array.from(document.querySelectorAll('button'));
                  const closeButtons = allButtons.filter((btn) => {
                    const ariaLabel = btn.getAttribute('aria-label');
                    const hasCloseIcon = btn.querySelector('svg') !== null;
                    // Look for close/dismiss buttons
                    return (ariaLabel?.toLowerCase().includes('close') ||
                            ariaLabel?.toLowerCase().includes('dismiss') ||
                            (hasCloseIcon && btn?.offsetParent !== null && btn.innerText === ''));
                  });

                  // Click all visible close buttons to dismiss all notifications
                  closeButtons.forEach((btn) => {
                    if (btn?.offsetParent !== null) {
                      console.log('Clicking close button for device notification...');
                      btn.click();
                    }
                  });
                }
              } catch(error) {
                lastDimissError = error;
                dismissModalErrorCount += 1;
                if (dismissModalErrorCount > maxDismissModalErrorCount) {
                  console.error(`Failed to detect and dismiss "Got it" modals ${maxDismissModalErrorCount} times, will stop trying...`);
                  clearInterval(dismissModalsInterval);
                }
              }
            }, 2000);
          };

          const detectMeetingIsOnAValidPage = () => {
            // Simple check to verify we're still on a supported Google Meet page
            let nonMeetPageCount = 0;

            const isOnValidGoogleMeetPage = () => {
              try {
                // Check if we're still on a Google Meet URL
                const currentUrl = window.location.href;
                if (!currentUrl.includes('meet.google.com')) {
                  nonMeetPageCount++;
                  // Give account chooser redirects a grace period (3 checks = 30s) for recovery
                  if (currentUrl.includes('accounts.google.com') && nonMeetPageCount <= 3) {
                    console.warn(`Account chooser redirect during recording (attempt ${nonMeetPageCount}/3) — waiting for recovery`);
                    return true;
                  }
                  console.warn('No longer on Google Meet page - URL changed to:', currentUrl);
                  return false;
                }

                // Reset counter when we're back on Meet
                nonMeetPageCount = 0;

                const currentBodyText = document.body.innerText;
                if (currentBodyText.includes('You\'ve been removed from the meeting')) {
                  console.warn('Bot was removed from the meeting - ending recording on team:', userId, teamId);
                  return false;
                }

                if (currentBodyText.includes('No one responded to your request to join the call')) {
                  console.warn('Bot was not admitted to the meeting - ending recording on team:', userId, teamId);
                  return false;
                }

                // Check for basic Google Meet UI elements
                const hasMeetElements = document.querySelector('button[aria-label="People"]') !== null ||
                                      document.querySelector('button[aria-label="Leave call"]') !== null;

                if (!hasMeetElements) {
                  console.warn('Google Meet UI elements not found - page may have changed state');
                  return false;
                }

                return true;
              } catch (error) {
                console.error('Error checking page validity:', error);
                return false;
              }
            };

            // check if we're still on a valid Google Meet page
            isOnValidGoogleMeetPageInterval = setInterval(() => {
              if (!isOnValidGoogleMeetPage()) {
                console.log('Google Meet page state changed - ending recording on team:', userId, teamId);
                clearInterval(isOnValidGoogleMeetPageInterval);
                stopTheRecording();
              }
            }, 10000);
          };

          detectModalsAndDismiss();

          // Caption scraper — observes the CC container for new caption segments.
          // Uses a polling approach to find the container (it may appear after CC is enabled).
          const startCaptionScraper = () => {
            let retryCount = 0;
            const maxRetries = 15; // Try for ~30 seconds
            let scraperAttached = false;

            const findCaptionContainer = (): Element | null => {
              // Strategy 1: aria-live polite region (ARIA standard — most resilient)
              let container = document.querySelector('[aria-live="polite"][role="region"]');
              if (container) { console.log('Caption container found via aria-live region'); return container; }

              // Strategy 2: data-is-persistent-banner (Google Meet banner area)
              container = document.querySelector('[data-is-persistent-banner]');
              if (container) { console.log('Caption container found via persistent-banner'); return container; }

              // Strategy 3: jsname-based (may break with Google UI updates)
              container = document.querySelector('[jsname="YSxPC"]');
              if (container) { console.log('Caption container found via jsname'); return container; }

              // Strategy 4: Look for "Turn off captions" button and find the caption area near it
              const turnOffBtn = document.querySelector('button[aria-label="Turn off captions"]');
              if (turnOffBtn) {
                // Captions are on — look for the bottom area where captions render
                // Google Meet renders captions in a container near the bottom of the meeting view
                const candidates = document.querySelectorAll('div[style*="bottom"]');
                for (const c of candidates) {
                  const text = (c as HTMLElement).innerText?.trim();
                  if (text && text.length > 0 && text.length < 500) {
                    console.log('Caption container found via proximity to CC button');
                    return c;
                  }
                }
              }

              return null;
            };

            const attachScraper = (container: Element) => {
              if (scraperAttached) return;
              scraperAttached = true;

              console.log('Caption scraper attached to container');
              const seenTexts = new Set<string>();

              // Known UI chrome that the CC settings bar injects into innerText
              const CC_UI_NOISE = /^(language|English|closed_caption|Live captions|format_size|Font size|circle|Font color|settings|Open caption settings|Turn off captions|Turn on captions)\s*/i;

              let loggedContainerOnce = false;

              const extractCaptions = () => {
                try {
                  const batch: Array<{ speaker: string; text: string; ts: number }> = [];

                  // Log the container HTML once to help debug selector issues
                  if (!loggedContainerOnce) {
                    console.log('Caption container tag:', container.tagName, 'classes:', container.className);
                    console.log('Caption container innerText (first 500):', (container as HTMLElement).innerText?.slice(0, 500));
                    loggedContainerOnce = true;
                  }

                  // Strategy A: Look for structured caption elements with speaker info
                  const speakerElements = container.querySelectorAll(
                    '[data-speaker-id], [jsname="bkEvMb"]'
                  );

                  if (speakerElements.length > 0) {
                    speakerElements.forEach((speakerEl) => {
                      const speaker = (speakerEl as HTMLElement).innerText?.trim() || 'Unknown';
                      const parentLine = speakerEl.closest('div[data-speaker-id]') ||
                                         speakerEl.parentElement?.parentElement;
                      if (!parentLine) return;

                      const spans = parentLine.querySelectorAll('span');
                      let text = '';
                      if (spans.length > 0) {
                        text = Array.from(spans)
                          .map((s) => (s as HTMLElement).innerText?.trim())
                          .filter(Boolean)
                          .join(' ');
                        if (text.startsWith(speaker)) {
                          text = text.slice(speaker.length).trim();
                        }
                      } else {
                        text = (parentLine as HTMLElement).innerText?.trim() || '';
                        if (text.startsWith(speaker)) {
                          text = text.slice(speaker.length).trim();
                        }
                      }

                      if (text && !seenTexts.has(`${speaker}:${text}`)) {
                        seenTexts.add(`${speaker}:${text}`);
                        batch.push({ speaker, text, ts: Date.now() });
                      }
                    });
                  }

                  // Strategy B: Fallback — parse child divs, but filter out CC settings UI
                  if (batch.length === 0) {
                    const childDivs = container.querySelectorAll(':scope > div, :scope > div > div');
                    childDivs.forEach((div) => {
                      // Skip UI control elements (buttons, settings, toolbars)
                      if ((div as HTMLElement).querySelector('button, [role="toolbar"], [role="menu"]')) return;
                      const ariaRole = div.getAttribute('role');
                      if (ariaRole === 'toolbar' || ariaRole === 'menu' || ariaRole === 'menubar') return;

                      const fullText = (div as HTMLElement).innerText?.trim();
                      if (!fullText || fullText.length <= 3) return;

                      // Strip known CC UI chrome prefix from the text
                      let cleanText = fullText;
                      // Remove the well-known settings bar text block
                      const settingsEnd = cleanText.indexOf('Open caption settings');
                      if (settingsEnd !== -1) {
                        cleanText = cleanText.slice(settingsEnd + 'Open caption settings'.length).trim();
                      }
                      // Also strip individual UI noise tokens at the start
                      while (CC_UI_NOISE.test(cleanText)) {
                        cleanText = cleanText.replace(CC_UI_NOISE, '').trim();
                      }

                      if (!cleanText || cleanText.length <= 3) return;

                      // Try to split "Speaker Name\nCaption text" pattern
                      const lines = cleanText.split('\n');
                      let speaker = 'Unknown';
                      let text = cleanText;
                      if (lines.length >= 2) {
                        const possibleSpeaker = lines[0].trim();
                        if (possibleSpeaker.length > 0 && possibleSpeaker.length < 50 && !possibleSpeaker.includes('.')) {
                          speaker = possibleSpeaker;
                          text = lines.slice(1).join(' ').trim();
                        }
                      }

                      if (text && !seenTexts.has(`${speaker}:${text}`)) {
                        seenTexts.add(`${speaker}:${text}`);
                        batch.push({ speaker, text, ts: Date.now() });
                      }
                    });
                  }

                  if (batch.length > 0) {
                    (window as any).screenAppSendCaption(JSON.stringify(batch));
                  }
                } catch (err) {
                  console.error('Caption scraper extraction error:', err);
                }
              };

              // Use MutationObserver for real-time capture
              const observer = new MutationObserver(extractCaptions);
              observer.observe(container, { childList: true, subtree: true, characterData: true });

              // Also poll periodically in case MutationObserver misses updates
              setInterval(extractCaptions, 2000);
            };

            // Poll for the caption container (it may not exist immediately after enabling CC)
            const pollForContainer = () => {
              const container = findCaptionContainer();
              if (container) {
                attachScraper(container);
                return;
              }

              retryCount++;
              if (retryCount < maxRetries) {
                setTimeout(pollForContainer, 2000);
              } else {
                console.warn('Caption container not found after ' + maxRetries + ' retries — CC may not be enabled or selectors have changed');
              }
            };

            try {
              pollForContainer();
            } catch (err) {
              console.error('Failed to start caption scraper:', err);
            }
          };

          // Participant tracker — polls the People panel for join/leave events
          const startParticipantTracker = () => {
            const knownParticipants = new Set<string>();

            const pollParticipants = () => {
              try {
                // Try to read participant names from the People panel (if open)
                // or from participant avatars/labels in the call view
                const names = new Set<string>();

                // Method 1: People panel list items
                const listItems = document.querySelectorAll('[data-participant-id], [data-requested-participant-id]');
                listItems.forEach((item) => {
                  const name = (item as HTMLElement).innerText?.trim()?.split('\\n')[0];
                  if (name && name.length > 0 && name.length < 100) {
                    names.add(name);
                  }
                });

                // Method 2: Participant name labels visible in the call grid
                if (names.size === 0) {
                  const nameLabels = document.querySelectorAll('[data-self-name], [jsname="nZvhOc"]');
                  nameLabels.forEach((label) => {
                    const name = (label as HTMLElement).innerText?.trim();
                    if (name && name.length > 0 && name.length < 100) {
                      names.add(name);
                    }
                  });
                }

                const batch: Array<{ name: string; action: 'join' | 'leave'; ts: number }> = [];

                // Detect joins
                names.forEach((name) => {
                  if (!knownParticipants.has(name)) {
                    knownParticipants.add(name);
                    batch.push({ name, action: 'join', ts: Date.now() });
                  }
                });

                // Detect leaves
                knownParticipants.forEach((name) => {
                  if (!names.has(name)) {
                    knownParticipants.delete(name);
                    batch.push({ name, action: 'leave', ts: Date.now() });
                  }
                });

                if (batch.length > 0) {
                  (window as any).screenAppSendParticipant(JSON.stringify(batch));
                }
              } catch (err) {
                console.error('Participant tracker error:', err);
              }
            };

            setInterval(pollParticipants, 4000);
            // Initial poll
            pollParticipants();
          };

          startCaptionScraper();
          startParticipantTracker();

          detectMeetingIsOnAValidPage();
          
          // Cancel this timeout when stopping the recording
          // Stop recording after `duration` minutes upper limit
          timeoutId = setTimeout(async () => {
            stopTheRecording();
          }, duration);
        }

        // Start the recording
        await startRecording();
      },
      { 
        teamId,
        duration,
        inactivityLimit,
        userId,
        slightlySecretId: this.slightlySecretId,
        activateInactivityDetectionAfterMinutes: config.activateInactivityDetectionAfter,
        activateInactivityDetectionAfter: new Date(new Date().getTime() + config.activateInactivityDetectionAfter * 60 * 1000).toISOString(),
        primaryMimeType: webmMimeType,
        secondaryMimeType: vp9MimeType
      }
    );
  
    this._logger.info('Waiting for recording duration', config.maxRecordingDuration, 'minutes...');

    // Monitor for account chooser redirects during recording and recover
    const recordingRedirectMonitor = setInterval(async () => {
      try {
        const currentUrl = this.page.url();
        if (!currentUrl.startsWith('https://meet.google.com') && (currentUrl.includes('accounts.google.com') || currentUrl.includes('myaccount.google.com'))) {
          this._logger.warn('Account chooser redirect during recording — attempting recovery', { currentUrl: currentUrl.slice(0, 120), userId, teamId });
          await this.navigateGoogleAccountFlow(this._meetUrl, userId, teamId);
        }
      } catch(e) {
        // Page may be closed — ignore
      }
    }, 5000);

    const processingTime = 0.2 * 60 * 1000;
    const waitingPromise: WaitPromise = getWaitingPromise(processingTime + duration);

    waitingPromise.promise.then(async () => {
      clearInterval(recordingRedirectMonitor);
      // Stop PulseAudio recorder and get the audio file path
      let capturedAudioPath: string | null = null;
      if (pulseAudioRecorder) {
        try {
          capturedAudioPath = await pulseAudioRecorder.stop();
          this._logger.info('PulseAudio recorder stopped', { capturedAudioPath });
        } catch (err) {
          this._logger.warn('PulseAudio recorder stop failed', { error: (err as Error)?.message });
        }
      }

      this._logger.info('Closing the browser...');
      await this.page.context().browser()?.close();

      // Attach captured captions, participant events, and audio path to the uploader
      if (typeof (uploader as any).setMeetingMetadata === 'function') {
        (uploader as any).setMeetingMetadata({
          captions,
          participants: participantEvents,
          ...(capturedAudioPath && { audioPath: capturedAudioPath }),
        });
      }

      this._logger.info('All done ✨', { eventId, botId, userId, teamId });
    });

    await waitingPromise.promise;

    if (captions.length === 0) {
      this._logger.warn(
        'No captions were captured for this meeting. ' +
        'Google Meet CC selectors may have changed. ' +
        'Check startCaptionScraper() in GoogleMeetBot.ts.',
        { botId, userId, teamId }
      );
    }
    this._logger.info('Meeting ended', {
      captureCount: captions.length,
      participantEventCount: participantEvents.length,
      botId,
    });
  }
}
