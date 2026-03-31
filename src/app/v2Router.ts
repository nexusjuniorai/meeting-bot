import { Router, Request, Response } from 'express';
import { createClient } from 'redis';
import config from '../config';
import { BotStatus } from '../types';

const router = Router();

// Dedicated Redis client for bot status storage
let redisClient: ReturnType<typeof createClient> | null = null;

if (config.isRedisEnabled) {
  redisClient = createClient({ url: config.redisUri, name: 'v2-bot-status' });
  redisClient.on('error', (err) => console.error('v2Router redis error', err));
  redisClient.connect().then(() => console.log('v2Router Redis connected.'));
}

const BOT_STATUS_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const BEARER_TOKEN = process.env.BEARER_TOKEN;

function authenticate(req: Request, res: Response): boolean {
  const auth = req.headers['authorization'];
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!BEARER_TOKEN || token !== BEARER_TOKEN) {
    res.status(401).json({ success: false, data: null, message: 'Unauthorized' });
    return false;
  }
  return true;
}

interface PatchBotStatusBody {
  botId?: string;
  eventId?: string;
  provider: 'google' | 'microsoft' | 'zoom';
  status: BotStatus[];
}

// PATCH /v2/meeting/app/bot/status
router.patch('/meeting/app/bot/status', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const { botId, eventId, provider, status }: PatchBotStatusBody = req.body;

  if (!status || !Array.isArray(status) || status.length === 0) {
    res.status(400).json({ success: false, data: null, message: 'status array is required' });
    return;
  }

  if (!provider) {
    res.status(400).json({ success: false, data: null, message: 'provider is required' });
    return;
  }

  const key = `bot:status:${botId ?? eventId}`;
  const record = {
    botId,
    eventId,
    provider,
    status,
    finalStatus: status[status.length - 1],
    updatedAt: new Date().toISOString(),
  };

  if (redisClient?.isOpen) {
    await redisClient.set(key, JSON.stringify(record), { EX: BOT_STATUS_TTL_SECONDS });
  }

  console.log(`[v2] Bot status updated — key=${key} finalStatus=${record.finalStatus}`);
  res.status(200).json({ success: true, data: null });
});

// GET /v2/meeting/app/bot/status?botId=xxx  (optional — for querying stored status)
router.get('/meeting/app/bot/status', async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return;

  const id = (req.query.botId ?? req.query.eventId) as string | undefined;
  if (!id) {
    res.status(400).json({ success: false, data: null, message: 'botId or eventId query param required' });
    return;
  }

  const key = `bot:status:${id}`;
  const raw = redisClient?.isOpen ? await redisClient.get(key) : null;

  if (!raw) {
    res.status(404).json({ success: false, data: null, message: 'Not found' });
    return;
  }

  res.status(200).json({ success: true, data: JSON.parse(raw) });
});

export default router;
