import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('GoogleMeetBot.join forwards avatarUrl to joinMeeting', async () => {
  const sourcePath = path.resolve(process.cwd(), 'src/bots/GoogleMeetBot.ts');
  const source = await fs.promises.readFile(sourcePath, 'utf8');

  assert.match(
    source,
    /await\s+this\.joinMeeting\(\{\s*url,\s*name,\s*bearerToken,\s*teamId,\s*timezone,\s*userId,\s*eventId,\s*botId,\s*uploader,\s*pushState,\s*avatarUrl\s*\}\)/s,
  );
});
