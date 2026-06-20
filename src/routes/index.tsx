import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  api,
  rankingScore,
  generateBalancedMatches,
  rolloverDayIfNeeded,
  todayKey,
  generateTournamentFixtures,
  calculateTournamentTable,
  buildKnockoutFixtures,
  buildBalancedTournamentTeams,
  applyMatchToPlayers,
  revertMatchFromPlayers,
  type AppState,
  type Match,
  type Player,
  type TournamentState,
  type TournamentTeam,
  type TournamentFixture,
  type TournamentStanding,
} from "@/lib/shuttle-logic";

import {
  getAppState,
  updateAppState,
  verifyAdminPassword,
  updateAdminPassword,
} from "@/lib/shuttle.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ShuttleScore · Club Tracker" },
      {
        name: "description",
        content:
          "Live badminton club tracker with fair bench rotation, balanced matchmaking, and real-time scores across every phone.",
      },
      { property: "og:title", content: "ShuttleScore · Club Tracker" },
      {
        property: "og:description",
        content: "Live badminton club tracker — rankings, courts, and scores in real time.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap",
      },
    ],
  }),
  component: ShuttleScoreApp,
});

// ─────────────────────────────────────────────
// Helpers (UI-only)
// ─────────────────────────────────────────────
const tierText = (t: number) => (t === 1 ? "T1" : t === 2 ? "T2" : t === 3 ? "T3" : "New");
const formatAPI = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(1);
const apiColor = (v: number) =>
  v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : "var(--muted)";
const fmtDate = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";
const todayStr = () =>
  new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

function getStreak(pid: number, matches: Match[]) {
  const mine = matches
    .filter((m) => (m.teamA || []).includes(pid) || (m.teamB || []).includes(pid))
    .slice(-5);
  let streak = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    const m = mine[i];
    const inA = (m.teamA || []).includes(pid);
    const won =
      (inA && (m.scoreA ?? 0) > (m.scoreB ?? 0)) ||
      (!inA && (m.scoreB ?? 0) > (m.scoreA ?? 0));
    if (won) streak++;
    else break;
  }
  return streak;
}

function TierDot({ t }: { t: number }) {
  return <span className={`tdot t${t}`} />;
}

// ─────────────────────────────────────────────
// Root component
// ─────────────────────────────────────────────
function ShuttleScoreApp() {
  const fetchState = useServerFn(getAppState);
  const writeState = useServerFn(updateAppState);
  const verifyPw = useServerFn(verifyAdminPassword);
  const changePw = useServerFn(updateAdminPassword);

  const [state, setState] = useState<AppState | null>(null);
  const [nav, setNav] = useState<"board" | "courts" | "tournament" | "history" | "admin">("board");
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(false);

  // Admin: HMAC-signed session token (opaque to the client) cached in localStorage.
  // The password itself is never stored or compared on the client.
  const [adminToken, setAdminToken] = useState<string>(() =>
    typeof window === "undefined" ? "" : localStorage.getItem("ss_admin_token") || "",
  );
  const isAdmin = !!adminToken && !!state;

  const toastTimer = useRef<number | null>(null);
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  };

  // Initial load + realtime subscription.
  useEffect(() => {
    let alive = true;
    fetchState()
      .then((r) => {
        if (!alive) return;
        setState(rolloverDayIfNeeded(r.data));
        setOnline(true);
      })
      .catch((e) => {
        console.error(e);
        showToast("⚠ Failed to load state");
      });

    const channel = supabase
      .channel("app_state_room")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "app_state" },
        (payload) => {
          const next = (payload.new as { data: AppState })?.data;
          if (next) setState(rolloverDayIfNeeded(next));
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setOnline(true);
      });

    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Day rollover persists once a real write happens; not auto-persisted to avoid
  // every viewer racing to write. Server applies its own rollover on next write.

  const present = useMemo(
    () => (state ? state.players.filter((p) => p.present) : []),
    [state],
  );

  // ─────────────────────────────────────────────
  // Mutations: every write goes through the server fn.
  // ─────────────────────────────────────────────
  const commit = async (patch: Partial<AppState>, opts: { silent?: boolean } = {}) => {
    if (!state) return;
    if (!adminToken) {
      showToast("🔐 Admin login required");
      return;
    }
    try {
      const merged = rolloverDayIfNeeded({ ...state, ...patch } as AppState);
      const finalPatch: Partial<AppState> = {
        ...patch,
        dayKey: merged.dayKey,
        players: patch.players ?? merged.players,
      };
      await writeState({ data: { token: adminToken, patch: finalPatch } });
      if (!opts.silent) showToast("✅ Saved");
    } catch (e: any) {
      const msg = e?.message || "Save failed";
      showToast("⚠ " + msg);
      if (/session expired|sign in/i.test(msg)) {
        localStorage.removeItem("ss_admin_token");
        setAdminToken("");
      }
    }
  };

  if (!state) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
        Loading club data…
      </div>
    );
  }

  return (
    <>
      <Header
        mode={state.mode}
        online={online}
        onToggleMode={() =>
          commit({ mode: state.mode === "normal" ? "tournament" : "normal" }, { silent: true })
        }
        isAdmin={isAdmin}
      />

      <div id="screens" className="screen">
        {nav === "board" && <Leaderboard state={state} present={present} />}
        {nav === "courts" && <CourtsView state={state} isAdmin={isAdmin} onEdit={editScore} />}
        {nav === "tournament" && (
          <TournamentView state={state} isAdmin={isAdmin} commit={commit} showToast={showToast} />
        )}
        {nav === "history" && <HistoryView state={state} />}
        {nav === "admin" && (
          <AdminView
            state={state}
            isAdmin={isAdmin}
            onLogin={async (pw) => {
              try {
                const { token } = await verifyPw({ data: { password: pw } });
                localStorage.setItem("ss_admin_token", token);
                setAdminToken(token);
                showToast("🔓 Admin unlocked");
              } catch (e: any) {
                showToast("⚠ " + (e?.message || "Login failed"));
              }
            }}
            onLogout={() => {
              localStorage.removeItem("ss_admin_token");
              setAdminToken("");
              showToast("Locked");
            }}
            onChangePassword={async (newPw) => {
              const { token } = await changePw({
                data: { token: adminToken, newPassword: newPw },
              });
              localStorage.setItem("ss_admin_token", token);
              setAdminToken(token);
            }}
            commit={commit}
            showToast={showToast}
          />
        )}
      </div>

      <BottomNav nav={nav} setNav={setNav} />

      {toast && (
        <div id="toast" className="show">
          {toast}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────
function Header({
  mode,
  online,
  onToggleMode,
  isAdmin,
}: {
  mode: AppState["mode"];
  online: boolean;
  onToggleMode: () => void;
  isAdmin: boolean;
}) {
  return (
    <div id="appHeader">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 32,
            height: 32,
            background: "var(--gold)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 17,
          }}
        >
          🏸
        </div>
        <div>
          <div
            className="font-display"
            style={{ fontSize: 17, fontWeight: 800, lineHeight: 1, color: "white" }}
          >
            ShuttleScore
          </div>
          <div id="syncBar">
            <span
              className={online ? "online-dot" : ""}
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: online ? "var(--green)" : "var(--muted)",
                flexShrink: 0,
              }}
            />
            <span>{online ? "Live sync" : "Connecting…"}</span>
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className={`badge ${mode === "tournament" ? "badge-tourn" : "badge-normal"}`}>
          {mode === "tournament" ? "Tournament" : "Normal Day"}
        </span>
        {isAdmin && (
          <button
            onClick={onToggleMode}
            style={{
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "5px 10px",
              fontSize: 11,
              color: "var(--muted)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            ⇄
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Bottom nav
// ─────────────────────────────────────────────
function BottomNav({
  nav,
  setNav,
}: {
  nav: string;
  setNav: (n: "board" | "courts" | "tournament" | "history" | "admin") => void;
}) {
  const items: Array<{ k: "board" | "courts" | "tournament" | "history" | "admin"; icon: string; label: string }> = [
    { k: "board", icon: "🏆", label: "Rankings" },
    { k: "courts", icon: "🏸", label: "Courts" },
    { k: "tournament", icon: "🥇", label: "Tournament" },
    { k: "history", icon: "📜", label: "History" },
    { k: "admin", icon: "🔐", label: "Admin" },
  ];
  return (
    <div id="bottomNav">
      {items.map((it) => (
        <button
          key={it.k}
          className={`nav-btn ${nav === it.k ? "active" : ""}`}
          onClick={() => setNav(it.k)}
        >
          <span className="nav-icon">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────
function Leaderboard({ state, present }: { state: AppState; present: Player[] }) {
  const ranked = useMemo(
    () => state.players.filter((p) => p.gamesPlayed >= 3).sort((a, b) => rankingScore(b) - rankingScore(a)),
    [state.players],
  );
  const unranked = useMemo(
    () => state.players.filter((p) => p.gamesPlayed < 3).sort((a, b) => b.rating - a.rating),
    [state.players],
  );
  const maxA = ranked.length ? Math.max(...ranked.map((p) => Math.abs(rankingScore(p))), 1) : 1;


  let best = { name: "—", streak: 0 };
  state.players.forEach((p) => {
    const s = getStreak(p.id, state.matches);
    if (s > best.streak) best = { name: p.name, streak: s };
  });

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px 6px",
        }}
      >
        <div className="font-display" style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
          Live Rankings
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>Min. 3 games · fair-weighted</div>
      </div>

      <div
        className="scroll-sec"
        style={{ display: "flex", gap: 8, padding: "0 16px 12px" }}
      >
        <StatCard color="var(--gold)" value={ranked.length} label="Ranked" />
        <StatCard color="var(--teal)" value={state.matches.length} label="Matches" />
        <StatCard color="white" value={present.length} label="Here today" />
        <StatCard
          color="#f87171"
          value={best.streak >= 3 ? `${best.name}(${best.streak}🔥)` : "—"}
          label="Hot streak 🔥"
        />
      </div>

      <div id="leaderList" className="card" style={{ margin: "0 16px" }}>
        {ranked.length === 0 ? (
          <div
            style={{
              padding: 20,
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            No ranked players yet.
            <br />
            Play 3+ games to appear here.
          </div>
        ) : (
          ranked.map((p, i) => {
            const r = i + 1;
            const rc = r <= 3 ? `r${r}` : "";
            const av = rankingScore(p);
            const bw = Math.min(100, (Math.abs(av) / maxA) * 100);

            const streak = getStreak(p.id, state.matches);
            return (
              <div key={p.id} className="rank-row">
                <div className={`rank-num ${rc}`}>{r}</div>
                <TierDot t={p.tier} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        color: "white",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.name}
                    </span>
                    {streak >= 3 && <span className="flame">🔥</span>}
                    <span className={`tc${p.tier}`} style={{ fontSize: 11, marginLeft: 2 }}>
                      {tierText(p.tier)}
                    </span>
                  </div>
                  <div className="api-track">
                    <div
                      className={av >= 0 ? "api-fill api-pos" : "api-fill api-neg"}
                      style={{ width: `${bw}%` }}
                    />
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div
                    className="font-display"
                    style={{ fontSize: 18, fontWeight: 700, color: apiColor(av) }}
                  >
                    {formatAPI(av)}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>
                    {p.gamesPlayed}g · {p.totalFor}-{p.totalAgainst}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="sec-label" style={{ marginTop: 16 }}>
        All Players
      </div>
      <div className="card" style={{ margin: "0 16px 20px" }}>
        {unranked.map((p) => {
          const left = Math.max(0, 3 - p.gamesPlayed);
          const streak = getStreak(p.id, state.matches);
          return (
            <div key={p.id} className="rank-row">
              <TierDot t={p.tier} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500, fontSize: 13, color: "white" }}>{p.name}</span>
                {streak >= 3 && <span className="flame">🔥</span>}
                <span className={`tc${p.tier}`} style={{ fontSize: 11, marginLeft: 4 }}>
                  {tierText(p.tier)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "right" }}>
                {p.gamesPlayed
                  ? `${p.gamesPlayed}g · ${left} to rank`
                  : `No games · ${left} to rank`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatCard({
  color,
  value,
  label,
}: {
  color: string;
  value: string | number;
  label: string;
}) {
  return (
    <div
      className="card-sm"
      style={{ padding: "10px 14px", flexShrink: 0, textAlign: "center" }}
    >
      <div className="font-display" style={{ fontSize: 20, fontWeight: 800, color }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)" }}>{label}</div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Courts view
// ─────────────────────────────────────────────
function CourtsView({ state }: { state: AppState }) {
  const byId = (id: number) => state.players.find((p) => p.id === id);
  const courts = state.courts || 2;

  const realMatches = state.currentMatches.filter((m) => m.type !== "floater");
  const floater = state.currentMatches.find((m) => m.type === "floater");
  const playing = realMatches.filter((m) => !m.submitted).slice(0, courts);
  const pending = realMatches.filter((m) => !m.submitted).slice(courts);
  const done = realMatches.filter((m) => m.submitted);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px 6px",
        }}
      >
        <div className="font-display" style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
          Today's Courts
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)" }}>
          {state.players.filter((p) => p.present).length} present
        </div>
      </div>
      <div style={{ padding: "0 16px 12px", fontSize: 12, color: "var(--muted)" }}>
        {todayStr()}
      </div>

      <div style={{ padding: "0 16px" }}>
        {state.currentMatches.length === 0 ? (
          <div
            className="card"
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            No matches generated yet.
            <br />
            Go to Admin → Generate Balanced Matches.
          </div>
        ) : (
          <>
            {playing.length > 0 && (
              <>
                <SectionLabel color="var(--teal)">▶ On Court</SectionLabel>
                {playing.map((m, i) => (
                  <CourtCard key={m.id} m={m} byId={byId} index={i} state="playing" />
                ))}
              </>
            )}

            {pending.length > 0 && (
              <>
                <SectionLabel color="var(--gold)">⏳ On Deck</SectionLabel>
                {pending.map((m) => (
                  <CourtCard key={m.id} m={m} byId={byId} state="ondeck" />
                ))}
              </>
            )}

            {floater && floater.benched && floater.benched.length > 0 && (
              <div
                className="card-sm"
                style={{
                  padding: "10px 14px",
                  textAlign: "center",
                  margin: "10px 0",
                }}
              >
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Sitting out · </span>
                <span style={{ fontWeight: 600, color: "white" }}>
                  {floater.benched.map((id) => byId(id)?.name).filter(Boolean).join(", ")}
                </span>
              </div>
            )}

            {done.length > 0 && (
              <>
                <SectionLabel color="var(--muted)">✓ Completed</SectionLabel>
                {done.map((m) => {
                  const tA = m.teamA.map(byId).filter(Boolean) as Player[];
                  const tB = m.teamB.map(byId).filter(Boolean) as Player[];
                  const wA = (m.scoreA ?? 0) > (m.scoreB ?? 0);
                  return (
                    <div
                      key={m.id}
                      className="card"
                      style={{ marginBottom: 8, padding: "10px 14px" }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          fontSize: 13,
                        }}
                      >
                        <div
                          style={{
                            flex: 1,
                            fontWeight: wA ? 600 : undefined,
                            color: wA ? "white" : "var(--muted)",
                          }}
                        >
                          {tA.map((p) => p.name).join(" & ")}
                        </div>
                        <div
                          className="font-display"
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: "white",
                            flexShrink: 0,
                          }}
                        >
                          {m.scoreA}–{m.scoreB}
                        </div>
                        <div
                          style={{
                            flex: 1,
                            textAlign: "right",
                            fontWeight: !wA ? 600 : undefined,
                            color: !wA ? "white" : "var(--muted)",
                          }}
                        >
                          {tB.map((p) => p.name).join(" & ")}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        margin: "12px 0 8px",
      }}
    >
      {children}
    </div>
  );
}

function CourtCard({
  m,
  byId,
  index,
  state,
}: {
  m: Match;
  byId: (id: number) => Player | undefined;
  index?: number;
  state: "playing" | "ondeck";
}) {
  const tA = m.teamA.map(byId).filter(Boolean) as Player[];
  const tB = m.teamB.map(byId).filter(Boolean) as Player[];
  return (
    <div className="card" style={{ marginBottom: state === "playing" ? 10 : 8, overflow: "hidden" }}>
      {state === "playing" && (
        <div
          style={{
            background: "rgba(13,148,136,0.08)",
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--teal)",
            fontWeight: 700,
            letterSpacing: "0.05em",
          }}
        >
          COURT {(index ?? 0) + 1}
        </div>
      )}
      <div className="court-lane" style={state === "ondeck" ? { padding: "10px 12px" } : undefined}>
        <div className="team-col">
          {tA.map((p) => (
            <div key={p.id} className={`player-chip ${state}`}>
              <TierDot t={p.tier} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
            </div>
          ))}
        </div>
        <span className="vs-pill" style={state === "ondeck" ? { opacity: 0.6 } : undefined}>
          {state === "playing" ? "VS" : "UP"}
        </span>
        <div className="team-col" style={{ alignItems: "flex-end" }}>
          {tB.map((p) => (
            <div key={p.id} className={`player-chip ${state}`}>
              <TierDot t={p.tier} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// History view
// ─────────────────────────────────────────────
function HistoryView({ state }: { state: AppState }) {
  const byId = (id: number) => state.players.find((p) => p.id === id);
  const hist = [...state.matches].reverse();

  const exportCSV = () => {
    const rows = [["Name", "Tier", "Games", "For", "Against", "API", "Rating"]];
    state.players.forEach((p) =>
      rows.push([
        p.name,
        String(p.tier),
        String(p.gamesPlayed || 0),
        String(p.totalFor || 0),
        String(p.totalAgainst || 0),
        api(p).toFixed(2),
        String(p.rating),
      ]),
    );
    const blob = new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shuttlescore_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px 10px",
        }}
      >
        <div className="font-display" style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
          Match History
        </div>
        <button onClick={exportCSV} className="btn btn-outline btn-sm">
          ⬇ CSV
        </button>
      </div>
      <div style={{ padding: "0 16px 20px" }}>
        {hist.length === 0 ? (
          <div
            style={{
              color: "var(--muted)",
              textAlign: "center",
              padding: "40px 0",
              fontSize: 13,
            }}
          >
            No matches played yet.
          </div>
        ) : (
          hist.map((m) => {
            const tA = (m.teamA || []).map(byId).filter(Boolean) as Player[];
            const tB = (m.teamB || []).map(byId).filter(Boolean) as Player[];
            const wA = (m.scoreA ?? 0) > (m.scoreB ?? 0);
            return (
              <div key={m.id} className="hist-row">
                <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
                  {fmtDate(m.date)} {m.poolLabel ? `· ${m.poolLabel}` : ""}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: wA ? "white" : "var(--muted)",
                        fontWeight: wA ? 600 : undefined,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tA.map((p) => p.name).join(" & ")}
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        color: !wA ? "white" : "var(--muted)",
                        fontWeight: !wA ? 600 : undefined,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tB.map((p) => p.name).join(" & ")}
                    </div>
                  </div>
                  <div
                    className="font-display"
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: "white",
                      flexShrink: 0,
                    }}
                  >
                    {m.scoreA}–{m.scoreB}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────
type CommitFn = (patch: Partial<AppState>, opts?: { silent?: boolean }) => Promise<void>;

function AdminView({
  state,
  isAdmin,
  onLogin,
  onLogout,
  onChangePassword,
  commit,
  showToast,
}: {
  state: AppState;
  isAdmin: boolean;
  onLogin: (pw: string) => void;
  onLogout: () => void;
  onChangePassword: (newPw: string) => Promise<void>;
  commit: CommitFn;
  showToast: (msg: string) => void;
}) {
  const [pwInput, setPwInput] = useState("");

  if (!isAdmin) {
    return (
      <div style={{ padding: "40px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
          <div className="font-display" style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
            Admin Access
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
            Enter the admin password to manage the club.
          </div>
        </div>
        <input
          className="inp"
          type="password"
          placeholder="Password"
          value={pwInput}
          onChange={(e) => setPwInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onLogin(pwInput);
          }}
        />
        <button
          className="btn btn-gold"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => onLogin(pwInput)}
        >
          Unlock Admin
        </button>
      </div>
    );
  }

  return (
    <AdminPanel
      state={state}
      commit={commit}
      onLogout={onLogout}
      onChangePassword={onChangePassword}
      showToast={showToast}
    />
  );
}

function AdminPanel({
  state,
  commit,
  onLogout,
  onChangePassword,
  showToast,
}: {
  state: AppState;
  commit: CommitFn;
  onLogout: () => void;
  onChangePassword: (newPw: string) => Promise<void>;
  showToast: (msg: string) => void;
}) {
  const present = state.players.filter((p) => p.present);
  const tiers: Array<{ t: 0 | 1 | 2; label: string }> = [
    { t: 1, label: "Tier 1 · Advanced" },
    { t: 2, label: "Tier 2 · Intermediate" },
    { t: 0, label: "New / Unrated" },
  ];

  const toggleAtt = (id: number) => {
    const players = state.players.map((p) =>
      p.id === id ? { ...p, present: !p.present } : p,
    );
    commit({ players }, { silent: true });
  };
  const selAll = (v: boolean) => {
    commit(
      { players: state.players.map((p) => ({ ...p, present: v })) },
      { silent: true },
    );
  };

  const setCourts = (n: number) => commit({ courts: n }, { silent: true });
  const setTarget = (n: number) => commit({ matchTarget: n }, { silent: true });

  const generate = () => {
    const result = generateBalancedMatches({ ...state, dayKey: todayKey() }, state.courts || 2);
    if ("error" in result) {
      showToast("⚠ " + result.error);
      return;
    }
    let currentMatches: Match[] = result.currentMatches;
    if (state.customLocked) {
      const exists = currentMatches.some(
        (m) =>
          JSON.stringify([...m.teamA].sort()) ===
          JSON.stringify([...(state.customLocked!.teamA || [])].sort()),
      );
      if (!exists) {
        currentMatches = [
          {
            id: Date.now(),
            teamA: state.customLocked.teamA,
            teamB: state.customLocked.teamB,
            scoreA: null,
            scoreB: null,
            submitted: false,
            type: "custom",
            poolLabel: state.customLocked.poolLabel || "Custom",
          },
          ...currentMatches,
        ];
      }
    }
    commit({ currentMatches, players: result.players });
    showToast("🏸 Matches generated!");
  };

  const submitScore = (mid: number | string, sA: number, sB: number) => {
    const target = state.matchTarget || 21;
    const cap = target === 21 ? 30 : 20;
    if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) return showToast("⚠ Enter valid scores.");
    if (sA === sB) return showToast("⚠ Scores cannot be equal.");
    if (sA > cap || sB > cap) return showToast(`⚠ Max score is ${cap}.`);
    const winner = Math.max(sA, sB);
    const loser = Math.min(sA, sB);
    if (winner < target) return showToast(`⚠ Winning score must be at least ${target}.`);
    if (loser >= target - 1 && winner - loser < 2)
      return showToast(`⚠ At deuce, you need a 2-point lead (up to ${cap}).`);

    const idx = state.currentMatches.findIndex((m) => m.id === mid);
    if (idx < 0) return;
    const m = state.currentMatches[idx];
    const updated: Match = {
      ...m,
      scoreA: sA,
      scoreB: sB,
      submitted: true,
      date: new Date().toISOString(),
    };
    const currentMatches = [...state.currentMatches];
    currentMatches[idx] = updated;
    const matches = [...state.matches, updated];

    const players = state.players.map((p) => {
      const inA = (m.teamA || []).includes(p.id);
      const inB = (m.teamB || []).includes(p.id);
      if (!inA && !inB) return p;
      const forS = inA ? sA : sB;
      const agS = inA ? sB : sA;
      return {
        ...p,
        gamesPlayed: (p.gamesPlayed || 0) + 1,
        totalFor: (p.totalFor || 0) + forS,
        totalAgainst: (p.totalAgainst || 0) + agS,
      };
    });

    commit({ currentMatches, matches, players });
  };

  const editScore = (mid: number | string, sA: number, sB: number) => {
    const target = state.matchTarget || 21;
    const cap = target === 21 ? 30 : 20;
    if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) return showToast("⚠ Enter valid scores.");
    if (sA === sB) return showToast("⚠ Scores cannot be equal.");
    if (sA > cap || sB > cap) return showToast(`⚠ Max score is ${cap}.`);
    const winner = Math.max(sA, sB);
    const loser = Math.min(sA, sB);
    if (winner < target) return showToast(`⚠ Winning score must be at least ${target}.`);
    if (loser >= target - 1 && winner - loser < 2)
      return showToast(`⚠ At deuce, you need a 2-point lead (up to ${cap}).`);

    const histIdx = state.matches.findIndex((m) => m.id === mid);
    const curIdx = state.currentMatches.findIndex((m) => m.id === mid);
    const prev =
      histIdx >= 0 ? state.matches[histIdx] : curIdx >= 0 ? state.currentMatches[curIdx] : null;
    if (!prev || !prev.submitted) return showToast("⚠ Match not found.");
    if (prev.scoreA === sA && prev.scoreB === sB) return;

    let players = revertMatchFromPlayers(
      state.players,
      prev.teamA,
      prev.teamB,
      prev.scoreA ?? 0,
      prev.scoreB ?? 0,
    );
    players = applyMatchToPlayers(players, prev.teamA, prev.teamB, sA, sB);

    const updated: Match = { ...prev, scoreA: sA, scoreB: sB, date: new Date().toISOString() };
    const matches =
      histIdx >= 0 ? state.matches.map((m, i) => (i === histIdx ? updated : m)) : state.matches;
    const currentMatches =
      curIdx >= 0
        ? state.currentMatches.map((m, i) => (i === curIdx ? updated : m))
        : state.currentMatches;

    commit({ matches, currentMatches, players });
    showToast("✓ Score updated");
  };

  const addPlayer = (name: string, tier: 0 | 1 | 2, rating: number) => {
    if (!name.trim()) return showToast("⚠ Enter a name.");
    const player: Player = {
      id: state.nextId,
      name: name.trim(),
      tier,
      freq: "New",
      rating,
      gamesPlayed: 0,
      totalFor: 0,
      totalAgainst: 0,
      present: false,
      gamesToday: 0,
    };
    commit({ players: [...state.players, player], nextId: state.nextId + 1 });
  };

  const resetStats = () => {
    if (!confirm("Reset all match stats? Player list is preserved.")) return;
    commit({
      players: state.players.map((p) => ({
        ...p,
        gamesPlayed: 0,
        totalFor: 0,
        totalAgainst: 0,
        present: false,
        gamesToday: 0,
      })),
      matches: [],
      currentMatches: [],
      customLocked: null,
    });
  };

  const resetToday = () => {
    commit({
      players: state.players.map((p) => ({ ...p, gamesToday: 0 })),
      currentMatches: [],
      dayKey: todayKey(),
    });
    showToast("🔄 Today's bench rotation reset");
  };

  return (
    <div style={{ paddingBottom: 20 }}>
      <div className="sec-label">
        Attendance <span style={{ color: "var(--gold)" }}>{present.length}</span> present
      </div>
      <div className="card" style={{ margin: "0 16px" }}>
        <div
          style={{
            display: "flex",
            gap: 6,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button onClick={() => selAll(true)} className="btn btn-outline btn-sm">
            All
          </button>
          <button onClick={() => selAll(false)} className="btn btn-outline btn-sm">
            None
          </button>
          <div style={{ flex: 1 }} />
          <span
            style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center" }}
          >
            {present.length >= 10 ? "→ Tournament (10+)" : "→ Normal (<10)"}
          </span>
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {tiers.map(({ t, label }) => {
            const group = state.players.filter((p) => p.tier === t);
            if (!group.length) return null;
            return (
              <div key={t}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    padding: "8px 14px 4px",
                  }}
                >
                  {label}
                </div>
                {group.map((p) => (
                  <div key={p.id} className="att-row" onClick={() => toggleAtt(p.id)}>
                    <div className={`att-check ${p.present ? "on" : ""}`}>
                      {p.present && (
                        <svg
                          width="12"
                          height="12"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="white"
                          strokeWidth="3"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <TierDot t={p.tier} />
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, color: "white" }}>
                        {p.name}
                      </span>
                      <span style={{ fontSize: 11, marginLeft: 6, color: "var(--muted)" }}>
                        · {p.gamesToday || 0} today
                      </span>
                    </div>
                    <span className={`tc${p.tier}`} style={{ fontSize: 11 }}>
                      {tierText(p.tier)}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="sec-label">Match Settings</div>
      <div className="card" style={{ margin: "0 16px", padding: "12px 14px" }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5 }}>Match target</div>
            <select
              className="inp"
              style={{ padding: "8px 10px" }}
              value={state.matchTarget}
              onChange={(e) => setTarget(parseInt(e.target.value))}
            >
              <option value={21}>21 points (deuce to 30)</option>
              <option value={15}>15 points (deuce to 20)</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 5 }}>
              Courts available
            </div>
            <select
              className="inp"
              style={{ padding: "8px 10px" }}
              value={state.courts}
              onChange={(e) => setCourts(parseInt(e.target.value))}
            >
              <option value={1}>1 court</option>
              <option value={2}>2 courts</option>
              <option value={3}>3 courts</option>
            </select>
          </div>
        </div>
      </div>

      <div className="sec-label">Match Generator</div>
      <div
        style={{ margin: "0 16px", display: "flex", flexDirection: "column", gap: 8 }}
      >
        <button className="btn btn-gold" onClick={generate} style={{ width: "100%" }}>
          🏸 Generate Balanced Matches
        </button>
        <CustomMatchButton state={state} commit={commit} showToast={showToast} />
        <button className="btn btn-outline" onClick={resetToday} style={{ width: "100%" }}>
          ♻ Reset Today's Bench Rotation
        </button>
      </div>

      <div className="sec-label">Tournament</div>
      <div style={{ margin: "0 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        <CreateTournamentButton state={state} commit={commit} showToast={showToast} />
        <CustomTournamentBuilder state={state} commit={commit} showToast={showToast} />
        {state.tournament?.active && (
          <button
            className="btn btn-outline"
            style={{ width: "100%" }}
            onClick={() => {
              if (!confirm("End and clear the current tournament?")) return;
              commit({ tournament: { active: false, stage: "completed", teams: [], fixtures: [] } });
            }}
          >
            ✖ Clear Tournament
          </button>
        )}
      </div>


      <ScoreSection state={state} onSubmit={submitScore} />

      <div className="sec-label">Add Player</div>
      <AddPlayerForm onAdd={addPlayer} />

      <div className="sec-label">Tools</div>
      <div style={{ margin: "0 16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ExportButtons state={state} showToast={showToast} />
        <ChangePasswordButton onChangePassword={onChangePassword} showToast={showToast} />
        <button onClick={resetStats} className="btn btn-red btn-sm">
          ⚠ Reset All Stats
        </button>
        <button onClick={onLogout} className="btn btn-outline btn-sm">
          🔒 Lock Admin
        </button>
      </div>
    </div>
  );
}

function ScoreSection({
  state,
  onSubmit,
}: {
  state: AppState;
  onSubmit: (mid: number | string, sA: number, sB: number) => void;
}) {
  const byId = (id: number) => state.players.find((p) => p.id === id);
  const pending = state.currentMatches.filter((m) => m.type !== "floater" && !m.submitted);
  const [scores, setScores] = useState<Record<string, { a: string; b: string }>>({});
  if (!pending.length) return null;
  const target = state.matchTarget || 21;
  const cap = target === 21 ? 30 : 20;
  return (
    <>
      <div className="sec-label">Enter Scores</div>
      <div style={{ margin: "0 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {pending.map((m) => {
          const tA = m.teamA.map(byId).filter(Boolean) as Player[];
          const tB = m.teamB.map(byId).filter(Boolean) as Player[];
          const key = String(m.id);
          const s = scores[key] || { a: "", b: "" };
          return (
            <div key={key} className="card" style={{ padding: "12px 14px" }}>
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 8 }}>
                {m.poolLabel || "Match"} · Target: {target} pts (cap {cap})
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: "white",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tA.map((p) => p.name).join(" & ")}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                  <input
                    type="number"
                    className="inp-score"
                    min={0}
                    max={cap}
                    placeholder={String(target)}
                    value={s.a}
                    onChange={(e) =>
                      setScores({ ...scores, [key]: { ...s, a: e.target.value } })
                    }
                  />
                  <span style={{ color: "var(--muted)", fontWeight: 700 }}>–</span>
                  <input
                    type="number"
                    className="inp-score"
                    min={0}
                    max={cap}
                    placeholder={String(target)}
                    value={s.b}
                    onChange={(e) =>
                      setScores({ ...scores, [key]: { ...s, b: e.target.value } })
                    }
                  />
                </div>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: "white",
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tB.map((p) => p.name).join(" & ")}
                </div>
              </div>
              <button
                className="btn btn-gold"
                style={{ width: "100%" }}
                onClick={() => onSubmit(m.id, parseInt(s.a), parseInt(s.b))}
              >
                Submit Score
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AddPlayerForm({
  onAdd,
}: {
  onAdd: (name: string, tier: 0 | 1 | 2, rating: number) => void;
}) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<0 | 1 | 2>(2);
  const [rating, setRating] = useState(800);
  return (
    <div className="card" style={{ margin: "0 16px", padding: "12px 14px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input
          className="inp"
          type="text"
          placeholder="Player name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <select
            className="inp"
            style={{ flex: 1, padding: "8px 10px" }}
            value={tier}
            onChange={(e) => setTier(parseInt(e.target.value) as 0 | 1 | 2)}
          >
            <option value={1}>Tier 1 – Advanced</option>
            <option value={2}>Tier 2 – Intermediate</option>
            <option value={0}>New / Unrated</option>
          </select>
          <input
            className="inp"
            type="number"
            value={rating}
            style={{ width: 80 }}
            onChange={(e) => setRating(parseInt(e.target.value) || 800)}
          />
        </div>
        <button
          className="btn btn-teal"
          style={{ width: "100%" }}
          onClick={() => {
            onAdd(name, tier, rating);
            setName("");
          }}
        >
          Add Player
        </button>
      </div>
    </div>
  );
}

function ExportButtons({
  state,
  showToast,
}: {
  state: AppState;
  showToast: (msg: string) => void;
}) {
  const dl = (content: string, name: string, type: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
  };
  return (
    <>
      <button
        onClick={() => {
          dl(
            JSON.stringify({ players: state.players, matches: state.matches }, null, 2),
            `shuttlescore_${new Date().toISOString().slice(0, 10)}.json`,
            "application/json",
          );
          showToast("📦 JSON exported!");
        }}
        className="btn btn-outline btn-sm"
      >
        ⬇ JSON
      </button>
      <button
        onClick={() => {
          const rows = [["Name", "Tier", "Games", "For", "Against", "API", "Rating"]];
          state.players.forEach((p) =>
            rows.push([
              p.name,
              String(p.tier),
              String(p.gamesPlayed || 0),
              String(p.totalFor || 0),
              String(p.totalAgainst || 0),
              api(p).toFixed(2),
              String(p.rating),
            ]),
          );
          dl(
            rows.map((r) => r.join(",")).join("\n"),
            `shuttlescore_${new Date().toISOString().slice(0, 10)}.csv`,
            "text/csv",
          );
          showToast("📊 CSV exported!");
        }}
        className="btn btn-outline btn-sm"
      >
        ⬇ CSV
      </button>
    </>
  );
}

function ChangePasswordButton({
  onChangePassword,
  showToast,
}: {
  onChangePassword: (newPw: string) => Promise<void>;
  showToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <>
      <button onClick={() => setOpen((o) => !o)} className="btn btn-outline btn-sm">
        🔑 Password
      </button>
      {open && (
        <div style={{ margin: "8px 0 0", display: "flex", gap: 6, width: "100%" }}>
          <input
            className="inp"
            type="password"
            placeholder="New password"
            value={pw1}
            onChange={(e) => setPw1(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            className="inp"
            type="password"
            placeholder="Confirm"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-gold btn-sm"
            disabled={saving}
            onClick={async () => {
              if (!pw1) return showToast("Enter a password.");
              if (pw1.length < 4) return showToast("Password must be 4+ chars.");
              if (pw1 !== pw2) return showToast("Passwords do not match.");
              setSaving(true);
              try {
                await onChangePassword(pw1);
                showToast("🔑 Password updated — notification emailed");
                setOpen(false);
                setPw1("");
                setPw2("");
              } catch (e: any) {
                showToast("⚠ " + (e?.message || "Update failed"));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "…" : "Save"}
          </button>
        </div>
      )}
    </>
  );
}

function CustomMatchButton({
  state,
  commit,
  showToast,
}: {
  state: AppState;
  commit: CommitFn;
  showToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState<"A" | "B">("A");
  const [a, setA] = useState<number[]>([]);
  const [b, setB] = useState<number[]>([]);
  const present = state.players.filter((p) => p.present);
  const byId = (id: number) => state.players.find((p) => p.id === id);

  const add = (pid: number) => {
    const arr = team === "A" ? a : b;
    const setArr = team === "A" ? setA : setB;
    if (arr.includes(pid)) setArr(arr.filter((x) => x !== pid));
    else if (arr.length < 2) setArr([...arr, pid]);
    else showToast("Each team can have max 2 players.");
  };

  const lock = async () => {
    if (a.length !== 2 || b.length !== 2)
      return showToast("⚠ Each team needs exactly 2 players.");
    await commit({
      customLocked: { teamA: a, teamB: b, type: "custom", poolLabel: "Custom" },
    });
    setOpen(false);
    setA([]);
    setB([]);
    showToast("🔒 Custom match locked in!");
  };

  return (
    <>
      <button className="btn btn-outline" onClick={() => setOpen(true)} style={{ width: "100%" }}>
        ✏️ Custom Match Creator
      </button>
      {open && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal-sheet">
            <div className="modal-handle" />
            <div
              className="font-display"
              style={{ fontSize: 20, fontWeight: 800, marginBottom: 4, color: "white" }}
            >
              Custom Match Creator
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
              Tap a team button, then tap player to assign.
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button
                onClick={() => setTeam("A")}
                className="btn btn-outline btn-sm"
                style={{
                  flex: 1,
                  borderColor: team === "A" ? "var(--teal)" : "var(--border)",
                  color: team === "A" ? "var(--teal)" : "var(--muted)",
                }}
              >
                + Team A
              </button>
              <button
                onClick={() => setTeam("B")}
                className="btn btn-outline btn-sm"
                style={{
                  flex: 1,
                  borderColor: team === "B" ? "var(--teal)" : "var(--border)",
                  color: team === "B" ? "var(--teal)" : "var(--muted)",
                }}
              >
                + Team B
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <Slot team="A" ids={a} byId={byId} onRemove={(id) => setA(a.filter((x) => x !== id))} />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "0 4px",
                }}
              >
                <span className="vs-pill">VS</span>
              </div>
              <Slot team="B" ids={b} byId={byId} onRemove={(id) => setB(b.filter((x) => x !== id))} />
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Present players</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
              {present.map((p) => {
                const used = a.includes(p.id) || b.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => add(p.id)}
                    style={{
                      background: used ? "rgba(245,158,11,0.15)" : "var(--surface2)",
                      border: used
                        ? "1px solid rgba(245,158,11,0.4)"
                        : "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "6px 10px",
                      fontSize: 12,
                      color: used ? "var(--gold)" : "var(--text)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <TierDot t={p.tier} />
                    <span>{p.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={lock} className="btn btn-gold" style={{ flex: 2 }}>
                🔒 Lock This Match
              </button>
              <button onClick={() => setOpen(false)} className="btn btn-outline" style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Slot({
  team: _team,
  ids,
  byId,
  onRemove,
}: {
  team: "A" | "B";
  ids: number[];
  byId: (id: number) => Player | undefined;
  onRemove: (id: number) => void;
}) {
  return (
    <div style={{ flex: 1 }}>
      <div className="custom-slot">
        {ids.length === 0 ? (
          <span style={{ color: "var(--muted)", fontSize: 12 }}>Tap player below</span>
        ) : (
          ids.map((id) => {
            const p = byId(id);
            if (!p) return null;
            return (
              <div key={id} className="slot-chip">
                <TierDot t={p.tier} />
                <span>{p.name}</span>
                <span className="rm" onClick={() => onRemove(id)}>
                  ✕
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Tournament: admin "Create from present" button
// ─────────────────────────────────────────────
function CreateTournamentButton({
  state,
  commit,
  showToast,
}: {
  state: AppState;
  commit: CommitFn;
  showToast: (msg: string) => void;
}) {
  const present = state.players.filter((p) => p.present);
  const onClick = () => {
    if (present.length < 8) {
      showToast("⚠ Need at least 8 present players.");
      return;
    }
    if (present.length % 2 !== 0) {
      showToast("⚠ Need an even number of present players.");
      return;
    }
    if (state.tournament?.active) {
      if (!confirm("A tournament is already active. Re-roll a new randomised draw?")) return;
    }
    // Randomised balanced pairing (top half × bottom half, both shuffled).
    const teams = buildBalancedTournamentTeams(present);
    if (!teams.length) {
      showToast("⚠ Could not build teams.");
      return;
    }
    const fixtures = generateTournamentFixtures(teams);
    const tournament: TournamentState = {
      active: true,
      stage: "league",
      teams,
      fixtures,
    };
    commit({ tournament, mode: "tournament" });
    showToast(`🥇 Tournament created · ${teams.length} teams · ${fixtures.length} matches`);
  };
  return (
    <button className="btn btn-gold" style={{ width: "100%" }} onClick={onClick}>
      🎲 Auto-Draw Tournament ({present.length} present)
    </button>
  );
}

// ─────────────────────────────────────────────
// Tournament: Custom team builder (manual pairing)
// ─────────────────────────────────────────────
function CustomTournamentBuilder({
  state,
  commit,
  showToast,
}: {
  state: AppState;
  commit: CommitFn;
  showToast: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const present = state.players.filter((p) => p.present);
  // teamOf[playerId] = teamIndex (0-based) or undefined = unassigned
  const [teamOf, setTeamOf] = useState<Record<number, number | undefined>>({});

  const numTeams = Math.max(2, Math.floor(present.length / 2));
  const teamBuckets: number[][] = Array.from({ length: numTeams }, () => []);
  for (const p of present) {
    const t = teamOf[p.id];
    if (t != null && t < numTeams) teamBuckets[t].push(p.id);
  }
  const unassigned = present.filter((p) => teamOf[p.id] == null);

  const playerName = (id: number) =>
    state.players.find((x) => x.id === id)?.name.split(" ")[0] || `#${id}`;

  const assign = (pid: number, t: number | undefined) =>
    setTeamOf((m) => ({ ...m, [pid]: t }));

  const autoFill = () => {
    // Fill any unassigned players into smallest-team-first slots.
    const map = { ...teamOf };
    const buckets = teamBuckets.map((b) => [...b]);
    for (const p of unassigned) {
      let target = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (buckets[i].length < buckets[target].length) target = i;
      }
      buckets[target].push(p.id);
      map[p.id] = target;
    }
    setTeamOf(map);
  };

  const start = () => {
    // Validation: each team must have exactly 2 players; no leftovers.
    if (Object.keys(teamOf).length < present.length) {
      showToast("⚠ Assign every present player to a team first.");
      return;
    }
    const teams: TournamentTeam[] = [];
    for (let i = 0; i < numTeams; i++) {
      const ids = teamBuckets[i];
      if (ids.length !== 2) {
        showToast(`⚠ Team ${i + 1} must have exactly 2 players.`);
        return;
      }
      teams.push({
        id: `T${i + 1}`,
        name: ids.map(playerName).join(" & "),
        players: ids,
      });
    }
    if (teams.length < 2) {
      showToast("⚠ Need at least 2 teams.");
      return;
    }
    if (state.tournament?.active) {
      if (!confirm("Replace the active tournament with this custom draw?")) return;
    }
    const fixtures = generateTournamentFixtures(teams);
    commit({
      tournament: { active: true, stage: "league", teams, fixtures },
      mode: "tournament",
    });
    showToast(`🥇 Custom tournament started · ${teams.length} teams`);
    setOpen(false);
    setTeamOf({});
  };

  if (!open) {
    return (
      <button
        className="btn btn-outline"
        style={{ width: "100%" }}
        onClick={() => setOpen(true)}
        disabled={present.length < 4}
      >
        🛠 Build Custom Teams ({present.length} present)
      </button>
    );
  }

  return (
    <div className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "white", fontWeight: 700, fontSize: 14 }}>
          🛠 Custom Teams · {numTeams} teams of 2
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>

      {unassigned.length > 0 && (
        <div>
          <div className="sec-label" style={{ margin: "0 0 6px", padding: 0 }}>
            Unassigned ({unassigned.length})
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {unassigned.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 8px",
                  background: "var(--bg-2, rgba(255,255,255,0.05))",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "white",
                }}
              >
                <span>{p.name}</span>
                <select
                  value=""
                  onChange={(e) => assign(p.id, parseInt(e.target.value))}
                  style={{
                    background: "transparent",
                    color: "var(--gold)",
                    border: "none",
                    fontSize: 11,
                  }}
                >
                  <option value="">→ team</option>
                  {teamBuckets.map((b, i) =>
                    b.length < 2 ? (
                      <option key={i} value={i} style={{ color: "black" }}>
                        Team {i + 1}
                      </option>
                    ) : null,
                  )}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {teamBuckets.map((ids, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 10px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: ids.length === 2 ? "rgba(212,175,55,0.08)" : "transparent",
            }}
          >
            <div style={{ color: "var(--gold)", fontWeight: 700, fontSize: 12, width: 56 }}>
              Team {i + 1}
            </div>
            <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {ids.length === 0 && (
                <span style={{ color: "var(--muted)", fontSize: 12 }}>empty</span>
              )}
              {ids.map((pid) => (
                <span
                  key={pid}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 6px",
                    background: "rgba(255,255,255,0.06)",
                    borderRadius: 4,
                    fontSize: 12,
                    color: "white",
                  }}
                >
                  {playerName(pid)}
                  <button
                    onClick={() => assign(pid, undefined)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--muted)",
                      cursor: "pointer",
                      fontSize: 12,
                      padding: 0,
                    }}
                    aria-label="remove"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-outline btn-sm" onClick={autoFill} style={{ flex: 1 }}>
          ✨ Auto-fill rest
        </button>
        <button className="btn btn-outline btn-sm" onClick={() => setTeamOf({})} style={{ flex: 1 }}>
          ♻ Clear
        </button>
        <button className="btn btn-gold btn-sm" onClick={start} style={{ flex: 1.4 }}>
          🥇 Start
        </button>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────
// TournamentView
// ─────────────────────────────────────────────
function TournamentView({
  state,
  isAdmin,
  commit,
  showToast,
}: {
  state: AppState;
  isAdmin: boolean;
  commit: CommitFn;
  showToast: (msg: string) => void;
}) {
  const t = state.tournament;
  if (!t || !t.active) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🥇</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "white", marginBottom: 6 }}>
          No tournament running
        </div>
        <div style={{ fontSize: 13 }}>
          An admin can start one from the Admin tab → Tournament section.
        </div>
      </div>
    );
  }

  const standings = useMemo(() => calculateTournamentTable(t.teams, t.fixtures), [t]);
  const leagueFixtures = t.fixtures.filter((f) => f.round === "league");
  const knockoutFixtures = t.fixtures.filter((f) => f.round !== "league");
  const leaguePlayed = leagueFixtures.filter((f) => f.completed).length;
  const leagueTotal = leagueFixtures.length;
  const leagueDone = leaguePlayed === leagueTotal && leagueTotal > 0;

  // Auto-create knockout fixtures when league completes.
  useEffect(() => {
    if (!isAdmin) return;
    if (!leagueDone) return;
    if (knockoutFixtures.length > 0) return;
    const ko = buildKnockoutFixtures(standings);
    const next: TournamentState = {
      ...t,
      stage: ko.stage,
      fixtures: [...t.fixtures, ...ko.fixtures],
    };
    commit({ tournament: next }, { silent: true });
    showToast(ko.stage === "final" ? "🏆 Final set!" : "🥈 Semi-finals set!");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueDone, knockoutFixtures.length, isAdmin]);

  // Auto-create final after semis complete.
  const semis = t.fixtures.filter((f) => f.round === "semi");
  const semisDone = semis.length > 0 && semis.every((f) => f.completed);
  const hasFinal = t.fixtures.some((f) => f.round === "final");
  useEffect(() => {
    if (!isAdmin) return;
    if (!semisDone || hasFinal) return;
    const winners = semis.map((s) =>
      (s.scoreA ?? 0) > (s.scoreB ?? 0) ? s.teamA : s.teamB,
    );
    const finalFx: TournamentFixture = {
      id: "F-1",
      teamA: winners[0],
      teamB: winners[1],
      scoreA: null,
      scoreB: null,
      completed: false,
      round: "final",
      label: "Final",
    };
    commit(
      { tournament: { ...t, stage: "final", fixtures: [...t.fixtures, finalFx] } },
      { silent: true },
    );
    showToast("🏆 Final set!");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semisDone, hasFinal, isAdmin]);

  // Mark tournament completed when final is done.
  const finalFx = t.fixtures.find((f) => f.round === "final");
  useEffect(() => {
    if (!isAdmin) return;
    if (finalFx?.completed && t.stage !== "completed") {
      commit({ tournament: { ...t, stage: "completed" } }, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalFx?.completed, t.stage, isAdmin]);

  const teamName = (id: string) => t.teams.find((x) => x.id === id)?.name || "—";

  const submitFixtureScore = (fid: string, sA: number, sB: number) => {
    const target = state.matchTarget || 21;
    const cap = target === 21 ? 30 : 20;
    if (isNaN(sA) || isNaN(sB) || sA < 0 || sB < 0) return showToast("⚠ Enter valid scores.");
    if (sA === sB) return showToast("⚠ Scores cannot be equal.");
    if (sA > cap || sB > cap) return showToast(`⚠ Max score is ${cap}.`);
    const winner = Math.max(sA, sB);
    const loser = Math.min(sA, sB);
    if (winner < target) return showToast(`⚠ Winning score must be at least ${target}.`);
    if (loser >= target - 1 && winner - loser < 2)
      return showToast(`⚠ At deuce, you need a 2-point lead (up to ${cap}).`);
    // Guard against double-counting if an already-completed fixture is re-submitted.
    const target_f = t.fixtures.find((f) => f.id === fid);
    if (!target_f || target_f.completed) return;
    const fixtures = t.fixtures.map((f) =>
      f.id === fid ? { ...f, scoreA: sA, scoreB: sB, completed: true } : f,
    );
    // Credit player stats so tournament results feed into Live Rankings.
    // Per-game average normalisation keeps it fair for players who skip tournaments.
    const teamAPlayers = t.teams.find((x) => x.id === target_f.teamA)?.players || [];
    const teamBPlayers = t.teams.find((x) => x.id === target_f.teamB)?.players || [];
    const players = applyMatchToPlayers(state.players, teamAPlayers, teamBPlayers, sA, sB);
    // Also log the match into history so streaks/exports include tournament games.
    const histMatch: Match = {
      id: `tourn-${fid}-${Date.now()}`,
      teamA: teamAPlayers,
      teamB: teamBPlayers,
      scoreA: sA,
      scoreB: sB,
      submitted: true,
      type: "tournament",
      date: new Date().toISOString(),
    };
    commit({
      tournament: { ...t, fixtures },
      players,
      matches: [...state.matches, histMatch],
    });
  };


  // Top picks
  const topCount = t.teams.length > 4 ? 4 : 2;

  // Analytics
  const completedAll = t.fixtures.filter((f) => f.completed);
  const biggestWin = completedAll.reduce<{ diff: number; label: string } | null>((acc, f) => {
    const d = Math.abs((f.scoreA ?? 0) - (f.scoreB ?? 0));
    const s = `${teamName(f.teamA)} ${f.scoreA}–${f.scoreB} ${teamName(f.teamB)}`;
    return !acc || d > acc.diff ? { diff: d, label: s } : acc;
  }, null);
  const closestMatch = completedAll.reduce<{ diff: number; label: string } | null>((acc, f) => {
    const d = Math.abs((f.scoreA ?? 0) - (f.scoreB ?? 0));
    const s = `${teamName(f.teamA)} ${f.scoreA}–${f.scoreB} ${teamName(f.teamB)}`;
    return !acc || d < acc.diff ? { diff: d, label: s } : acc;
  }, null);
  const topAttack = standings.reduce<TournamentStanding | null>(
    (a, s) => (!a || s.pointsFor > a.pointsFor ? s : a),
    null,
  );
  const topDefence = standings.reduce<TournamentStanding | null>(
    (a, s) => (!a || s.pointsAgainst < a.pointsAgainst ? s : a),
    null,
  );

  return (
    <div style={{ paddingBottom: 20 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px 6px",
        }}
      >
        <div className="font-display" style={{ fontSize: 22, fontWeight: 800, color: "white" }}>
          Tournament
        </div>
        <span className="badge badge-tourn" style={{ textTransform: "capitalize" }}>
          {t.stage}
        </span>
      </div>

      <div
        className="scroll-sec"
        style={{ display: "flex", gap: 8, padding: "0 16px 12px" }}
      >
        <StatCard color="var(--gold)" value={t.teams.length} label="Teams" />
        <StatCard color="var(--teal)" value={leaguePlayed} label="Played" />
        <StatCard color="white" value={Math.max(leagueTotal - leaguePlayed, 0)} label="Remaining" />
        <StatCard color="#f87171" value={completedAll.length} label="Total done" />
      </div>

      <div className="sec-label">
        Standings · Top {topCount}
      </div>
      <div className="card" style={{ margin: "0 16px", overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "20px 1fr 28px 28px 28px 40px 28px",
            gap: 6,
            padding: "8px 12px",
            fontSize: 10,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>#</div>
          <div>Team</div>
          <div style={{ textAlign: "right" }}>P</div>
          <div style={{ textAlign: "right" }}>W</div>
          <div style={{ textAlign: "right" }}>L</div>
          <div style={{ textAlign: "right" }}>+/−</div>
          <div style={{ textAlign: "right" }}>Pts</div>
        </div>
        {standings.map((s, i) => {
          const isTop = i < topCount;
          return (
            <div
              key={s.teamId}
              style={{
                display: "grid",
                gridTemplateColumns: "20px 1fr 28px 28px 28px 40px 28px",
                gap: 6,
                padding: "10px 12px",
                fontSize: 13,
                color: "white",
                background: isTop ? "rgba(212,175,55,0.08)" : "transparent",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ color: isTop ? "var(--gold)" : "var(--muted)", fontWeight: 700 }}>
                {i + 1}
              </div>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.name}
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                  Form: {s.form.length ? s.form.join(" ") : "—"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>{s.played}</div>
              <div style={{ textAlign: "right", color: "var(--green)" }}>{s.won}</div>
              <div style={{ textAlign: "right", color: "var(--red)" }}>{s.lost}</div>
              <div
                style={{
                  textAlign: "right",
                  color: s.diff > 0 ? "var(--green)" : s.diff < 0 ? "var(--red)" : "var(--muted)",
                }}
              >
                {s.diff > 0 ? "+" : ""}
                {s.diff}
              </div>
              <div style={{ textAlign: "right", fontWeight: 700, color: "var(--gold)" }}>
                {s.points}
              </div>
            </div>
          );
        })}
      </div>

      <div className="sec-label">League Fixtures</div>
      <div style={{ margin: "0 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {leagueFixtures.map((f) => (
          <FixtureCard
            key={f.id}
            f={f}
            teamName={teamName}
            isAdmin={isAdmin}
            target={state.matchTarget || 21}
            onSubmit={submitFixtureScore}
          />
        ))}
      </div>

      {knockoutFixtures.length > 0 && (
        <>
          <div className="sec-label">Knockouts</div>
          <div style={{ margin: "0 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            {knockoutFixtures.map((f) => (
              <FixtureCard
                key={f.id}
                f={f}
                teamName={teamName}
                isAdmin={isAdmin}
                target={state.matchTarget || 21}
                onSubmit={submitFixtureScore}
              />
            ))}
          </div>
        </>
      )}

      {!leagueDone && t.teams.length > 4 && (
        <div className="sec-label">Knockouts</div>
      )}
      {!leagueDone && t.teams.length > 4 && knockoutFixtures.length === 0 && (
        <div
          className="card"
          style={{
            margin: "0 16px",
            padding: 14,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          Semi-Finals & Final — <em>To Be Determined</em> when league stage completes.
        </div>
      )}

      <div className="sec-label">Analytics</div>
      <div style={{ margin: "0 16px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <MiniStat
          title="🔥 Top Attack"
          value={topAttack ? topAttack.name : "—"}
          sub={topAttack ? `${topAttack.pointsFor} pts for` : ""}
        />
        <MiniStat
          title="🛡 Best Defence"
          value={topDefence && topDefence.played ? topDefence.name : "—"}
          sub={topDefence && topDefence.played ? `${topDefence.pointsAgainst} pts against` : ""}
        />
        <MiniStat
          title="💥 Biggest Win"
          value={biggestWin ? `+${biggestWin.diff}` : "—"}
          sub={biggestWin?.label || ""}
        />
        <MiniStat
          title="🤏 Closest Match"
          value={closestMatch ? `${closestMatch.diff} pt` : "—"}
          sub={closestMatch?.label || ""}
        />
      </div>
    </div>
  );
}

function FixtureCard({
  f,
  teamName,
  isAdmin,
  target,
  onSubmit,
}: {
  f: TournamentFixture;
  teamName: (id: string) => string;
  isAdmin: boolean;
  target: number;
  onSubmit: (fid: string, sA: number, sB: number) => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const winner =
    f.completed && f.scoreA != null && f.scoreB != null
      ? f.scoreA > f.scoreB
        ? "A"
        : "B"
      : null;
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {f.label || f.round} {f.completed && "· Final"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            fontSize: 14,
            fontWeight: 600,
            color: winner === "A" ? "var(--gold)" : "white",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {teamName(f.teamA)}
        </div>
        {f.completed ? (
          <div style={{ fontWeight: 800, fontSize: 16, color: "white" }}>
            {f.scoreA} – {f.scoreB}
          </div>
        ) : isAdmin ? (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input
              className="inp"
              inputMode="numeric"
              style={{ width: 44, textAlign: "center", padding: "6px 4px" }}
              value={a}
              onChange={(e) => setA(e.target.value)}
            />
            <span style={{ color: "var(--muted)" }}>–</span>
            <input
              className="inp"
              inputMode="numeric"
              style={{ width: 44, textAlign: "center", padding: "6px 4px" }}
              value={b}
              onChange={(e) => setB(e.target.value)}
            />
          </div>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>vs</div>
        )}
        <div
          style={{
            flex: 1,
            fontSize: 14,
            fontWeight: 600,
            color: winner === "B" ? "var(--gold)" : "white",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "right",
          }}
        >
          {teamName(f.teamB)}
        </div>
      </div>
      {!f.completed && isAdmin && (
        <button
          className="btn btn-gold btn-sm"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => {
            onSubmit(f.id, parseInt(a), parseInt(b));
            setA("");
            setB("");
          }}
        >
          Save Score (target {target})
        </button>
      )}
    </div>
  );
}

function MiniStat({ title, value, sub }: { title: string; value: string | number; sub?: string }) {
  return (
    <div className="card" style={{ padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {title}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "white", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
        </div>
      )}
    </div>
  );
}
