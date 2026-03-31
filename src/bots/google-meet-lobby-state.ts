export interface GoogleMeetLobbySnapshot {
  bodyText: string;
  pageUrl: string;
  hasLeaveButton: boolean;
  peopleButtonLabel: string;
  hasJoinActionButton: boolean;
}

export interface GoogleMeetLobbyConstants {
  lobbyWaitText: string;
  requestTimeout: string;
  requestDenied: string;
}

export type GoogleMeetLobbyPageState =
  | 'ACCOUNT_CHOOSER'
  | 'WAITING_FOR_HOST_TO_ADMIT_BOT'
  | 'WAITING_REQUEST_TIMEOUT'
  | 'DENIED'
  | 'IN_CALL'
  | 'JOIN_ACTION_REQUIRED'
  | 'PREJOIN_LOADING'
  | 'UNKNOWN';

export const detectGoogleMeetLobbyPageState = (
  snapshot: GoogleMeetLobbySnapshot,
  constants: GoogleMeetLobbyConstants,
): GoogleMeetLobbyPageState => {
  const bodyText = snapshot.bodyText || '';
  const isGoogleMeetPage = snapshot.pageUrl.startsWith('https://meet.google.com');

  if (snapshot.pageUrl.includes('accounts.google.com') || bodyText.includes('Choose an account')) {
    return 'ACCOUNT_CHOOSER';
  }

  if (bodyText.includes(constants.lobbyWaitText)) return 'WAITING_FOR_HOST_TO_ADMIT_BOT';
  if (bodyText.includes(constants.requestTimeout)) return 'WAITING_REQUEST_TIMEOUT';
  if (bodyText.includes(constants.requestDenied)) return 'DENIED';

  if (snapshot.hasLeaveButton) {
    if (bodyText.includes('Asking to join') || bodyText.includes('Please wait')) {
      return 'WAITING_FOR_HOST_TO_ADMIT_BOT';
    }

    return 'IN_CALL';
  }

  if (/People.*?\d+/.test(snapshot.peopleButtonLabel || '')) {
    return 'IN_CALL';
  }

  if (
    isGoogleMeetPage &&
    (bodyText.includes('Getting ready...') || bodyText.includes('You\'ll be able to join in just a moment'))
  ) {
    return 'PREJOIN_LOADING';
  }

  if (
    isGoogleMeetPage &&
    (
      snapshot.hasJoinActionButton ||
      bodyText.includes('Ready to join?') ||
      bodyText.includes('Ask to join') ||
      bodyText.includes('Join now') ||
      bodyText.includes('Join anyway')
    )
  ) {
    return 'JOIN_ACTION_REQUIRED';
  }

  return 'UNKNOWN';
};
