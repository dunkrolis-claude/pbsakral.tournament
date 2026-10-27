// Logika skor wasit (murni, tanpa akses DB) — dipakai admin-mutate untuk aksi REF_*.
// Disimpan per pertandingan dengan CAS retry di sisi server supaya beberapa wasit
// yang menyimpan skor bersamaan tidak saling menimpa.

const SWITCH_AT = 21; // tukar lapangan saat poin pertama mencapai 21, skor berlanjut

function fail(code, status) {
  return Object.assign(new Error(code), { code, status: status || 400 });
}

function snap(ls) {
  return {
    scoreA: ls.scoreA, scoreB: ls.scoreB, servingSide: ls.servingSide,
    serverToggleA: ls.serverToggleA, serverToggleB: ls.serverToggleB,
    switchSeen: !!ls.switchSeen, switchAck: !!ls.switchAck,
  };
}

function findDownstream(list, matchId) {
  for (const m of list) {
    if (m.sideA && m.sideA.type === "winnerOf" && m.sideA.matchId === matchId) return { match: m, key: "sideA" };
    if (m.sideB && m.sideB.type === "winnerOf" && m.sideB.matchId === matchId) return { match: m, key: "sideB" };
    if (m.sideA && m.sideA.resolvedFrom === matchId) return { match: m, key: "sideA" };
    if (m.sideB && m.sideB.resolvedFrom === matchId) return { match: m, key: "sideB" };
  }
  return null;
}

function finishMatch(m, list, who, nowIso) {
  const ls = m.liveScoring;
  if (ls.scoreA === ls.scoreB) throw fail("score_tied");
  const winnerSide = ls.scoreA > ls.scoreB ? m.sideA : m.sideB;
  m.scoreA = ls.scoreA; m.scoreB = ls.scoreB;
  m.kokCount = ls.kokCount || 1;
  m.winnerParticipantId = winnerSide.participantId;
  m.status = "FINISHED";
  m.actualFinishAt = nowIso;
  m.finishedBy = who;
  // depositCharged sengaja tidak diubah: pembebanan kok dikonfirmasi admin.
  const down = findDownstream(list, m.id);
  if (down) down.match[down.key] = { type: "participant", participantId: m.winnerParticipantId, resolvedFrom: m.id };
}

/**
 * Terapkan satu aksi wasit ke match `m` (mutasi in-place). `names` = { [participantId]: [p1, p2] }.
 * Mengembalikan m. Melempar Error dengan .code/.status bila tidak valid.
 */
function applyRefAction(action, m, list, p, ctx) {
  const who = ctx.who, now = ctx.nowIso, target = ctx.target || 42;
  const closed = ["FINISHED", "WO", "CANCELLED"];

  if (action === "REF_START") {
    if (closed.includes(m.status)) throw fail("match_closed", 409);
    if (m.liveScoring && m.status === "ON_COURT") return m; // idempoten: jangan reset skor
    const a = m.sideA && m.sideA.type === "participant" && m.sideA.participantId;
    const b = m.sideB && m.sideB.type === "participant" && m.sideB.participantId;
    if (!a || !b) throw fail("sides_unknown", 409);
    const na = ctx.names[a], nb = ctx.names[b];
    if (!na || !nb) throw fail("participant_not_found", 409);
    const side = p.servingSide === "B" ? "B" : "A";
    const idx = p.serverIdx === 1 ? 1 : 0;
    m.liveScoring = {
      sideAPlayers: na, sideBPlayers: nb, scoreA: 0, scoreB: 0, servingSide: side,
      serverToggleA: side === "A" ? idx : 0, serverToggleB: side === "B" ? idx : 0,
      kokCount: 1, history: [], startedAt: now, switchSeen: false, switchAck: false, lastBy: who,
    };
    m.status = "ON_COURT";
    if (!m.actualStartAt) m.actualStartAt = now;
    return m;
  }

  if (!m.liveScoring) throw fail("not_started", 409);
  const ls = m.liveScoring;
  if (closed.includes(m.status)) throw fail("match_closed", 409);
  ls.lastBy = who;

  if (action === "REF_POINT") {
    const side = p.side === "B" ? "B" : p.side === "A" ? "A" : null;
    if (!side) throw fail("side_required");
    if (p.expect && (p.expect.a !== ls.scoreA || p.expect.b !== ls.scoreB)) throw fail("stale_score", 409);
    ls.history.push(snap(ls));
    const wasServing = ls.servingSide === side;
    if (side === "A") ls.scoreA += 1; else ls.scoreB += 1;
    if (!wasServing) {
      if (side === "A") ls.serverToggleA = 1 - ls.serverToggleA; else ls.serverToggleB = 1 - ls.serverToggleB;
      ls.servingSide = side;
    }
    if (!ls.switchSeen && Math.max(ls.scoreA, ls.scoreB) >= SWITCH_AT) { ls.switchSeen = true; ls.switchAck = false; }
    if (ls.scoreA >= target || ls.scoreB >= target) finishMatch(m, list, who, now);
    return m;
  }
  if (action === "REF_UNDO") {
    if (!ls.history.length) throw fail("nothing_to_undo", 409);
    Object.assign(ls, ls.history.pop());
    return m;
  }
  if (action === "REF_ACK_SWITCH") { ls.switchAck = true; return m; }
  if (action === "REF_KOK") { ls.kokCount = (ls.kokCount || 1) + 1; return m; }
  if (action === "REF_FINISH_NOW") { finishMatch(m, list, who, now); return m; }
  throw fail("unknown_action");
}

module.exports = { applyRefAction, SWITCH_AT };
