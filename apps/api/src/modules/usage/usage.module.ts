import { Hono } from 'hono';
import { UsageGranularity } from '@magicode/contracts';
import type { AppEnv } from '../../app.types';
import { config } from '../../config/config';
import { resolveWindow } from '../../common/utils/time';
import { BadRequestException } from '../../common/exceptions';
import { usageService } from './usage.service';

/** /usage — consumo MagiHub por API key + intervalo (snapshots en Dynamo). */
export const usageRouter = new Hono<AppEnv>();

const windowOf = (from?: string, to?: string) =>
  resolveWindow(from, to, { defaultDays: 1, maxDays: config.getValue('usage').maxWindowDays });

usageRouter.get('/', async (c) => {
  const { from, to } = windowOf(c.req.query('from'), c.req.query('to'));
  const g = c.req.query('granularity');
  const parsed = g ? UsageGranularity.safeParse(g) : undefined;
  if (parsed && !parsed.success) throw new BadRequestException('granularity debe ser request|hour|day', 'INVALID_GRANULARITY');
  const caller = { tenant_id: c.get('tenant_id'), key_id: c.get('key_id') };
  const r = await usageService.getWindow(caller, c.get('apiKey'), from, to, { granularity: parsed?.data });
  return c.json({
    data: r.response,
    meta: { stored_granularity: r.granularity, provenance: r.provenance, source: r.source, synced: r.synced, synced_at: r.synced_at },
  });
});

usageRouter.post('/sync', async (c) => {
  const { from, to } = windowOf(c.req.query('from'), c.req.query('to'));
  const caller = { tenant_id: c.get('tenant_id'), key_id: c.get('key_id') };
  const marker = await usageService.sync(caller, c.get('apiKey'), from, to);
  return c.json({ data: { from, to, ...marker } });
});
