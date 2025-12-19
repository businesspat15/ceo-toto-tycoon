import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// ---- Config & env ----
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || '';
const ADMIN_ID = process.env.ADMIN_ID || null;
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '200', 10);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || null;
const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, '');
const BOT_USERNAME_FALLBACK = process.env.BOT_USERNAME || null;

// sanity check env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars. Fill SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

// ---- Supabase server client ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ---- App init ----
const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: ["http://localhost:5173", FRONTEND_ORIGIN].filter(Boolean),
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true
}));
app.use(express.json());

// ---- Game constants ----
const BUSINESSES = [
  { id: 'DAPP', name: 'CIFCI Tech & AI', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'CIFCI Crypto & Blockchain', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI Real Estate', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'CIFCI Energy', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'CIFCI Infrastructure', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'CIFCI Space & Exploration', cost: 1000, income: 1 },
];

const MINE_COOLDOWN_MS = 60_000; // 1 minute

function calculatePassiveIncome(businesses = {}) {
  let total = 0;
  for (const [id, qty] of Object.entries(businesses || {})) {
    const b = BUSINESSES.find(x => x.id === id);
    if (b) total += (b.income || 0) * (qty || 0);
  }
  return total;
}

function mapRowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    coins: (row.coins === null || row.coins === undefined) ? 0 : Number(row.coins),
    businesses: row.businesses ?? {},
    level: row.level ?? 1,
    lastMine: row.last_mine ?? 0,
    referralsCount: row.referrals_count ?? 0,
    referredBy: row.referred_by ?? null,
    subscribed: row.subscribed === null || row.subscribed === undefined ? true : !!row.subscribed,
    createdAt: row.created_at ?? null
  };
}

// ---- Helpers ----
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sendTelegram(chat, textMsg, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN missing, cannot send message');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chat, text: textMsg, ...opts };
    if (payload.reply_markup && typeof payload.reply_markup !== 'string') {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('Failed to send telegram message', e?.message || e);
  }
}

let _cachedBotUsername = null;
async function getBotUsername() {
  if (_cachedBotUsername) return _cachedBotUsername;
  if (BOT_USERNAME_FALLBACK) {
    _cachedBotUsername = BOT_USERNAME_FALLBACK;
    return _cachedBotUsername;
  }
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const json = await resp.json();
    if (json?.ok && json.result?.username) {
      _cachedBotUsername = json.result.username;
      return _cachedBotUsername;
    }
  } catch (e) {
    console.warn('getBotUsername failed', e?.message || e);
  }
  return null;
}

async function callManualRefer(referrerId, referredId, referredUsername) {
  try {
    const normReferrerId = (typeof referrerId === 'string' && /^\d+$/.test(referrerId)) ? Number(referrerId) : referrerId;
    const normReferredId = (typeof referredId === 'string' && /^\d+$/.test(referredId)) ? Number(referredId) : referredId;

    const { data, error } = await supabase.rpc('manual_refer_by_id', {
      referrer_id: normReferrerId,
      referred_id: normReferredId,
      referred_username: referredUsername
    });

    if (error) {
      console.error('manual_refer_by_id rpc error object:', error);
      return { ok: false, error };
    }

    const rpcResult = Array.isArray(data) ? data[0] : data;
    if (!rpcResult || typeof rpcResult.success === 'undefined') {
      console.error('manual_refer_by_id unexpected rpc result:', { data });
      return { ok: false, error: new Error('invalid_rpc_result'), data };
    }

    return { ok: true, result: rpcResult };
  } catch (e) {
    console.error('manual_refer_by_id call failed:', e);
    return { ok: false, error: e };
  }
}

async function findUserByUsernameOrId(target) {
  if (!target) return null;
  const cleaned = target.replace(/^@/, '').trim();

  // exact match
  try {
    const { data: exactRows, error: exactErr } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', cleaned)
      .limit(1);
    if (exactErr) throw exactErr;
    if (exactRows && exactRows.length > 0) return exactRows[0];
  } catch (e) {
    console.warn('findUser exact match failed', e?.message || e);
  }

  // ilike
  try {
    const { data: ilikeRows, error: ilikeErr } = await supabase
      .from('users')
      .select('id, username')
      .ilike('username', cleaned)
      .limit(1);
    if (ilikeErr) throw ilikeErr;
    if (ilikeRows && ilikeRows.length > 0) return ilikeRows[0];
  } catch (e) {
    console.warn('findUser ilike match failed', e?.message || e);
  }

  // id numeric match
  if (/^\d+$/.test(cleaned)) {
    try {
      const { data: idRows, error: idErr } = await supabase
        .from('users')
        .select('id, username')
        .eq('id', cleaned)
        .limit(1);
      if (idErr) throw idErr;
      if (idRows && idRows.length > 0) return idRows[0];
    } catch (e) {
      console.warn('findUser id match failed', e?.message || e);
    }
  }

  return null;
}

// ---- API routes ----
app.post('/api/user-debug', (req, res) => {
  console.log('DEBUG /api/user-debug body:', req.body);
  res.json({ body: req.body });
});

app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selectErr) throw selectErr;

    if (existing) return res.json({ user: mapRowToUser(existing) });

    const newUser = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: null,
      subscribed: true,
    };

    const { data: created, error: upsertErr } = await supabase
      .from('users')
      .upsert(newUser, { onConflict: 'id' })
      .select()
      .single();

    if (upsertErr) throw upsertErr;
    return res.json({ user: mapRowToUser(created) });
  } catch (err) {
    console.error('/api/user error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.json({ user: mapRowToUser(data) });
  } catch (err) {
    console.error('/api/user/:id', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/user/update', async (req, res) => {
  try {
    const { id, coins, businesses, lastMine, level, subscribed } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const updatePayload = {};
    if (coins !== undefined) updatePayload.coins = coins;
    if (businesses !== undefined) updatePayload.businesses = businesses;
    if (lastMine !== undefined) updatePayload.last_mine = lastMine;
    if (level !== undefined) updatePayload.level = level;
    if (subscribed !== undefined) updatePayload.subscribed = subscribed;

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    const { error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/user/update', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/mine', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data, error: selErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!data) return res.status(404).json({ error: 'user not found' });

    const now = Date.now();
    const lastMine = data.last_mine || 0;
    const diff = now - lastMine;
    if (diff < MINE_COOLDOWN_MS) {
      const retryAfterMs = MINE_COOLDOWN_MS - diff;
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({ error: 'cooldown', retryAfterMs });
    }

    const earned = Math.floor(Math.random() * 3) + 1;
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (Number(data.coins) || 0) + earned + passive;

    const { error: updErr } = await supabase
      .from('users')
      .update({
        coins: newCoins,
        last_mine: now
      })
      .eq('id', id);
    if (updErr) throw updErr;

    return res.json({
      earned,
      passive,
      coins: newCoins,
      lastMine: now
    });
  } catch (err) {
    console.error('/api/mine', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/buy', async (req, res) => {
  try {
    const { id, business, qty, unitCost } = req.body;
    if (!id || !business || !qty) return res.status(400).json({ error: 'id, business and qty required' });

    const qtyInt = parseInt(qty, 10);
    if (isNaN(qtyInt) || qtyInt <= 0) return res.status(400).json({ error: 'invalid qty' });

    const unitCostNum = unitCost !== undefined ? Number(unitCost) : null;
    if (unitCostNum === null || isNaN(unitCostNum) || unitCostNum < 0) {
      return res.status(400).json({ error: 'unitCost required and must be non-negative' });
    }

    const { data, error } = await supabase.rpc('purchase_business', {
      p_business: business,
      p_user_id: id,
      p_qty: qtyInt,
      p_unit_cost: unitCostNum
    });

    if (error) {
      console.error('purchase_business rpc error', error);
      return res.status(500).json({ error: error.message || 'purchase failed' });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || result.success !== true) {
      return res.status(400).json({ ok: false, result });
    }

    return res.json({ ok: true, result });
  } catch (err) {
    console.error('/api/buy', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
    const { data, error } = await supabase
      .from('users')
      .select('id, username, coins, businesses, level')
      .order('coins', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ users: data || [] });
  } catch (err) {
    console.error('/api/leaderboard', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Telegram webhook handler ----
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    console.log('telegram webhook body:', JSON.stringify(body));

    const msg = body.message || body.edited_message || body.callback_query?.message;
    if (!msg) return res.sendStatus(204);

    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery?.data;
    const text = (msg.text || '').trim();
    const from = msg.from || callbackQuery?.from || {};
    const tgId = from.id?.toString();
    const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
    const chatId = msg.chat?.id?.toString() || tgId;

    // ---------- /start handling ----------
    if (text && text.startsWith('/start')) {
      const parts = text.split(/\s+/);

      // Referral: /start ref_<id>
      if (parts[1] && parts[1].startsWith('ref_')) {
        const referrerIdRaw = parts[1].replace('ref_', '').trim();

        if (!tgId) return res.json({ ok: false, error: 'no tg id' });

        try {
          const { data: existingUser, error: existingErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (existingErr) console.warn('Error checking user existence (start ref):', existingErr);
          else if (existingUser) {
            await sendTelegram(chatId, 'You are already a user');
            return res.json({ ok: false, error: 'already_registered' });
          }
        } catch (e) {
          console.warn('Check user existence failed (start ref):', e?.message || e);
        }

        try {
          const { ok, result, error } = await callManualRefer(referrerIdRaw, tgId, username);
          if (!ok) {
            console.error('callManualRefer failed', error);
            await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error });
          }

          if (result.success === true) {
            await sendTelegram(
              chatId,
              `🎁 You were successfully referred by <b>${result.inviter_username || referrerIdRaw}</b>!`,
              { parse_mode: 'HTML' }
            );

            try {
              if (result.inviter_id && result.awarded) {
                await sendTelegram(
                  result.inviter_id,
                  `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`,
                  { parse_mode: 'HTML' }
                );
              }
            } catch (e) {}

            return res.json({ ok: true, result });
          } else {
            const errCode = result.error || 'unknown';
            if (errCode === 'inviter_not_found') await sendTelegram(chatId, '❌ Inviter not found.');
            else if (errCode === 'self_referral') await sendTelegram(chatId, '😅 You can’t refer yourself!');
            else if (errCode === 'already_referred')
              await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
            else if (errCode === 'already_registered') await sendTelegram(chatId, 'You are already a user');
            else await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error: errCode });
          }
        } catch (err) {
          console.error('manual_refer_by_id call failed (start ref):', err);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: err?.message || err });
        }
      }

      // Plain /start
      else {
        if (tgId) {
          try {
            await supabase.from('users').upsert(
              [
                {
                  id: tgId,
                  username,
                  coins: 100,
                  businesses: {},
                  level: 1,
                  last_mine: 0,
                  referrals_count: 0,
                  referred_by: null,
                  subscribed: true
                }
              ],
              { onConflict: 'id' }
            );
          } catch (e) {
            console.warn('create user on plain /start failed', e?.message || e);
          }
        }

        await sendTelegram(
          chatId,
          `👋 Welcome!\n\n⛏ Mine daily\n🏢 Build businesses\n🎁 Invite friends`,
          { parse_mode: 'HTML' }
        );

        return res.json({ ok: true });
      }
    }

    res.sendStatus(204);
  } catch (err) {
    console.error('telegram webhook handler error', err);
    res.sendStatus(500);
  }
});

// ---- Start server ----
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

// ---- Config & env ----
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_SECRET_PATH = process.env.TELEGRAM_SECRET_PATH || '';
const ADMIN_ID = process.env.ADMIN_ID || null;
const BROADCAST_DELAY_MS = parseInt(process.env.BROADCAST_DELAY_MS || '200', 10);
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || null;
const RAW_FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '';
const FRONTEND_ORIGIN = RAW_FRONTEND_ORIGIN.replace(/\/$/, '');
const BOT_USERNAME_FALLBACK = process.env.BOT_USERNAME || null;

// sanity check env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing Supabase env vars. Fill SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

// ---- Supabase server client ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ---- App init ----
const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: ["http://localhost:5173", FRONTEND_ORIGIN].filter(Boolean),
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  allowedHeaders: "Content-Type, Authorization",
  credentials: true
}));
app.use(express.json());

// ---- Game constants ----
const BUSINESSES = [
  { id: 'DAPP', name: 'CIFCI Tech & AI', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'CIFCI Crypto & Blockchain', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI Real Estate', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'CIFCI Energy', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'CIFCI Infrastructure', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'CIFCI Space & Exploration', cost: 1000, income: 1 },
];

const MINE_COOLDOWN_MS = 60_000; // 1 minute

function calculatePassiveIncome(businesses = {}) {
  let total = 0;
  for (const [id, qty] of Object.entries(businesses || {})) {
    const b = BUSINESSES.find(x => x.id === id);
    if (b) total += (b.income || 0) * (qty || 0);
  }
  return total;
}

function mapRowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    coins: (row.coins === null || row.coins === undefined) ? 0 : Number(row.coins),
    businesses: row.businesses ?? {},
    level: row.level ?? 1,
    lastMine: row.last_mine ?? 0,
    referralsCount: row.referrals_count ?? 0,
    referredBy: row.referred_by ?? null,
    subscribed: row.subscribed === null || row.subscribed === undefined ? true : !!row.subscribed,
    createdAt: row.created_at ?? null
  };
}

// ---- Helpers ----
function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sendTelegram(chat, textMsg, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN missing, cannot send message');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chat, text: textMsg, ...opts };
    if (payload.reply_markup && typeof payload.reply_markup !== 'string') {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.warn('Failed to send telegram message', e?.message || e);
  }
}

let _cachedBotUsername = null;
async function getBotUsername() {
  if (_cachedBotUsername) return _cachedBotUsername;
  if (BOT_USERNAME_FALLBACK) {
    _cachedBotUsername = BOT_USERNAME_FALLBACK;
    return _cachedBotUsername;
  }
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
    const json = await resp.json();
    if (json?.ok && json.result?.username) {
      _cachedBotUsername = json.result.username;
      return _cachedBotUsername;
    }
  } catch (e) {
    console.warn('getBotUsername failed', e?.message || e);
  }
  return null;
}

async function callManualRefer(referrerId, referredId, referredUsername) {
  try {
    const normReferrerId = (typeof referrerId === 'string' && /^\d+$/.test(referrerId)) ? Number(referrerId) : referrerId;
    const normReferredId = (typeof referredId === 'string' && /^\d+$/.test(referredId)) ? Number(referredId) : referredId;

    const { data, error } = await supabase.rpc('manual_refer_by_id', {
      referrer_id: normReferrerId,
      referred_id: normReferredId,
      referred_username: referredUsername
    });

    if (error) {
      console.error('manual_refer_by_id rpc error object:', error);
      return { ok: false, error };
    }

    const rpcResult = Array.isArray(data) ? data[0] : data;
    if (!rpcResult || typeof rpcResult.success === 'undefined') {
      console.error('manual_refer_by_id unexpected rpc result:', { data });
      return { ok: false, error: new Error('invalid_rpc_result'), data };
    }

    return { ok: true, result: rpcResult };
  } catch (e) {
    console.error('manual_refer_by_id call failed:', e);
    return { ok: false, error: e };
  }
}

async function findUserByUsernameOrId(target) {
  if (!target) return null;
  const cleaned = target.replace(/^@/, '').trim();

  // exact match
  try {
    const { data: exactRows, error: exactErr } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', cleaned)
      .limit(1);
    if (exactErr) throw exactErr;
    if (exactRows && exactRows.length > 0) return exactRows[0];
  } catch (e) {
    console.warn('findUser exact match failed', e?.message || e);
  }

  // ilike
  try {
    const { data: ilikeRows, error: ilikeErr } = await supabase
      .from('users')
      .select('id, username')
      .ilike('username', cleaned)
      .limit(1);
    if (ilikeErr) throw ilikeErr;
    if (ilikeRows && ilikeRows.length > 0) return ilikeRows[0];
  } catch (e) {
    console.warn('findUser ilike match failed', e?.message || e);
  }

  // id numeric match
  if (/^\d+$/.test(cleaned)) {
    try {
      const { data: idRows, error: idErr } = await supabase
        .from('users')
        .select('id, username')
        .eq('id', cleaned)
        .limit(1);
      if (idErr) throw idErr;
      if (idRows && idRows.length > 0) return idRows[0];
    } catch (e) {
      console.warn('findUser id match failed', e?.message || e);
    }
  }

  return null;
}

// ---- API routes ----
app.post('/api/user-debug', (req, res) => {
  console.log('DEBUG /api/user-debug body:', req.body);
  res.json({ body: req.body });
});

app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selectErr) throw selectErr;

    if (existing) return res.json({ user: mapRowToUser(existing) });

    const newUser = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: null,
      subscribed: true,
    };

    const { data: created, error: upsertErr } = await supabase
      .from('users')
      .upsert(newUser, { onConflict: 'id' })
      .select()
      .single();

    if (upsertErr) throw upsertErr;
    return res.json({ user: mapRowToUser(created) });
  } catch (err) {
    console.error('/api/user error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/api/user/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'not found' });
    return res.json({ user: mapRowToUser(data) });
  } catch (err) {
    console.error('/api/user/:id', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/user/update', async (req, res) => {
  try {
    const { id, coins, businesses, lastMine, level, subscribed } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const updatePayload = {};
    if (coins !== undefined) updatePayload.coins = coins;
    if (businesses !== undefined) updatePayload.businesses = businesses;
    if (lastMine !== undefined) updatePayload.last_mine = lastMine;
    if (level !== undefined) updatePayload.level = level;
    if (subscribed !== undefined) updatePayload.subscribed = subscribed;

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: 'no fields to update' });
    }

    const { error } = await supabase
      .from('users')
      .update(updatePayload)
      .eq('id', id);

    if (error) throw error;
    return res.json({ ok: true });
  } catch (err) {
    console.error('/api/user/update', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/mine', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });

    const { data, error: selErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (selErr) throw selErr;
    if (!data) return res.status(404).json({ error: 'user not found' });

    const now = Date.now();
    const lastMine = data.last_mine || 0;
    const diff = now - lastMine;
    if (diff < MINE_COOLDOWN_MS) {
      const retryAfterMs = MINE_COOLDOWN_MS - diff;
      res.setHeader('Retry-After', Math.ceil(retryAfterMs / 1000));
      return res.status(429).json({ error: 'cooldown', retryAfterMs });
    }

    const earned = Math.floor(Math.random() * 3) + 1;
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (Number(data.coins) || 0) + earned + passive;

    const { error: updErr } = await supabase
      .from('users')
      .update({
        coins: newCoins,
        last_mine: now
      })
      .eq('id', id);
    if (updErr) throw updErr;

    return res.json({
      earned,
      passive,
      coins: newCoins,
      lastMine: now
    });
  } catch (err) {
    console.error('/api/mine', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.post('/api/buy', async (req, res) => {
  try {
    const { id, business, qty, unitCost } = req.body;
    if (!id || !business || !qty) return res.status(400).json({ error: 'id, business and qty required' });

    const qtyInt = parseInt(qty, 10);
    if (isNaN(qtyInt) || qtyInt <= 0) return res.status(400).json({ error: 'invalid qty' });

    const unitCostNum = unitCost !== undefined ? Number(unitCost) : null;
    if (unitCostNum === null || isNaN(unitCostNum) || unitCostNum < 0) {
      return res.status(400).json({ error: 'unitCost required and must be non-negative' });
    }

    const { data, error } = await supabase.rpc('purchase_business', {
      p_business: business,
      p_user_id: id,
      p_qty: qtyInt,
      p_unit_cost: unitCostNum
    });

    if (error) {
      console.error('purchase_business rpc error', error);
      return res.status(500).json({ error: error.message || 'purchase failed' });
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result || result.success !== true) {
      return res.status(400).json({ ok: false, result });
    }

    return res.json({ ok: true, result });
  } catch (err) {
    console.error('/api/buy', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
    const { data, error } = await supabase
      .from('users')
      .select('id, username, coins, businesses, level')
      .order('coins', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ users: data || [] });
  } catch (err) {
    console.error('/api/leaderboard', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---- Telegram webhook handler ----
app.post(`/telegram/webhook${TELEGRAM_SECRET_PATH ? `/${TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.sendStatus(204);

    console.log('telegram webhook body:', JSON.stringify(body));

    const msg = body.message || body.edited_message || body.callback_query?.message;
    if (!msg) return res.sendStatus(204);

    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery?.data;
    const text = (msg.text || '').trim();
    const from = msg.from || callbackQuery?.from || {};
    const tgId = from.id?.toString();
    const username = from.username || `${from.first_name || 'tg'}_${tgId}`;
    const chatId = msg.chat?.id?.toString() || tgId;

    // ---------- /start handling ----------
    if (text && text.startsWith('/start')) {
      const parts = text.split(/\s+/);

      // Referral: /start ref_<id>
      if (parts[1] && parts[1].startsWith('ref_')) {
        const referrerIdRaw = parts[1].replace('ref_', '').trim();

        if (!tgId) return res.json({ ok: false, error: 'no tg id' });

        try {
          const { data: existingUser, error: existingErr } = await supabase
            .from('users')
            .select('id')
            .eq('id', tgId)
            .maybeSingle();

          if (existingErr) console.warn('Error checking user existence (start ref):', existingErr);
          else if (existingUser) {
            await sendTelegram(chatId, 'You are already a user');
            return res.json({ ok: false, error: 'already_registered' });
          }
        } catch (e) {
          console.warn('Check user existence failed (start ref):', e?.message || e);
        }

        try {
          const { ok, result, error } = await callManualRefer(referrerIdRaw, tgId, username);
          if (!ok) {
            console.error('callManualRefer failed', error);
            await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error });
          }

          if (result.success === true) {
            await sendTelegram(
              chatId,
              `🎁 You were successfully referred by <b>${result.inviter_username || referrerIdRaw}</b>!`,
              { parse_mode: 'HTML' }
            );

            try {
              if (result.inviter_id && result.awarded) {
                await sendTelegram(
                  result.inviter_id,
                  `🎉 <b>${escapeHtml(username)}</b> joined using your referral!\nYou received +100 💰 coins.`,
                  { parse_mode: 'HTML' }
                );
              }
            } catch (e) {}

            return res.json({ ok: true, result });
          } else {
            const errCode = result.error || 'unknown';
            if (errCode === 'inviter_not_found') await sendTelegram(chatId, '❌ Inviter not found.');
            else if (errCode === 'self_referral') await sendTelegram(chatId, '😅 You can’t refer yourself!');
            else if (errCode === 'already_referred')
              await sendTelegram(chatId, "⚠️ You have already been referred or referral couldn't be recorded.");
            else if (errCode === 'already_registered') await sendTelegram(chatId, 'You are already a user');
            else await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
            return res.json({ ok: false, error: errCode });
          }
        } catch (err) {
          console.error('manual_refer_by_id call failed (start ref):', err);
          await sendTelegram(chatId, '⚠️ Referral system error. Try again later.');
          return res.json({ ok: false, error: err?.message || err });
        }
      }

      // Plain /start
      else {
        if (tgId) {
          try {
            await supabase.from('users').upsert(
              [
                {
                  id: tgId,
                  username,
                  coins: 100,
                  businesses: {},
                  level: 1,
                  last_mine: 0,
                  referrals_count: 0,
                  referred_by: null,
                  subscribed: true
                }
              ],
              { onConflict: 'id' }
            );
          } catch (e) {
            console.warn('create user on plain /start failed', e?.message || e);
          }
        }

        await sendTelegram(
          chatId,
          `👋 Welcome!\n\n⛏ Mine daily\n🏢 Build businesses\n🎁 Invite friends`,
          { parse_mode: 'HTML' }
        );

        return res.json({ ok: true });
      }
    }

    res.sendStatus(204);
  } catch (err) {
    console.error('telegram webhook handler error', err);
    res.sendStatus(500);
  }
});

// ---- Start server ----
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
