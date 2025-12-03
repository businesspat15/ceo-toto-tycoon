import React from 'react';
import { UserState } from '../types';
import { formatNumber } from '../constants';

interface LeaderboardViewProps {
  user: UserState;
}

const LeaderboardView: React.FC<LeaderboardViewProps> = ({ user }) => {
  // Combine mock data with current user and sort
  const allUsers = [{ username: user.username, coins: user.coins }];

  const userRank = 1;

  return (
    <div className="h-full px-4 pt-8 pb-24 overflow-y-auto bg-slate-900">
      <div className="flex flex-col items-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Leaderboard 🏆</h2>
        <p className="text-slate-400 text-sm">Top CEOs of TOTO Tycoon</p>
      </div>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700 overflow-hidden">
        {/* Current User Rank Strip */}
        <div className="bg-gradient-to-r from-lime-900/40 to-slate-800 p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-lime-500 flex items-center justify-center text-slate-900 font-bold text-sm">
              #{userRank}
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-white">You</span>
              <span className="text-xs text-lime-400">{formatNumber(user.coins)} coins</span>
            </div>
          </div>
        </div>

        {/* List */}
        <div className="divide-y divide-slate-700/50">
          {allUsers.map((u, idx) => {
            const rank = idx + 1;
            const isMe = u.username === user.username;
            
            let medal = null;
            if (rank === 1) medal = '🥇';
            if (rank === 2) medal = '🥈';
            if (rank === 3) medal = '🥉';

            return (
              <div 
                key={`${u.username}-${idx}`} 
                className={`flex items-center justify-between p-4 ${isMe ? 'bg-white/5' : ''}`}
              >
                <div className="flex items-center gap-4">
                  <div className="w-6 text-center font-mono text-slate-500 font-bold">
                    {medal || rank}
                  </div>
                  <div className="flex flex-col">
                    <span className={`font-medium ${isMe ? 'text-lime-400' : 'text-slate-200'}`}>
                      {u.username}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-slate-300 font-mono text-sm tracking-wide">
                    {formatNumber(u.coins)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default LeaderboardView;