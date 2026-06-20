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
