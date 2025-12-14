// frontend/services/api.ts
// Frontend now uses the backend for both fetch/create and updates.
// Ensure VITE_API_URL is set in frontend/.env.local 

import { UserState } from '../types';

/** Read Telegram WebApp user if available */
export const getTelegramUser = () => {
  // @ts-ignore
  const tg = window.Telegram?.WebApp;
  if (!tg) return null;
  try {
    tg.ready();
    tg.expand();
  } catch (e) {
    // ignore errors from tg SDK if any
  }
  return tg.initDataUnsafe?.user || null;
};

/** Normalize backend/db row to frontend UserState */
const mapToState = (data: any): UserState => ({
  id: String(data.id),
  username: data.username ?? `user_${data.id}`,
  coins: Number(data.coins ?? 0),
  businesses: data.businesses ?? {},
  level: Number(data.level ?? 1),
  lastMine: Number(data.last_mine ?? data.lastMine ?? 0),
  referralsCount: Number(data.referrals_count ?? data.referralsCount ?? 0),
  referredBy: data.referred_by ?? data.referredBy ?? null,
  subscribed: Boolean(data.subscribed ?? false),
});

/** Resolve backend base URL (Vite recommended env: VITE_API_URL) */
const API_BASE = (() => {
  // Vite: import.meta.env.VITE_API_URL
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) {
      // @ts-ignore
      return String((import.meta as any).env.VITE_API_URL).replace(/\/$/, '');
    }
  } catch { /* ignore */ }
  // Runtime fallback if you set window.VITE_API_URL
  if (typeof window !== 'undefined' && (window as any).VITE_API_URL) {
    return String((window as any).VITE_API_URL).replace(/\/$/, '');
  }
  // CRA fallback
  if (process.env.REACT_APP_API_URL) return String(process.env.REACT_APP_API_URL).replace(/\/$/, '');
  // default to same-origin
  return '';
})();

/** Build endpoint path (if API_BASE empty -> same-origin /api/user) */
const buildUrl = (path: string) => (API_BASE ? `${API_BASE}${path}` : path);

/**
 * fetchUserProfile
 * - Calls backend POST /api/user which fetches-or-creates a user in DB.
 * - Returns UserState or fallback offline user.
 */
export const fetchUserProfile = async (): Promise<UserState | null> => {
  const tgUser = getTelegramUser();
  const userId = tgUser?.id?.toString() || '12345_TEST_USER';
  const username = tgUser?.username || 'Guest_CEO';

  const fallbackUser: UserState = {
    id: userId,
    username,
    coins: 100,
    businesses: {},
    level: 1,
    lastMine: 0,
    referralsCount: 0,
    referredBy: null,
    subscribed: false,
  };

  try {
    const resp = await fetch(buildUrl('/api/user'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: userId, username })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('Backend /api/user returned non-ok', resp.status, txt);
      return fallbackUser;
    }

    const json = await resp.json().catch(() => ({}));
    const userData = json?.user ?? json;

    if (!userData || !userData.id) {
      console.warn('Invalid user data from backend. Falling back.', userData);
      return fallbackUser;
    }

    return mapToState(userData);
  } catch (err) {
    console.warn('fetchUserProfile: backend unreachable — switching to fallback user', err);
    return fallbackUser;
  }
};

/**
 * updateUserProfile
 * - Sends partial user update to backend POST /api/user/update
 * - Backend holds the Service Role key and performs DB writes.
 */
export const updateUserProfile = async (user: UserState): Promise<boolean> => {
  try {
    const resp = await fetch(buildUrl('/api/user/update'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: user.id,
        coins: user.coins,
        businesses: user.businesses,
        lastMine: user.lastMine,
        level: user.level,
        subscribed: user.subscribed
      })
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn('/api/user/update failed', resp.status, txt);
      return false;
    }

    // Optionally read response
    // const data = await resp.json().catch(()=>null);
    return true;
  } catch (err) {
    console.warn('updateUserProfile: network error', err);
    return false;
  }
};
