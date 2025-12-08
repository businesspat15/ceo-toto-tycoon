// index.js
// Robust Express backend for CEO TOTO Tycoon
// - safe CORS + preflight handling
// - better JSON parse error handling to avoid repeated 400 logs
// - safe create-or-fetch user (handles race/duplicates)
// - upsert fallback and clear logging
// - safe referral increment via RPC with fallback update
// - leaderboard route

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.set('trust proxy', 1);

// --- ENV & quick sanity checks ---
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const FRONTEND_ORIGIN_RAW = process.env.FRONTEND_ORIGIN || ''; // e.g. https://ceo-toto-tycoon.vercel.app
const FRONTEND_ORIGIN = FRONTEND_ORIGIN_RAW.replace(/\/$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in env.');
  process.exit(1);
}

// Create Supabase server client with service role key (server-only)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// --- CORS ---
// allow from Vercel production origin + localhost:5173 for dev
const allowedOrigins = [FRONTEND_ORIGIN, 'http://localhost:5173'].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) {
    // requests without origin (curl, server-to-server) — allow
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    // not allowed origin — do not set Access-Control-Allow-Origin
    // this will cause the browser to block the request (as desired)
    // but we still respond so tools like curl get a response.
    console.warn(`CORS: request from disallowed origin: ${origin}`);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Also register cors middleware for completeness
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: "GET,POST,PATCH,PUT,DELETE,OPTIONS",
}));

// --- Body parser with JSON error handler ---
// Express's built-in json parser
app.use(express.json({
  // limit: '1mb' // adjust if needed
}));

// JSON parse error handler (prevents repeated stack traces + 400)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.warn('JSON parse error:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

// --- Helpers ---
const BUSINESSES = [
  { id: 'DAPP', name: 'DAPP', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'TOTO VAULT', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI STABLE COIN', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'TYPOGRAM', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'APPLE', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'BITCOIN', cost: 1000, income: 1 },
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
    coins: Number(row.coins ?? 0),
    businesses: row.businesses ?? {},
    level: Number(row.level ?? 1),
    lastMine: Number(row.last_mine ?? row.lastMine ?? 0),
    referralsCount: Number(row.referrals_count ?? row.referralsCount ?? 0),
    referredBy: row.referred_by ?? row.referredBy ?? null,
    subscribed: Boolean(row.subscribed ?? false),
    createdAt: row.created_at ?? null
  };
}

// --- Routes ---

// debug
app.post('/api/user-debug', (req, res) => {
  console.log('DEBUG /api/user-debug body:', req.body);
  res.json({ body: req.body });
});

/**
 * POST /api/user
 * Body: { id, username }
 * Fetch existing user or create a new one.
 *
 * Implementation note:
 * - first try to SELECT the user
 * - if missing, INSERT and if insert fails due to duplicate (race), SELECT again
 */
app.post('/api/user', async (req, res) => {
  try {
    const { id, username } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    // 1) try to select
    const { data: existing, error: selectErr } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (selectErr) {
      console.warn('/api/user select error', selectErr);
      // continue - we can still try to insert
    }

    if (existing) {
      return res.json({ user: mapRowToUser(existing) });
    }

    // 2) not exists -> try to insert new
    const newUser = {
      id,
      username: username || `user_${id}`,
      coins: 100,
      businesses: {},
      level: 1,
      last_mine: 0,
      referrals_count: 0,
      referred_by: null,
      subscribed: false,
    };

    // Try insert first (preferred). If concurrent insert causes duplicate key,
    // catch and select the existing row.
    try {
      const { data: created, error: insertErr } = await supabase
        .from('users')
        .insert([newUser])
        .select()
        .single();

      if (insertErr) {
        // If insertErr is duplicate key, fallback to select existing
        console.warn('/api/user insert error (trying fallback select):', insertErr?.message || insertErr);
        const { data: existing2, error: sel2Err } = await supabase
          .from('users')
          .select('*')
          .eq('id', id)
          .maybeSingle();

        if (sel2Err) throw sel2Err;
        if (existing2) return res.json({ user: mapRowToUser(existing2) });

        throw insertErr;
      }

      return res.json({ user: mapRowToUser(created) });
    } catch (insErr) {
      console.error('/api/user final insert error', insErr);
      return res.status(500).json({ error: insErr?.message || 'server error' });
    }
  } catch (err) {
    console.error('/api/user error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * GET /api/user/:id
 */
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

/**
 * POST /api/user/update
 * Body: { id, coins?, businesses?, lastMine?, level?, subscribed? }
 */
app.post('/api/user/update', async (req, res) => {
  try {
    const { id, coins, businesses, lastMine, level, subscribed } = req.body || {};
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

/**
 * POST /api/mine
 * Body: { id }
 */
app.post('/api/mine', async (req, res) => {
  try {
    const { id } = req.body || {};
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

    const earned = Math.floor(Math.random() * 2) + 2;
    const passive = calculatePassiveIncome(data.businesses || {});
    const newCoins = (Number(data.coins || 0)) + earned + passive;

    const { error: updErr } = await supabase
      .from('users')
      .update({ coins: newCoins, last_mine: now })
      .eq('id', id);

    if (updErr) throw updErr;

    return res.json({ earned, passive, coins: newCoins, lastMine: now });
  } catch (err) {
    console.error('/api/mine', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * Telegram webhook (safe)
 * - Handles /start [ref_xxx]
 */
app.post(`/telegram/webhook${process.env.TELEGRAM_SECRET_PATH ? `/${process.env.TELEGRAM_SECRET_PATH}` : ''}`, async (req, res) => {
  try {
    console.log('[telegram webhook] headers:', req.headers);
    // log a limited raw body so logs aren't enormous
    try { console.log('[telegram webhook] raw body (first 2000 chars):', JSON.stringify(req.body).slice(0,2000)); } catch(e){ /** ignore */ }

    const body = req.body;
    if (!body) return res.sendStatus(204);
    const msg = body.message || body.edited_message;
    if (!msg) return res.sendStatus(204);

    const text = String(msg.text || '').trim();
    const from = msg.from || {};
    const tgId = from.id ? String(from.id) : null;

    console.log('[telegram webhook] text:', text, 'from:', tgId, 'username:', from.username);

    if (text && text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const maybeRef = parts[1] || null;
      const referrerId = (maybeRef && maybeRef.startsWith('ref_')) ? maybeRef.replace(/^ref_/, '') : null;

      if (!tgId) {
        console.warn('[telegram webhook] no tgId, ignoring');
        return res.json({ ok: true });
      }

      const username = from.username || `${from.first_name || 'tg'}_${tgId}`;

      // create user if not exists
      const { data: existing, error: selectErr } = await supabase
        .from('users').select('id').eq('id', tgId).maybeSingle();
      if (selectErr) console.warn('[telegram webhook] select error', selectErr);

      if (!existing) {
        const insertPayload = {
          id: tgId,
          username,
          coins: 100,
          businesses: {},
          level: 1,
          last_mine: 0,
          referrals_count: 0,
          referred_by: referrerId || null,
          subscribed: false
        };

        try {
          const { data: inserted, error: insertErr } = await supabase.from('users').insert([insertPayload]).select().single();
          if (insertErr) {
            console.warn('[telegram webhook] insert error (maybe concurrent):', insertErr?.message || insertErr);
          } else {
            console.log('[telegram webhook] user created:', inserted.id);
          }
        } catch (e) {
          console.warn('[telegram webhook] insert threw', e?.message || e);
        }
      } else {
        console.log('[telegram webhook] user exists:', existing.id);
      }

      // If referral present, increment referrals_count safely
      if (referrerId) {
        try {
          // Try RPC first (recommended). rpc returns new_count (as defined in SQL below)
          try {
            const { data: rpcRes, error: rpcErr } = await supabase.rpc('increment_referral_bonus', { ref_id: referrerId });
            if (rpcErr) throw rpcErr;
            console.log('[telegram webhook] RPC increment_referral_bonus success:', rpcRes);
          } catch (rpcEx) {
            console.warn('[telegram webhook] RPC failed, falling back to update (rpcEx):', rpcEx?.message || rpcEx);
            // fallback: select and update
            const { data: refRow, error: refErr } = await supabase
              .from('users')
              .select('referrals_count')
              .eq('id', referrerId)
              .maybeSingle();

            if (refErr) {
              console.warn('[telegram webhook] fetching referrer row failed', refErr);
            } else if (!refRow) {
              console.warn('[telegram webhook] referrer not found:', referrerId);
            } else {
              const next = (refRow.referrals_count || 0) + 1;
              const { error: updErr } = await supabase
                .from('users')
                .update({ referrals_count: next, coins: (refRow.coins ?? 0) + 100 })
                .eq('id', referrerId);
              if (updErr) console.warn('[telegram webhook] fallback update failed', updErr);
              else console.log('[telegram webhook] fallback incremented referrals_count for', referrerId, '->', next);
            }
          }
        } catch (incErr) {
          console.warn('[telegram webhook] final error incrementing referral', incErr);
        }
      }

      return res.json({ ok: true });
    }

    // Not /start — ignore
    return res.json({ ok: true });
  } catch (err) {
    console.error('[telegram webhook] handler error', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

/**
 * GET /api/leaderboard
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '20', 10) || 20);
    const { data, error } = await supabase
      .from('users')
      .select('id, username, coins, businesses, level, referrals_count, created_at')
      .order('coins', { ascending: false })
      .limit(limit);

    if (error) throw error;
    const users = (data || []).map(mapRowToUser);
    return res.json({ users });
  } catch (err) {
    console.error('/api/leaderboard', err);
    return res.status(500).json({ error: err?.message || 'server error' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Allowed CORS origins: ${allowedOrigins.join(', ')}`);
  console.log(`FRONTEND_ORIGIN: ${FRONTEND_ORIGIN || '<not set>'}`);
});
