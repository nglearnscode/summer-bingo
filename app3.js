/ ===================== DATA =====================
const TEAM = [
  "Elias", "Marcus", "Demi", "Sam", "Ng'ang'a",
  "Aline", "Lucy", "Zahra", "Iris", "Aizha",
];

const PROMPTS = [
  "Your O3 with your CA/RELC",
  "Move-in day at residence",
  "A catch-up with another PF",
  "A sunrise or sunset you chased",
  "Your current read",
  "A meal you're proud of",
  "A new workout, sport, or move you tried",
  "Something you grew or planted",
  "Your hydration setup",
  "A spontaneous adventure",
  "Your journal or notes page",
  "A local spot you discovered",
  "Free space",
  "Something orange",
  "Your favourite summer outfit",
  "A skill you practiced",
  "A moment of stillness",
  "A movie or series you've been watching",
  "A playlist or song on repeat",
  "Your go-to summer snack",
  "A view from somewhere high",
  "A hangout with friends",
  "Something that made you laugh",
  "A small win you're celebrating this week",
  "A reflection (mirror, water, glass)",
];

const FREE_INDEX = 12;
const LOCK_HOURS = 72;
const REACTIONS = ["ð¥", "â¤ï¸", "ð", "ð¤©", "ð­", "ð"];
const GRID_SIZE = 5;

const LINES = (() => {
  const lines = [];
  for (let r = 0; r < GRID_SIZE; r++) lines.push(Array.from({ length: GRID_SIZE }, (_, c) => r * GRID_SIZE + c));
  for (let c = 0; c < GRID_SIZE; c++) lines.push(Array.from({ length: GRID_SIZE }, (_, r) => r * GRID_SIZE + c));
  lines.push(Array.from({ length: GRID_SIZE }, (_, i) => i * GRID_SIZE + i));
  lines.push(Array.from({ length: GRID_SIZE }, (_, i) => i * GRID_SIZE + (GRID_SIZE - 1 - i)));
  return lines;
})();

// ===================== HELPERS =====================
function slugify(str) {
  return String(str)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['â]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function fileToCompressedDataUrl(file, maxDim = 900, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not load image"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function hoursUntilNextUpload(lastTimestamp, lockHours) {
  if (!lastTimestamp) return 0;
  const elapsed = Date.now() - lastTimestamp;
  const lockMs = lockHours * 60 * 60 * 1000;
  const remaining = lockMs - elapsed;
  return remaining > 0 ? remaining / (60 * 60 * 1000) : 0;
}

function formatRemaining(hours) {
  if (hours <= 0) return null;
  const totalMinutes = Math.ceil(hours * 60);
  const d = Math.floor(totalMinutes / (60 * 24));
  const h = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return `${h}h`;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return "No entries yet";
  const diffMs = Date.now() - timestamp;
  const diffHours = diffMs / (60 * 60 * 1000);
  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
}

function bingoProgress(cells) {
  let best = { filled: 0, remaining: GRID_SIZE };
  for (const line of LINES) {
    const filled = line.filter((idx) => cells[idx].done).length;
    if (filled === GRID_SIZE) return { filled: GRID_SIZE, remaining: 0, isBingo: true };
    if (filled > best.filled) best = { filled, remaining: GRID_SIZE - filled };
  }
  return { ...best, isBingo: false };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ===================== DEBUG LOG =====================
window.__fieldLogDebug = window.__fieldLogDebug || [];
function debugLog(entry) {
  const line = `${new Date().toLocaleTimeString()} â ${entry}`;
  window.__fieldLogDebug = [...window.__fieldLogDebug, line].slice(-40);
  const el = document.getElementById("debug-panel-body");
  if (el) renderDebugPanel();
}

// ===================== FIREBASE STORAGE LAYER =====================
// Firestore holds the board's structured data (cells, pin, timestamps).
// Firebase Storage holds the actual photo files (referenced by URL in Firestore).
// This avoids the 5MB-per-document ceiling we hit with Claude's storage â
// Firestore documents stay small (just text/URLs), photos live in dedicated
// object storage designed for exactly this.

function boardDocRef(name) {
  const { db, doc } = window.__firebase;
  return doc(db, "boards", slugify(name));
}

async function loadBoardData(name, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const { getDoc } = window.__firebase;
  try {
    const snap = await getDoc(boardDocRef(name));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (e) {
    const isTransient = /unavailable|timeout|network|internal/i.test(e.message || "");
    if (isTransient && attempt < MAX_ATTEMPTS) {
      debugLog(`loadBoardData(${name}) â ï¸ attempt ${attempt} failed (${e.message}), retryingâ¦`);
      await sleep(400 * attempt);
      return loadBoardData(name, attempt + 1);
    }
    debugLog(`loadBoardData(${name}) â ${e.message || e}`);
    return null;
  }
}

async function saveBoardData(name, data, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  const { setDoc } = window.__firebase;
  try {
    await setDoc(boardDocRef(name), data);
    debugLog(`saveBoardData(${name}) â â ok`);
    return true;
  } catch (e) {
    const isTransient = /unavailable|timeout|network|internal|resource-exhausted/i.test(e.message || "");
    if (isTransient && attempt < MAX_ATTEMPTS) {
      const waitMs = /resource-exhausted/i.test(e.message || "") ? 1500 * attempt : 400 * attempt;
      debugLog(`saveBoardData(${name}) â ï¸ attempt ${attempt} failed (${e.message}), retrying in ${waitMs}msâ¦`);
      await sleep(waitMs);
      return saveBoardData(name, data, attempt + 1);
    }
    debugLog(`saveBoardData(${name}) â ${e.message || e}`);
    throw e;
  }
}

async function uploadPhoto(name, index, dataUrl) {
  const { storage, ref, uploadString, getDownloadURL } = window.__firebase;
  const path = `photos/${slugify(name)}/cell-${index}-${Date.now()}.jpg`;
  debugLog(`uploadPhoto(${name}, ${index}) â attempting path: ${path}`);
  try {
    const photoRef = ref(storage, path);
    await uploadString(photoRef, dataUrl, "data_url");
    const url = await getDownloadURL(photoRef);
    debugLog(`uploadPhoto(${name}, ${index}) â â ok`);
    return url;
  } catch (e) {
    debugLog(`uploadPhoto(${name}, ${index}) â code=${e.code || "?"} message=${e.message || e}`);
    throw e;
  }
}

function emptyBoard() {
  return {
    pin: null,
    lastUploadTimestamp: null,
    cells: PROMPTS.map((_, i) => ({
      done: i === FREE_INDEX,
      photo: null,
      timestamp: i === FREE_INDEX ? Date.now() : null,
      reactions: {},
      comments: [],
    })),
  };
}

async function loadFullBoard(name) {
  const data = await loadBoardData(name);
  if (!data) {
    debugLog(`loadFullBoard(${name}) â no existing data, using empty board`);
    return emptyBoard();
  }
  return {
    pin: data.pin || null,
    lastUploadTimestamp: data.lastUploadTimestamp || null,
    cells: (data.cells || []).map((c, i) => c
      ? { done: !!c.done, photo: c.photo || null, timestamp: c.timestamp || null, reactions: c.reactions || {}, comments: c.comments || [] }
      : { done: i === FREE_INDEX, photo: null, timestamp: i === FREE_INDEX ? Date.now() : null, reactions: {}, comments: [] }),
  };
}

// ===================== APP STATE =====================
const state = {
  view: "home", // home | leaderboard | team | board
  viewHistory: [],
  currentUser: null,
  viewingUser: null,
  boards: {},
  loading: true,
  storageError: false,
  modalIndex: null,
  entryModal: null, // { ownerName, index }
  busy: false,
  pinModal: null, // { mode: 'set' | 'enter', onSuccess }
  pinError: "",
  pinManageOpen: false,
  uploadError: "",
  unlockedBoards: {},
  showDebug: false,
  rotations: {},
};

PROMPTS.forEach((_, i) => { state.rotations[i] = (i * 37) % 17 - 8; });

function setState(patch) {
  Object.assign(state, patch);
  render();
}

// ===================== DATA ACTIONS =====================
async function refreshAll(silent = false) {
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Storage timeout")), 10000));
    const load = Promise.all(TEAM.map(async (name) => [name, await loadFullBoard(name)]));
    const entries = await Promise.race([load, timeout]);
    const freshBoards = Object.fromEntries(entries);

    // If a modal is open (upload in progress, entry view, PIN prompt), update the
    // underlying data silently without a full re-render â a periodic background
    // refresh shouldn't interrupt someone mid-upload or mid-comment. The next
    // natural render (e.g. after they close the modal) will pick up fresh data.
    const hasOpenModal = state.modalIndex !== null || state.entryModal || state.pinModal || state.pinManageOpen;
    if (silent || hasOpenModal) {
      state.boards = freshBoards;
      state.storageError = false;
      state.loading = false;
    } else {
      setState({ boards: freshBoards, storageError: false, loading: false });
    }
  } catch (e) {
    console.error("Storage error:", e);
    if (!silent) setState({ storageError: true, loading: false });
  }
}

function updateLocalBoard(name, patch) {
  const board = state.boards[name];
  if (!board) return;
  state.boards = { ...state.boards, [name]: { ...board, ...patch } };
}

function myBoard() { return state.currentUser ? state.boards[state.currentUser] : null; }
function displayedBoard() { return state.viewingUser ? state.boards[state.viewingUser] : null; }
function isViewingOwnBoard() { return state.viewingUser === state.currentUser; }
function lockRemaining() {
  const mb = myBoard();
  return mb ? hoursUntilNextUpload(mb.lastUploadTimestamp, LOCK_HOURS) : 0;
}
function isLocked() { return lockRemaining() > 0; }
function isPinProtected() { return !!myBoard()?.pin; }
function isUnlockedThisSession() { return state.currentUser ? !!state.unlockedBoards[state.currentUser] : false; }

function requirePinThen(action) {
  if (!myBoard()) return;
  if (isPinProtected() && !isUnlockedThisSession()) {
    setState({ pinError: "", pinModal: { mode: "enter", onSuccess: action } });
    return;
  }
  action();
}

async function handleSubmit(dataUrl) {
  if (state.modalIndex === null || !state.currentUser) return;
  setState({ busy: true, uploadError: "" });
  const mb = myBoard();
  try {
    const photoUrl = await uploadPhoto(state.currentUser, state.modalIndex, dataUrl);
    const cells = [...mb.cells];
    cells[state.modalIndex] = { done: true, photo: photoUrl, timestamp: Date.now(), reactions: {}, comments: [] };
    const updated = { ...mb, cells, lastUploadTimestamp: Date.now() };
    await saveBoardData(state.currentUser, updated);
    updateLocalBoard(state.currentUser, updated);

    const wasFirstUpload = !mb.pin && mb.cells.every((c, i) => i === FREE_INDEX || !c.done);
    setState({ busy: false, modalIndex: null });
    if (wasFirstUpload) {
      setState({
        pinModal: {
          mode: "set",
          onSuccess: async (pin) => {
            if (pin) {
              const withPin = { ...updated, pin };
              try {
                await saveBoardData(state.currentUser, withPin);
                updateLocalBoard(state.currentUser, withPin);
                setState({ unlockedBoards: { ...state.unlockedBoards, [state.currentUser]: true } });
              } catch (e) { console.error(e); }
            }
          },
        },
      });
    }
  } catch (e) {
    console.error(e);
    const rawMessage = e.message || "";
    const codePrefix = e.code ? `[${e.code}] ` : "";
    const friendly = /resource-exhausted|rate/i.test(rawMessage)
      ? "Things are a little busy right now â please wait about 30 seconds and try again."
      : (codePrefix + (rawMessage || "Couldn't save this photo â try a smaller/different photo."));
    setState({ busy: false, uploadError: friendly });
  }
}

function handleDeleteFromEntry() {
  if (!state.entryModal) return;
  const { ownerName, index } = state.entryModal;
  if (ownerName !== state.currentUser) return;
  requirePinThen(async () => {
    const mb = myBoard();
    const cells = [...mb.cells];
    cells[index] = { done: false, photo: null, timestamp: null, reactions: {}, comments: [] };
    const updated = { ...mb, cells };
    try {
      await saveBoardData(state.currentUser, updated);
      updateLocalBoard(state.currentUser, updated);
      setState({ entryModal: null });
    } catch (e) {
      console.error(e);
      setState({ uploadError: e.message || "Couldn't delete this entry â try again." });
    }
  });
}

async function handleReact(ownerName, index, emoji) {
  if (!state.currentUser) return;
  const board = state.boards[ownerName];
  if (!board) return;
  const cell = board.cells[index];
  const existing = cell.reactions[emoji] || [];
  const updatedReactions = {
    ...cell.reactions,
    [emoji]: existing.includes(state.currentUser) ? existing.filter((n) => n !== state.currentUser) : [...existing, state.currentUser],
  };
  const cells = [...board.cells];
  cells[index] = { ...cell, reactions: updatedReactions };
  const updated = { ...board, cells };
  try {
    await saveBoardData(ownerName, updated);
    updateLocalBoard(ownerName, updated);
    render();
  } catch (e) { console.error("Reaction failed to save:", e); }
}

async function handleAddComment(ownerName, index, text) {
  if (!state.currentUser) return;
  const board = state.boards[ownerName];
  if (!board) return;
  const cell = board.cells[index];
  const updatedComments = [...(cell.comments || []), { author: state.currentUser, text, timestamp: Date.now() }];
  const cells = [...board.cells];
  cells[index] = { ...cell, comments: updatedComments };
  const updated = { ...board, cells };
  try {
    await saveBoardData(ownerName, updated);
    updateLocalBoard(ownerName, updated);
    render();
  } catch (e) { console.error("Comment failed to save:", e); }
}

async function handleEditComment(ownerName, index, commentIndex, newText) {
  if (!state.currentUser || !newText) return;
  const board = state.boards[ownerName];
  if (!board) return;
  const cell = board.cells[index];
  const existingComments = cell.comments || [];
  const target = existingComments[commentIndex];
  if (!target || target.author !== state.currentUser) return;
  const updatedComments = existingComments.map((c, i) => (i === commentIndex ? { ...c, text: newText } : c));
  const cells = [...board.cells];
  cells[index] = { ...cell, comments: updatedComments };
  const updated = { ...board, cells };
  try {
    await saveBoardData(ownerName, updated);
    updateLocalBoard(ownerName, updated);
    render();
  } catch (e) { console.error("Comment edit failed:", e); }
}

async function handleDeleteComment(ownerName, index, commentIndex) {
  if (!state.currentUser) return;
  const board = state.boards[ownerName];
  if (!board) return;
  const cell = board.cells[index];
  const existingComments = cell.comments || [];
  const target = existingComments[commentIndex];
  if (!target || target.author !== state.currentUser) return;
  const updatedComments = existingComments.filter((_, i) => i !== commentIndex);
  const cells = [...board.cells];
  cells[index] = { ...cell, comments: updatedComments };
  const updated = { ...board, cells };
  try {
    await saveBoardData(ownerName, updated);
    updateLocalBoard(ownerName, updated);
    render();
  } catch (e) { console.error("Comment delete failed:", e); }
}

async function handleUpdatePin(newPin) {
  if (!state.currentUser) return;
  const mb = myBoard();
  const updated = { ...mb, pin: newPin };
  try {
    await saveBoardData(state.currentUser, updated);
    updateLocalBoard(state.currentUser, updated);
    setState({ unlockedBoards: { ...state.unlockedBoards, [state.currentUser]: true }, pinManageOpen: false, pinError: "" });
  } catch (e) {
    console.error(e);
    setState({ pinError: e.message || "Couldn't update the PIN â try again." });
  }
}

async function handleRemovePin() {
  if (!state.currentUser) return;
  const mb = myBoard();
  const updated = { ...mb, pin: null };
  try {
    await saveBoardData(state.currentUser, updated);
    updateLocalBoard(state.currentUser, updated);
    setState({ pinManageOpen: false, pinError: "" });
  } catch (e) {
    console.error(e);
    setState({ pinError: e.message || "Couldn't remove the PIN â try again." });
  }
}

function handlePinConfirm(value) {
  if (!state.pinModal) return;
  if (state.pinModal.mode === "set") {
    state.pinModal.onSuccess(value);
    setState({ pinModal: null, pinError: "" });
    return;
  }
  const mb = myBoard();
  if (value === mb.pin) {
    setState({ unlockedBoards: { ...state.unlockedBoards, [state.currentUser]: true } });
    state.pinModal.onSuccess();
    setState({ pinModal: null, pinError: "" });
  } else {
    setState({ pinError: "That PIN doesn't match â try again." });
  }
}

// ===================== NAVIGATION =====================
function pushHistory() { state.viewHistory = [...state.viewHistory, { view: state.view, viewingUser: state.viewingUser }]; }
function goHome() { pushHistory(); setState({ view: "home" }); }
function goHomeReset() { setState({ view: "home", viewHistory: [] }); }
function goToMyBoard() { pushHistory(); setState({ viewingUser: state.currentUser, view: "board" }); }
function goToTeamBoards() { pushHistory(); setState({ view: "team" }); }
function goToLeaderboard() { pushHistory(); setState({ view: "leaderboard" }); }
function selectBoardToView(name) { pushHistory(); setState({ viewingUser: name, view: "board" }); }
function goBack() {
  if (state.viewHistory.length === 0) { setState({ view: "home" }); return; }
  const last = state.viewHistory[state.viewHistory.length - 1];
  const newHistory = state.viewHistory.slice(0, -1);
  state.viewHistory = newHistory;
  setState({ view: last.view, viewingUser: last.viewingUser });
}

// ===================== RENDER =====================
const root = document.getElementById("root");

function render() {
  if (state.loading) {
    root.innerHTML = svgBg() + `<div class="loading-shell"><p class="loading-text">Unrolling the field logâ¦</p></div>`;
    return;
  }
  if (state.storageError) {
    const lastLogs = (window.__fieldLogDebug || []).slice(-8);
    root.innerHTML = svgBg() + `
      <div class="loading-shell">
        <div class="error-box">
          <p class="error-title">Couldn't connect to storage</p>
          <p class="error-sub">Something went wrong loading the boards. Check your connection and try again.</p>
          <button class="btn-primary" style="margin-top:16px" id="retry-btn" type="button">Try again</button>
          ${lastLogs.length > 0 ? `
            <div class="debug-panel-inline" style="margin-top:16px;text-align:left">
              <div class="debug-panel-header"><span>Recent activity (for diagnosis)</span></div>
              <div class="debug-panel-body">${lastLogs.map((l) => `<div class="debug-line">${escapeHtml(l)}</div>`).join("")}</div>
            </div>` : '<p class="entry-meta" style="margin-top:12px">No storage activity was logged before this failed â the connection itself may not be reaching Firebase at all.</p>'}
        </div>
      </div>`;
    document.getElementById("retry-btn").onclick = () => { setState({ loading: true, storageError: false }); refreshAll(); };
    return;
  }
  if (!state.currentUser) {
    root.innerHTML = svgBg() + renderGate();
    wireGate();
    return;
  }

  let html = svgBg();
  html += renderDebugBar();

  if (state.view !== "home") {
    html += `
      <div class="nav-bar">
        <button class="nav-btn" id="back-btn" type="button"><span class="nav-icon">â</span> Back</button>
        <button class="nav-btn" id="home-btn" type="button"><span class="nav-icon">â</span> Home</button>
      </div>`;
  }

  if (state.view === "home") html += renderHomepage();
  if (state.view === "leaderboard") html += renderLeaderboard();
  if (state.view === "team") html += renderTeamGrid();
  if (state.view === "board") html += renderBoardView();

  if (state.modalIndex !== null) html += renderUploadModal();
  if (state.entryModal) html += renderEntryModal();
  if (state.pinModal) html += renderPinPromptModal();
  if (state.pinManageOpen) html += renderPinManageModal();

  if (state.showDebug) html += renderDebugPanelHtml();

  root.innerHTML = html;
  wireAll();
}

function svgBg() {
  const polaroids = [
    { x: 40, y: 60, rot: -8, scene: "hike" }, { x: 320, y: 40, rot: 6, scene: "cook" },
    { x: 620, y: 90, rot: -5, scene: "laugh" }, { x: 880, y: 50, rot: 9, scene: "read" },
    { x: 120, y: 340, rot: 7, scene: "stargaze" }, { x: 460, y: 380, rot: -9, scene: "bike" },
    { x: 760, y: 340, rot: 4, scene: "picnic" }, { x: 980, y: 380, rot: -6, scene: "highfive" },
    { x: 240, y: 620, rot: -4, scene: "cook" }, { x: 600, y: 640, rot: 8, scene: "hike" },
    { x: 900, y: 610, rot: -7, scene: "laugh" }, { x: 60, y: 900, rot: 5, scene: "bike" },
    { x: 400, y: 900, rot: -8, scene: "stargaze" }, { x: 740, y: 880, rot: 6, scene: "read" },
  ];
  const inkColor = "#6b5842", paperColor = "#f4ecda", shadowColor = "rgba(80,60,40,0.18)";
  const scenes = {
    hike: `<path d="M6 44 L20 20 L28 32 L38 14 L52 44"/><circle cx="20" cy="14" r="3.5" fill="${inkColor}" stroke="none"/><path d="M20 17.5 L20 26 M14 22 L26 22 M20 26 L14 34 M20 26 L26 34"/><path d="M14 34 L10 40"/>`,
    cook: `<circle cx="20" cy="14" r="3.5" fill="${inkColor}" stroke="none"/><path d="M20 17.5 L20 30 M12 24 L28 24 M20 30 L14 42 M20 30 L26 42"/><ellipse cx="34" cy="38" rx="12" ry="4"/><path d="M22 38 Q28 30 34 34 Q40 30 46 38"/>`,
    laugh: `<circle cx="16" cy="16" r="3.2" fill="${inkColor}" stroke="none"/><path d="M16 19 L16 30 M9 24 L23 22 M16 30 L10 42 M16 30 L21 40"/><circle cx="36" cy="18" r="3.2" fill="${inkColor}" stroke="none"/><path d="M36 21 L36 32 M29 26 L43 25 M36 32 L30 44 M36 32 L41 42"/><path d="M20 24 L30 25" stroke-dasharray="1 4"/>`,
    read: `<circle cx="24" cy="14" r="3.5" fill="${inkColor}" stroke="none"/><path d="M24 17.5 L24 32"/><path d="M12 40 Q24 28 36 40 L36 44 Q24 34 12 44 Z"/><path d="M13 26 L24 30 L35 26"/>`,
    stargaze: `<path d="M6 40 L46 40"/><circle cx="20" cy="30" r="3.2" fill="${inkColor}" stroke="none"/><path d="M20 33 L14 40 M20 33 L26 40 M12 36 L28 34"/><path d="M38 10 L40 15 L45 15 L41 18 L43 23 L38 20 L33 23 L35 18 L31 15 L36 15 Z" fill="${inkColor}" stroke="none"/><path d="M50 6 L51 9 M54 12 L57 12"/>`,
    bike: `<circle cx="12" cy="38" r="8"/><circle cx="42" cy="38" r="8"/><path d="M12 38 L24 20 L34 38 M24 20 L20 38 M24 20 L30 20 M30 20 L42 38"/><circle cx="26" cy="12" r="3.2" fill="${inkColor}" stroke="none"/>`,
    picnic: `<rect x="8" y="30" width="36" height="14"/><path d="M8 30 L44 44 M44 30 L8 44" stroke-width="1.4"/><circle cx="30" cy="14" r="3.2" fill="${inkColor}" stroke="none"/><path d="M30 17 L30 26 M24 21 L36 21"/><ellipse cx="18" cy="26" rx="4" ry="2.4"/>`,
    highfive: `<circle cx="12" cy="14" r="3.2" fill="${inkColor}" stroke="none"/><path d="M12 17 L12 28 M6 20 L20 14 M12 28 L7 40 M12 28 L16 40"/><circle cx="38" cy="14" r="3.2" fill="${inkColor}" stroke="none"/><path d="M38 17 L38 28 M44 20 L30 14 M38 28 L43 40 M38 28 L34 40"/>`,
  };
  let inner = `<defs><filter id="paperGrain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="noise"/><feColorMatrix in="noise" type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.36  0 0 0 0 0.27  0 0 0 0.03 0"/></filter></defs>`;
  inner += `<rect width="1080" height="1000" fill="#e9dfc6"/><rect width="1080" height="1000" filter="url(#paperGrain)" opacity="0.5"/>`;
  polaroids.forEach((p) => {
    inner += `<g transform="translate(${p.x} ${p.y}) rotate(${p.rot})">
      <rect x="-2" y="2" width="94" height="110" rx="3" fill="${shadowColor}"/>
      <rect x="0" y="0" width="94" height="110" rx="2" fill="${paperColor}" stroke="#d8cba9" stroke-width="1.5"/>
      <rect x="8" y="8" width="78" height="78" fill="#efe4c9" stroke="#d8cba9" stroke-width="1"/>
      <g transform="translate(24 24) scale(0.9)" stroke="${inkColor}" stroke-width="2.2" fill="none" stroke-linecap="round">${scenes[p.scene]}</g>
    </g>`;
  });
  return `<svg class="scrapbook-bg" viewBox="0 0 1080 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${inner}</svg>`;
}

function renderGate() {
  return `
    <div class="homepage">
      <header class="masthead">
        <p class="masthead-eyebrow">UTM Â· LLC Program Facilitators</p>
        <h1 class="masthead-title">the summer I turned into an LLC PF</h1>
        <p class="masthead-sub">First, tell us who you are.</p>
      </header>
      <div class="who-bar">
        <label for="identity-select" class="who-label">I am</label>
        <select id="identity-select" class="who-select">
          <option value="">â choose your name â</option>
          ${TEAM.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}
        </select>
      </div>
    </div>`;
}

function wireGate() {
  document.getElementById("identity-select").addEventListener("change", (e) => {
    if (e.target.value) setState({ currentUser: e.target.value });
  });
}

function renderDebugBar() {
  return `
    <div class="debug-bar">
      <button class="debug-toggle-inline" id="debug-toggle" type="button">${state.showDebug ? "Hide debug log" : "Show debug log"}</button>
    </div>`;
}

function renderDebugPanelHtml() {
  const lines = window.__fieldLogDebug || [];
  return `
    <div class="debug-panel-inline">
      <div class="debug-panel-header">
        <span>Storage debug log</span>
        <button id="debug-close" type="button">â</button>
      </div>
      <div class="debug-panel-body" id="debug-panel-body">
        ${lines.length === 0 ? "<p>No storage calls logged yet. Try uploading a photo.</p>" : lines.map((l) => `<div class="debug-line">${escapeHtml(l)}</div>`).join("")}
      </div>
    </div>`;
}

function renderDebugPanel() {
  const body = document.getElementById("debug-panel-body");
  if (!body) return;
  const lines = window.__fieldLogDebug || [];
  body.innerHTML = lines.length === 0 ? "<p>No storage calls logged yet.</p>" : lines.map((l) => `<div class="debug-line">${escapeHtml(l)}</div>`).join("");
  body.scrollTop = body.scrollHeight;
}

function renderHomepage() {
  return `
    <div class="homepage">
      <header class="masthead">
        <p class="masthead-eyebrow">UTM Â· LLC Program Facilitators</p>
        <h1 class="masthead-title">the summer I turned into an LLC PF</h1>
        <p class="masthead-sub">One entry every ${LOCK_HOURS / 24} days. First to complete a line wins.</p>
      </header>
      <div class="home-actions">
        <button class="home-btn home-btn-primary" id="go-my-board" type="button">ð My board</button>
        <button class="home-btn" id="go-team-boards" type="button">ð Team boards</button>
        <button class="home-btn" id="go-leaderboard" type="button">ð Leaderboard</button>
      </div>
      ${state.currentUser ? `<p class="home-current-user">Signed in as <strong>${escapeHtml(state.currentUser)}</strong> Â· <button class="link-btn" id="switch-identity" type="button">not you?</button></p>` : ""}
    </div>`;
}

function renderLeaderboard() {
  const rows = TEAM.map((name) => {
    const board = state.boards[name];
    const count = board ? board.cells.filter((c) => c.done).length : 0;
    const progress = board ? bingoProgress(board.cells) : { filled: 1, remaining: GRID_SIZE - 1, isBingo: false };
    const lastTs = board?.lastUploadTimestamp || null;
    return { name, count, progress, lastTs, pin: board?.pin };
  }).sort((a, b) => {
    if (a.progress.remaining !== b.progress.remaining) return a.progress.remaining - b.progress.remaining;
    return b.count - a.count;
  });

  return `
    <div class="leaderboard">
      <h2 class="team-heading">Leaderboard</h2>
      <div class="leaderboard-list">
        ${rows.map((row, i) => `
          <button class="lb-row ${row.name === state.currentUser ? "lb-row-active" : ""}" type="button" data-select-board="${escapeHtml(row.name)}">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-name">${escapeHtml(row.name)} ${row.pin ? '<span class="lock-icon-sm" title="PIN protected">ð</span>' : ""}</span>
            <span class="lb-stat">${row.progress.isBingo ? '<span class="lb-bingo">BINGO! ð</span>' : `<span class="lb-line">${row.progress.remaining} to a line</span>`}</span>
            <span class="lb-count">${row.count}/${PROMPTS.length}</span>
            <span class="lb-last">${formatRelativeTime(row.lastTs)}</span>
          </button>`).join("")}
      </div>
    </div>`;
}

function renderTeamGrid() {
  return `
    <section class="team-section">
      <h2 class="team-heading">Team boards</h2>
      <p class="hint-text" style="margin-top:0;margin-bottom:16px">Tap a name to view their log. You can react, but only they can edit it.</p>
      <div class="team-grid">
        ${TEAM.map((name) => {
          const board = state.boards[name];
          const count = board ? board.cells.filter((c) => c.done).length : 0;
          return `
            <button class="team-card ${name === state.currentUser ? "team-card-active" : ""}" type="button" data-select-board="${escapeHtml(name)}">
              <span class="team-card-name">${escapeHtml(name)} ${board?.pin ? '<span class="lock-icon-sm" title="PIN protected">ð</span>' : ""} ${name === state.currentUser ? '<span class="you-tag">you</span>' : ""}</span>
              <span class="team-card-count">${count}/${PROMPTS.length}</span>
              <div class="mini-track"><div class="mini-fill" style="width:${(count / PROMPTS.length) * 100}%"></div></div>
            </button>`;
        }).join("")}
      </div>
    </section>`;
}

function renderBoardView() {
  const db = displayedBoard();
  if (!state.viewingUser || !db) return "";
  const own = isViewingOwnBoard();
  const locked = own && isLocked();

  let html = `
    <section class="my-board-section">
      <div class="board-header">
        <h2 class="board-name">${own ? "My log" : `${escapeHtml(state.viewingUser)}'s log`} ${db.pin ? '<span class="lock-icon" title="PIN protected">ð</span>' : ""}</h2>
        <div class="progress-wrap">
          <div class="progress-track"><div class="progress-fill" style="width:${(db.cells.filter((c) => c.done).length / PROMPTS.length) * 100}%"></div></div>
          <span class="progress-label">${db.cells.filter((c) => c.done).length}/${PROMPTS.length} entries logged</span>
        </div>
      </div>`;

  if (own) {
    html += `<button type="button" class="link-btn manage-pin-link" id="manage-pin-link">${isPinProtected() ? "Change or remove PIN" : "Add a PIN to protect your board"}</button>`;
  }

  if (own && locked) {
    html += `<p class="lock-note">ð Your board is locked â next entry unlocks in ${formatRemaining(lockRemaining())}. If you deleted a photo, the square stays empty until the lock lifts.</p>`;
  }
  if (!own) {
    html += `<p class="hint-text" style="margin-top:0;margin-bottom:12px">You're viewing ${escapeHtml(state.viewingUser)}'s board â you can react, but only ${escapeHtml(state.viewingUser)} can edit it.</p>`;
  }

  html += `<div class="grid">`;
  PROMPTS.forEach((prompt, i) => {
    const cell = db.cells[i];
    const isFree = i === FREE_INDEX;
    const canOpen = cell.done && !isFree;
    const isOwnerActive = own && !locked;
    const isLockedEmpty = !cell.done && !isFree && locked;
    const clickable = isOwnerActive && !cell.done;
    html += `
      <button class="cell ${cell.done ? "cell-done" : ""} ${isFree ? "cell-free" : ""} ${clickable ? "cell-clickable" : ""} ${isLockedEmpty ? "cell-locked" : ""}"
        type="button" data-cell-index="${i}" data-can-open="${canOpen}" data-clickable="${clickable}" ${isFree ? "disabled" : ""}>
        ${cell.done && cell.photo ? `<img src="${cell.photo}" alt="${escapeHtml(prompt)}" class="cell-photo"/>` : ""}
        ${isFree ? '<div class="free-mark">â<br/>FREE</div>' : ""}
        ${isLockedEmpty ? '<div class="lock-mark">ð</div>' : ""}
        <span class="cell-prompt">${isFree ? "Free space" : escapeHtml(prompt)}</span>
        ${cell.done && !isFree ? renderStamp(state.rotations[i]) : ""}
      </button>`;
  });
  html += `</div><p class="hint-text">Tap any logged square to view it and react.</p></section>`;
  return html;
}

function renderStamp(rotate) {
  return `<div class="stamp" style="transform:rotate(${rotate}deg)">
    <svg viewBox="0 0 100 100" width="46" height="46">
      <circle cx="50" cy="50" r="44" fill="none" stroke="#0080A2" stroke-width="5"/>
      <circle cx="50" cy="50" r="34" fill="none" stroke="#0080A2" stroke-width="2"/>
      <text x="50" y="46" text-anchor="middle" font-size="13" fill="#0080A2" font-family="'Special Elite', monospace" font-weight="bold">LOGGED</text>
      <text x="50" y="62" text-anchor="middle" font-size="9" fill="#0080A2" font-family="'Special Elite', monospace">FIELD CONFIRMED</text>
    </svg>
  </div>`;
}

function renderUploadModal() {
  return `
    <div class="modal-backdrop" id="upload-backdrop">
      <div class="modal" id="upload-modal-inner">
        <p class="modal-eyebrow">New entry</p>
        <h3 class="modal-title">${escapeHtml(PROMPTS[state.modalIndex])}</h3>
        <div class="dropzone" id="dropzone">
          <p class="dropzone-text" id="dropzone-text">Tap to choose a photo</p>
        </div>
        <input type="file" accept="image/*" capture="environment" style="display:none" id="file-input"/>
        <p class="modal-error hidden" id="upload-modal-error"></p>
        ${state.uploadError ? `<p class="modal-error">${escapeHtml(state.uploadError)}</p>` : ""}
        <div class="modal-actions">
          <button class="btn-ghost" id="upload-cancel" type="button">Cancel</button>
          <button class="btn-primary" id="upload-submit" type="button" disabled>${state.busy ? "Loggingâ¦" : "Log entry"}</button>
        </div>
      </div>
    </div>`;
}

function renderEntryModal() {
  const { ownerName, index } = state.entryModal;
  const board = state.boards[ownerName];
  const cell = board?.cells[index];
  if (!cell) return "";
  const prompt = PROMPTS[index];
  const totalReactions = Object.values(cell.reactions).reduce((sum, arr) => sum + arr.length, 0);
  const isOwner = ownerName === state.currentUser;
  const comments = cell.comments || [];

  return `
    <div class="modal-backdrop" id="entry-backdrop">
      <div class="modal entry-modal" id="entry-modal-inner">
        <p class="modal-eyebrow">${escapeHtml(ownerName)}'s entry</p>
        <h3 class="modal-title">${escapeHtml(prompt)}</h3>
        ${cell.photo ? `<img src="${cell.photo}" alt="${escapeHtml(prompt)}" class="entry-photo"/>` : ""}
        <p class="entry-meta">Logged ${formatRelativeTime(cell.timestamp)}</p>
        <div class="reaction-bar">
          ${REACTIONS.map((emoji) => {
            const reactors = cell.reactions[emoji] || [];
            const mine = state.currentUser && reactors.includes(state.currentUser);
            return `<button type="button" class="reaction-pill ${mine ? "reaction-pill-active" : ""}" data-react="${emoji}">
              <span>${emoji}</span>${reactors.length > 0 ? `<span class="reaction-count">${reactors.length}</span>` : ""}
            </button>`;
          }).join("")}
        </div>
        ${totalReactions === 0 ? '<p class="entry-no-reactions">No reactions yet â be the first!</p>' : ""}

        <div class="comments-section">
          ${comments.length > 0 ? `<div class="comments-list">
            ${comments.map((c, i) => `
              <div class="comment-row" data-comment-index="${i}">
                <span class="comment-author">${escapeHtml(c.author)}</span>
                <span class="comment-text">${escapeHtml(c.text)}</span>
                ${c.author === state.currentUser ? `<span class="comment-actions">
                  <button type="button" class="comment-mini-btn" data-edit-comment="${i}">Edit</button>
                  <button type="button" class="comment-mini-btn comment-mini-btn-danger" data-delete-comment="${i}">Delete</button>
                </span>` : ""}
              </div>`).join("")}
          </div>` : ""}
          <div class="comment-input-row">
            <input type="text" class="comment-input" id="comment-input" placeholder="Add a commentâ¦" maxlength="100"/>
            <button type="button" class="comment-send" id="comment-send" disabled>Send</button>
          </div>
          <p class="comment-char-count"><span id="comment-char-count">0</span>/100</p>
        </div>

        ${state.uploadError ? `<p class="modal-error">${escapeHtml(state.uploadError)}</p>` : ""}
        <div class="modal-actions">
          <button class="btn-ghost" id="entry-close" type="button">Close</button>
          ${isOwner ? '<button class="btn-text-danger-solid" id="entry-delete" type="button">Delete photo</button>' : ""}
        </div>
      </div>
    </div>`;
}

function renderPinPromptModal() {
  const mode = state.pinModal.mode;
  const title = mode === "set" ? "Protect your board? (optional)" : "Enter your PIN";
  const sub = mode === "set"
    ? "Set a 4-digit PIN so only you can upload or delete on your board. You can skip this â your board will stay open like everyone else's."
    : "This board is PIN-protected. Enter the PIN to continue.";
  return `
    <div class="modal-backdrop" id="pinprompt-backdrop">
      <div class="modal" id="pinprompt-inner">
        <p class="modal-eyebrow">${mode === "set" ? "Optional" : "Protected board"}</p>
        <h3 class="modal-title">${title}</h3>
        <p class="modal-sub">${sub}</p>
        <input class="pin-input" type="tel" inputmode="numeric" maxlength="4" placeholder="â¢â¢â¢â¢" id="pinprompt-input"/>
        ${state.pinError ? `<p class="modal-error">${escapeHtml(state.pinError)}</p>` : ""}
        <div class="modal-actions">
          ${mode === "set" ? '<button class="btn-ghost" id="pinprompt-skip" type="button">Skip</button>' : '<button class="btn-ghost" id="pinprompt-cancel" type="button">Cancel</button>'}
          <button class="btn-primary" id="pinprompt-confirm" type="button" disabled>${mode === "set" ? "Set PIN" : "Confirm"}</button>
        </div>
      </div>
    </div>`;
}

function renderPinManageModal() {
  const hasPin = isPinProtected();
  return `
    <div class="modal-backdrop" id="pinmanage-backdrop">
      <div class="modal" id="pinmanage-inner">
        <p class="modal-eyebrow">Board protection</p>
        <h3 class="modal-title">${hasPin ? "Change or remove your PIN" : "Add a PIN"}</h3>
        <p class="modal-sub">${hasPin ? "Enter a new 4-digit PIN to replace the current one, or remove protection entirely." : "Set a 4-digit PIN so only you can upload or delete on your board."}</p>
        <input class="pin-input" type="tel" inputmode="numeric" maxlength="4" placeholder="â¢â¢â¢â¢" id="pinmanage-input"/>
        ${state.pinError ? `<p class="modal-error">${escapeHtml(state.pinError)}</p>` : ""}
        <div class="modal-actions">
          <button class="btn-ghost" id="pinmanage-cancel" type="button">Cancel</button>
          ${hasPin ? '<button class="btn-text-danger-solid" id="pinmanage-remove" type="button">Remove PIN</button>' : ""}
          <button class="btn-primary" id="pinmanage-confirm" type="button" disabled>${hasPin ? "Update PIN" : "Set PIN"}</button>
        </div>
      </div>
    </div>`;
}

// ===================== WIRING =====================
function wireAll() {
  const debugToggle = document.getElementById("debug-toggle");
  if (debugToggle) debugToggle.onclick = () => setState({ showDebug: !state.showDebug });
  const debugClose = document.getElementById("debug-close");
  if (debugClose) debugClose.onclick = () => setState({ showDebug: false });

  const backBtn = document.getElementById("back-btn");
  if (backBtn) backBtn.onclick = () => goBack();
  const homeBtn = document.getElementById("home-btn");
  if (homeBtn) homeBtn.onclick = () => goHomeReset();

  const goMyBoard = document.getElementById("go-my-board");
  if (goMyBoard) goMyBoard.onclick = () => goToMyBoard();
  const goTeam = document.getElementById("go-team-boards");
  if (goTeam) goTeam.onclick = () => goToTeamBoards();
  const goLb = document.getElementById("go-leaderboard");
  if (goLb) goLb.onclick = () => goToLeaderboard();
  const switchId = document.getElementById("switch-identity");
  if (switchId) switchId.onclick = () => setState({ currentUser: null, viewingUser: null });

  document.querySelectorAll("[data-select-board]").forEach((el) => {
    el.onclick = () => selectBoardToView(el.dataset.selectBoard);
  });

  const managePinLink = document.getElementById("manage-pin-link");
  if (managePinLink) managePinLink.onclick = () => requirePinThen(() => setState({ pinManageOpen: true }));

  document.querySelectorAll("[data-cell-index]").forEach((el) => {
    el.onclick = () => {
      const i = parseInt(el.dataset.cellIndex, 10);
      const canOpen = el.dataset.canOpen === "true";
      const clickable = el.dataset.clickable === "true";
      if (canOpen) setState({ entryModal: { ownerName: state.viewingUser, index: i } });
      else if (clickable) requirePinThen(() => setState({ uploadError: "", modalIndex: i }));
    };
  });

  wireUploadModal();
  wireEntryModal();
  wirePinPromptModal();
  wirePinManageModal();
}

function wireUploadModal() {
  const backdrop = document.getElementById("upload-backdrop");
  if (!backdrop) return;
  const modalInner = document.getElementById("upload-modal-inner");
  backdrop.onclick = () => setState({ modalIndex: null, uploadError: "" });
  modalInner.onclick = (e) => e.stopPropagation();

  let preview = null;
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  const submitBtn = document.getElementById("upload-submit");
  const errEl = document.getElementById("upload-modal-error");

  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = async (e) => {
    errEl.classList.add("hidden");
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      errEl.textContent = "Please choose an image file.";
      errEl.classList.remove("hidden");
      return;
    }
    try {
      preview = await fileToCompressedDataUrl(file);
      dropzone.innerHTML = `<img src="${preview}" class="dropzone-preview" alt="Preview"/>`;
      submitBtn.disabled = false;
    } catch {
      errEl.textContent = "Could not process that image â try another.";
      errEl.classList.remove("hidden");
    }
  };

  document.getElementById("upload-cancel").onclick = () => setState({ modalIndex: null, uploadError: "" });
  submitBtn.onclick = () => { if (preview) handleSubmit(preview); };
}

function wireEntryModal() {
  const backdrop = document.getElementById("entry-backdrop");
  if (!backdrop) return;
  const modalInner = document.getElementById("entry-modal-inner");
  backdrop.onclick = () => setState({ entryModal: null, uploadError: "" });
  modalInner.onclick = (e) => e.stopPropagation();

  document.getElementById("entry-close").onclick = () => setState({ entryModal: null, uploadError: "" });
  const deleteBtn = document.getElementById("entry-delete");
  if (deleteBtn) deleteBtn.onclick = () => handleDeleteFromEntry();

  document.querySelectorAll("[data-react]").forEach((el) => {
    el.onclick = () => handleReact(state.entryModal.ownerName, state.entryModal.index, el.dataset.react);
  });

  const commentInput = document.getElementById("comment-input");
  const commentSend = document.getElementById("comment-send");
  const charCount = document.getElementById("comment-char-count");
  commentInput.oninput = () => {
    charCount.textContent = commentInput.value.length;
    commentSend.disabled = !commentInput.value.trim();
  };
  commentInput.onkeydown = (e) => { if (e.key === "Enter") submitComment(); };
  commentSend.onclick = submitComment;
  function submitComment() {
    const text = commentInput.value.trim().slice(0, 100);
    if (!text) return;
    handleAddComment(state.entryModal.ownerName, state.entryModal.index, text);
  }

  document.querySelectorAll("[data-edit-comment]").forEach((el) => {
    el.onclick = () => {
      const ci = parseInt(el.dataset.editComment, 10);
      const row = el.closest(".comment-row");
      const board = state.boards[state.entryModal.ownerName];
      const cell = board.cells[state.entryModal.index];
      const original = cell.comments[ci].text;
      row.innerHTML = `
        <input type="text" class="comment-input" maxlength="100" value="${escapeHtml(original)}" id="edit-input-${ci}"/>
        <button type="button" class="comment-mini-btn" id="edit-save-${ci}">Save</button>
        <button type="button" class="comment-mini-btn" id="edit-cancel-${ci}">Cancel</button>`;
      row.classList.add("comment-row-editing");
      document.getElementById(`edit-save-${ci}`).onclick = () => {
        const newText = document.getElementById(`edit-input-${ci}`).value.trim().slice(0, 100);
        handleEditComment(state.entryModal.ownerName, state.entryModal.index, ci, newText);
      };
      document.getElementById(`edit-cancel-${ci}`).onclick = () => render();
    };
  });
  document.querySelectorAll("[data-delete-comment]").forEach((el) => {
    el.onclick = () => {
      const ci = parseInt(el.dataset.deleteComment, 10);
      handleDeleteComment(state.entryModal.ownerName, state.entryModal.index, ci);
    };
  });
}

function wirePinPromptModal() {
  const backdrop = document.getElementById("pinprompt-backdrop");
  if (!backdrop) return;
  const modalInner = document.getElementById("pinprompt-inner");
  const closeFn = () => setState({ pinModal: null, pinError: "" });
  backdrop.onclick = closeFn;
  modalInner.onclick = (e) => e.stopPropagation();

  const input = document.getElementById("pinprompt-input");
  const confirmBtn = document.getElementById("pinprompt-confirm");
  input.oninput = () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    confirmBtn.disabled = input.value.length !== 4;
  };
  const skip = document.getElementById("pinprompt-skip");
  if (skip) skip.onclick = () => handlePinConfirm(null);
  const cancel = document.getElementById("pinprompt-cancel");
  if (cancel) cancel.onclick = closeFn;
  confirmBtn.onclick = () => handlePinConfirm(input.value);
}

function wirePinManageModal() {
  const backdrop = document.getElementById("pinmanage-backdrop");
  if (!backdrop) return;
  const modalInner = document.getElementById("pinmanage-inner");
  const closeFn = () => setState({ pinManageOpen: false, pinError: "" });
  backdrop.onclick = closeFn;
  modalInner.onclick = (e) => e.stopPropagation();

  const input = document.getElementById("pinmanage-input");
  const confirmBtn = document.getElementById("pinmanage-confirm");
  input.oninput = () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 4);
    confirmBtn.disabled = input.value.length !== 4;
  };
  document.getElementById("pinmanage-cancel").onclick = closeFn;
  const removeBtn = document.getElementById("pinmanage-remove");
  if (removeBtn) removeBtn.onclick = () => handleRemovePin();
  confirmBtn.onclick = () => handleUpdatePin(input.value);
}

// ===================== BOOT =====================
debugLog("App script started, calling refreshAll()â¦");
refreshAll();
setInterval(() => { refreshAll(true); }, 60 * 1000);

// Absolute failsafe: no matter what goes wrong inside refreshAll (a bug, an
// unexpected hang, a promise that never resolves or rejects), never let the
// loading screen spin forever with zero feedback. If we're still "loading"
// after 15 seconds, force the error screen with real diagnostic info.
setTimeout(() => {
  if (state.loading) {
    console.error("Boot failsafe triggered â refreshAll did not complete within 15s");
    setState({
      loading: false,
      storageError: true,
    });
  }
}, 15000);
