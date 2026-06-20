// Pure logic & types shared between client UI and server functions.

export type Player = {
  id: number;
  name: string;
  tier: 0 | 1 | 2 | 3;
  freq: string;
  rating: number;
  gamesPlayed: number;
  totalFor: number;
  totalAgainst: number;
  present: boolean;
  gamesToday: number;
};

export type Match = {
  id: number | string;
  teamA: number[];
  teamB: number[];
  scoreA: number | null;
  scoreB: number | null;
  submitted: boolean;
  type: "normal" | "tournament" | "custom" | "floater";
  pool?: number;
  poolLabel?: string;
  seedA?: number;
  seedB?: number;
  penalty?: number;
  date?: string;
  benched?: number[]; // for floater rows (multiple sitting out)
  floater?: number; // legacy single floater
};

export type TournamentTeam = {
  id: string;
  name: string;
  players: number[];
};

export type TournamentFixture = {
  id: string;
  teamA: string;
  teamB: string;
  scoreA: number | null;
  scoreB: number | null;
  completed: boolean;
  round: "league" | "semi" | "final";
  label?: string;
};

export type TournamentState = {
  active: boolean;
  stage: "league" | "semi" | "final" | "completed";
  teams: TournamentTeam[];
  fixtures: TournamentFixture[];
};

export type TournamentStanding = {
  teamId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  diff: number;
  points: number;
  form: Array<"W" | "L">;
};

export type AppState = {
  players: Player[];
  matches: Match[];
  currentMatches: Match[];
  customLocked: { teamA: number[]; teamB: number[]; type: string; poolLabel?: string } | null;
  mode: "normal" | "tournament";
  nextId: number;
  courts: number;
  matchTarget: number;
  dayKey: string; // ISO date string for "today" — used to auto-reset gamesToday
  tournament?: TournamentState;
};

export const todayKey = () => new Date().toISOString().slice(0, 10);

export function api(p: Player) {
  if (!p.gamesPlayed) return 0;
  return (p.totalFor - p.totalAgainst) / p.gamesPlayed;
}

// Bayesian-shrunk ranking score used by the live leaderboard.
// Shrinks small-sample players toward 0 so a regular's average is not
// undercut by a casual's lucky hot streak (or one tournament).
// K = 5 → players with ≥5 games are essentially unaffected;
// players with 1-4 games get pulled slightly toward the mean.
export const RANKING_SHRINKAGE = 5;
export function rankingScore(p: Player) {
  if (!p.gamesPlayed) return 0;
  return (p.totalFor - p.totalAgainst) / Math.max(p.gamesPlayed, RANKING_SHRINKAGE);
}

// Fisher-Yates shuffle (true random for tiebreaks).
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


// Anti-repeat penalty against last 20 matches.
function matchupPenalty(pairA: number[], pairB: number[], history: Match[]) {
  const recent = history.slice(-20);
  const nA = [...pairA].sort().join(",");
  const nB = [...pairB].sort().join(",");
  let pen = 0;
  for (const m of recent) {
    if (!m.teamA || !m.teamB) continue;
    const sA = [...m.teamA].sort().join(",");
    const sB = [...m.teamB].sort().join(",");
    if ((sA === nA && sB === nB) || (sA === nB && sB === nA)) pen += 3;
  }
  return pen;
}

// Balance 4 players into two teams by rating (high+low vs middle two),
// pick the variant with the lowest anti-repeat penalty.
function balanceFour(four: Player[], history: Match[]) {
  const byRating = [...four].sort((a, b) => b.rating - a.rating);
  const variants: Array<{ teamA: number[]; teamB: number[] }> = [
    { teamA: [byRating[0].id, byRating[3].id], teamB: [byRating[1].id, byRating[2].id] },
    { teamA: [byRating[0].id, byRating[2].id], teamB: [byRating[1].id, byRating[3].id] },
    { teamA: [byRating[0].id, byRating[1].id], teamB: [byRating[2].id, byRating[3].id] },
  ];
  let best = variants[0];
  let bestPen = Infinity;
  for (const v of variants) {
    const pen = matchupPenalty(v.teamA, v.teamB, history);
    // Prefer balanced split (variant 0) when penalties tie.
    if (pen < bestPen) {
      best = v;
      bestPen = pen;
    }
  }
  return best;
}

/**
 * Anti-Stagnation + Multi-Court generator.
 *
 * Rules implemented:
 *  - Sort present players by gamesToday ASC (least played first).
 *  - True random shuffle BEFORE the sort so ties are broken randomly each call.
 *  - Pick exactly 4 * courtsActuallyUsed players to play; everyone else sits out.
 *  - For 1 court with 6-7 present: 4 play, 2-3 bench → benched have gamesToday=0,
 *    so the next call will pull them onto the court.
 *  - For 2 courts with 10+ present: pull the 8 players with the lowest gamesToday,
 *    then split each group of 4 into a tier/rating-balanced match.
 *  - Increment gamesToday for everyone selected so the next round rotates the bench.
 */
export function generateBalancedMatches(
  state: AppState,
  courtsRequested: number,
): { currentMatches: Match[]; players: Player[] } | { error: string } {
  const present = state.players.filter((p) => p.present);
  if (present.length < 4) return { error: "Need at least 4 present players." };

  const courtsActuallyUsed = Math.max(
    1,
    Math.min(courtsRequested, Math.floor(present.length / 4)),
  );
  const slots = courtsActuallyUsed * 4;

  // 1) Random shuffle, then stable sort by gamesToday asc → randomised tiebreak.
  const ordered = shuffle(present).sort(
    (a, b) => (a.gamesToday || 0) - (b.gamesToday || 0),
  );

  const playing = ordered.slice(0, slots);
  const benched = ordered.slice(slots);

  // 2) Build balanced matches for each court.
  const ms: Match[] = [];
  const now = Date.now();
  for (let c = 0; c < courtsActuallyUsed; c++) {
    const four = playing.slice(c * 4, c * 4 + 4);
    const teams = balanceFour(four, state.matches);
    ms.push({
      id: now + c,
      teamA: teams.teamA,
      teamB: teams.teamB,
      scoreA: null,
      scoreB: null,
      submitted: false,
      type: "normal",
      date: new Date().toISOString(),
    });
  }

  // 3) Bench row.
  if (benched.length) {
    ms.push({
      id: now + 999,
      teamA: [],
      teamB: [],
      scoreA: null,
      scoreB: null,
      submitted: false,
      type: "floater",
      benched: benched.map((p) => p.id),
    });
  }

  // 4) Bump gamesToday for everyone selected to play this round.
  const playingIds = new Set(playing.map((p) => p.id));
  const players = state.players.map((p) =>
    playingIds.has(p.id) ? { ...p, gamesToday: (p.gamesToday || 0) + 1 } : p,
  );

  return { currentMatches: ms, players };
}

// Reset gamesToday when the day rolls over.
export function rolloverDayIfNeeded(state: AppState): AppState {
  const today = todayKey();
  if (state.dayKey === today) return state;
  return {
    ...state,
    dayKey: today,
    players: state.players.map((p) => ({ ...p, gamesToday: 0 })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tournament utilities
// ─────────────────────────────────────────────────────────────────────────────

export function generateTournamentFixtures(teams: TournamentTeam[]): TournamentFixture[] {
  const fixtures: TournamentFixture[] = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      fixtures.push({
        id: `L-${teams[i].id}-${teams[j].id}`,
        teamA: teams[i].id,
        teamB: teams[j].id,
        scoreA: null,
        scoreB: null,
        completed: false,
        round: "league",
      });
    }
  }
  return fixtures;
}

export function calculateTournamentTable(
  teams: TournamentTeam[],
  fixtures: TournamentFixture[],
): TournamentStanding[] {
  const map = new Map<string, TournamentStanding>();
  for (const t of teams) {
    map.set(t.id, {
      teamId: t.id,
      name: t.name,
      played: 0,
      won: 0,
      lost: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      diff: 0,
      points: 0,
      form: [],
    });
  }
  for (const f of fixtures) {
    if (f.round !== "league" || !f.completed || f.scoreA == null || f.scoreB == null) continue;
    const a = map.get(f.teamA);
    const b = map.get(f.teamB);
    if (!a || !b) continue;
    a.played++; b.played++;
    a.pointsFor += f.scoreA; a.pointsAgainst += f.scoreB;
    b.pointsFor += f.scoreB; b.pointsAgainst += f.scoreA;
    if (f.scoreA > f.scoreB) {
      a.won++; a.points += 2; a.form.push("W");
      b.lost++; b.form.push("L");
    } else {
      b.won++; b.points += 2; b.form.push("W");
      a.lost++; a.form.push("L");
    }
  }
  for (const s of map.values()) {
    s.diff = s.pointsFor - s.pointsAgainst;
    s.form = s.form.slice(-5);
  }
  return [...map.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.diff - x.diff ||
      y.pointsFor - x.pointsFor ||
      x.name.localeCompare(y.name),
  );
}

// Build knockout fixtures from league standings. Returns new fixtures to append.
export function buildKnockoutFixtures(
  standings: TournamentStanding[],
): { fixtures: TournamentFixture[]; stage: "semi" | "final" } {
  if (standings.length <= 4) {
    // Final only: 1 vs 2
    return {
      stage: "final",
      fixtures: [
        {
          id: "F-1",
          teamA: standings[0].teamId,
          teamB: standings[1].teamId,
          scoreA: null,
          scoreB: null,
          completed: false,
          round: "final",
          label: "Final",
        },
      ],
    };
  }
  // Semis: 1v4, 2v3, then final TBD
  return {
    stage: "semi",
    fixtures: [
      {
        id: "SF-1",
        teamA: standings[0].teamId,
        teamB: standings[3].teamId,
        scoreA: null, scoreB: null, completed: false, round: "semi", label: "SF1 · 1 vs 4",
      },
      {
        id: "SF-2",
        teamA: standings[1].teamId,
        teamB: standings[2].teamId,
        scoreA: null, scoreB: null, completed: false, round: "semi", label: "SF2 · 2 vs 3",
      },
    ],
  };
}

// Build balanced doubles teams for a tournament with TRUE randomness.
// Strategy:
//  - Sort players by rating descending.
//  - Split into TOP half and BOTTOM half.
//  - Shuffle each half independently.
//  - Pair top[i] with bottom[i] → every team has one stronger + one weaker
//    player, but the SPECIFIC partners vary every call.
// Requires an even number of players.
export function buildBalancedTournamentTeams(players: Player[]): TournamentTeam[] {
  if (players.length < 4 || players.length % 2 !== 0) return [];
  const byRating = [...players].sort((a, b) => b.rating - a.rating);
  const half = byRating.length / 2;
  const top = shuffle(byRating.slice(0, half));
  const bot = shuffle(byRating.slice(half));
  const teams: TournamentTeam[] = [];
  for (let i = 0; i < half; i++) {
    const a = top[i];
    const b = bot[i];
    teams.push({
      id: `T${i + 1}-${Math.random().toString(36).slice(2, 7)}`,
      name: `${a.name.split(" ")[0]} & ${b.name.split(" ")[0]}`,
      players: [a.id, b.id],
    });
  }
  return shuffle(teams).map((t, i) => ({ ...t, id: `T${i + 1}` }));
}

// Apply a completed match result to player stats (used by both Normal & Tournament).
export function applyMatchToPlayers(
  players: Player[],
  teamA: number[],
  teamB: number[],
  scoreA: number,
  scoreB: number,
): Player[] {
  const setA = new Set(teamA);
  const setB = new Set(teamB);
  return players.map((p) => {
    if (setA.has(p.id)) {
      return {
        ...p,
        gamesPlayed: (p.gamesPlayed || 0) + 1,
        totalFor: (p.totalFor || 0) + scoreA,
        totalAgainst: (p.totalAgainst || 0) + scoreB,
      };
    }
    if (setB.has(p.id)) {
      return {
        ...p,
        gamesPlayed: (p.gamesPlayed || 0) + 1,
        totalFor: (p.totalFor || 0) + scoreB,
        totalAgainst: (p.totalAgainst || 0) + scoreA,
      };
    }
    return p;
  });
}

// Reverse a previously-applied match result. Used when editing/correcting a submitted score.
export function revertMatchFromPlayers(
  players: Player[],
  teamA: number[],
  teamB: number[],
  scoreA: number,
  scoreB: number,
): Player[] {
  const setA = new Set(teamA);
  const setB = new Set(teamB);
  return players.map((p) => {
    if (setA.has(p.id)) {
      return {
        ...p,
        gamesPlayed: Math.max((p.gamesPlayed || 0) - 1, 0),
        totalFor: Math.max((p.totalFor || 0) - scoreA, 0),
        totalAgainst: Math.max((p.totalAgainst || 0) - scoreB, 0),
      };
    }
    if (setB.has(p.id)) {
      return {
        ...p,
        gamesPlayed: Math.max((p.gamesPlayed || 0) - 1, 0),
        totalFor: Math.max((p.totalFor || 0) - scoreB, 0),
        totalAgainst: Math.max((p.totalAgainst || 0) - scoreA, 0),
      };
    }
    return p;
  });
}
