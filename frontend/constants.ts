import { BusinessDef } from './types';

// Derived from index.js provided by user
export const BUSINESSES: BusinessDef[] = [
  { id: 'DAPP', name: 'DAPP', cost: 1000, income: 1 },
  { id: 'TOTO_VAULT', name: 'TOTO VAULT', cost: 1000, income: 1 },
  { id: 'CIFCI_STABLE', name: 'CIFCI STABLE COIN', cost: 1000, income: 1 },
  { id: 'TYPOGRAM', name: 'TYPOGRAM', cost: 1000, income: 1 },
  { id: 'APPLE', name: 'APPLE', cost: 1000, income: 1 },
  { id: 'BITCOIN', name: 'BITCOIN', cost: 1000, income: 1 },
];

export const MINE_COOLDOWN_MS = 60000; // 1 minute

export const getLevelLabel = (coins: number): string => {
  if (coins < 1000) return "Intern";
  if (coins < 10000) return "Manager";
  if (coins < 100000) return "CEO";
  if (coins < 700000) return "Tycoon";
  return "CEO TOTO 💎";
};

export const formatNumber = (n: number): string => {
  return n.toLocaleString("en-IN");
};