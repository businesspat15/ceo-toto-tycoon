import { UserState, BusinessDef } from '../types';
import { BUSINESSES } from '../constants';

export const calculatePassiveIncome = (businesses: Record<string, number>): number => {
  let total = 0;
  for (const [id, qty] of Object.entries(businesses)) {
    const business = BUSINESSES.find(b => b.id === id);
    if (business) {
      total += business.income * qty;
    }
  }
  return total;
};
