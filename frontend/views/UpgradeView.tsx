import React from 'react';
import { UserState } from '../types';
import { BUSINESSES, formatNumber } from '../constants';
import { calculatePassiveIncome } from '../services/gameLogic';

interface UpgradeViewProps {
  user: UserState;
  onBuy: (businessId: string) => void;
}

const UpgradeView: React.FC<UpgradeViewProps> = ({ user, onBuy }) => {
  const currentPassive = calculatePassiveIncome(user.businesses);
  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      <div className="flex flex-col items-center mb-6">
        <h2 className="text-2xl font-bold text-white mb-1">Investments 🏢</h2>
        <p className="text-slate-400 text-sm">Buy businesses to earn while you sleep</p>
      </div>
      <div className="bg-slate-800 rounded-lg p-4 mb-6 border border-slate-700 shadow-lg">
        <div className="flex justify-between items-center">
          <span className="text-slate-400">Current Balance</span>
          <span className="text-white font-bold">{formatNumber(user.coins)} 💰</span>
        </div>
        <div className="flex justify-between items-center mt-2">
          <span className="text-slate-400">Total Passive Income</span>
          <span className="text-lime-400 font-bold">+{formatNumber(currentPassive)} / mine</span>
        </div>
      </div>
      <div className="grid gap-4">
        {BUSINESSES.map((biz) => {
          const owned = user.businesses[biz.id] || 0;
          const canAfford = user.coins >= biz.cost;
          return (
            <div key={biz.id} className="relative bg-slate-800 rounded-xl p-4 border border-slate-700 flex flex-col shadow-sm transition-transform active:scale-[0.99]" >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h3 className="text-lg font-bold text-white">{biz.name}</h3>
                  <div className="text-xs text-lime-400 font-medium">+{biz.income} income/mine</div>
                </div>
                <div className="px-2 py-1 bg-slate-700 rounded text-xs text-slate-300"> Owned: {owned} </div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="text-sm text-slate-400"> Cost: <span className={canAfford ? "text-white" : "text-red-400"}>{formatNumber(biz.cost)} 💰</span> </div>
                <button 
                    onClick={() => onBuy(biz.id)} 
                    disabled={!canAfford} 
                    className={`px-4 py-2 rounded-lg text-sm font-bold transition-colors ${ canAfford ? 'bg-lime-500 hover:bg-lime-600 text-slate-900 shadow-[0_0_10px_rgba(132,204,22,0.3)]' : 'bg-slate-700 text-slate-500 cursor-not-allowed' }`} 
                > 
                    Buy 
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default UpgradeView;