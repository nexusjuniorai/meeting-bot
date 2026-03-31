import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGoogleMeetLobbyPageState, GoogleMeetLobbySnapshot } from '../bots/google-meet-lobby-state';

const constants = {
  lobbyWaitText: 'Please wait until a meeting host brings you',
  requestTimeout: 'No one responded to your request to join the call',
  requestDenied: 'Someone in the call denied your request to join',
};

const createSnapshot = (overrides: Partial<GoogleMeetLobbySnapshot>): GoogleMeetLobbySnapshot => ({
  bodyText: '',
  pageUrl: 'https://meet.google.com/abc-defg-hij',
  hasLeaveButton: false,
  peopleButtonLabel: '',
  hasJoinActionButton: false,
  ...overrides,
});

test('detects account chooser redirects', () => {
  const state = detectGoogleMeetLobbyPageState(
    createSnapshot({
      pageUrl: 'https://accounts.google.com/AccountChooser',
      bodyText: 'Choose an account',
    }),
    constants,
  );

  assert.equal(state, 'ACCOUNT_CHOOSER');
});

test('detects signed-in prejoin pages that require another join action', () => {
  const state = detectGoogleMeetLobbyPageState(
    createSnapshot({
      bodyText: [
        'aheadx.notetaker@gmail.com',
        'Switch account',
        'Ready to join?',
        'Ask to join',
        'Other ways to join',
      ].join('\n'),
      hasJoinActionButton: true,
    }),
    constants,
  );

  assert.equal(state, 'JOIN_ACTION_REQUIRED');
});

test('detects the transient signed-in prejoin loading screen', () => {
  const state = detectGoogleMeetLobbyPageState(
    createSnapshot({
      bodyText: [
        'aheadx.notetaker@gmail.com',
        'Switch account',
        'Getting ready...',
        'You\'ll be able to join in just a moment',
      ].join('\n'),
    }),
    constants,
  );

  assert.equal(state, 'PREJOIN_LOADING');
});
