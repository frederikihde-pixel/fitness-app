const DATA_KEY = "fitness-tracker-data";
const LEGACY_KEY = "fitness-tracker-entries";
const DATA_VERSION = 3;

const UNITS = { weight: "kg", distance: "km" };

const EXERCISE_TYPES = {
  strength: { label: "Kraft" },
  bodyweight: { label: "Eigengewicht" },
  endurance: { label: "Ausdauer" },
  timed: { label: "Zeitbasiert" },
};

// Each entry migrates data from version N to N + 1.
const MIGRATIONS = {
  1: migrateV1toV2,
  2: migrateV2toV3,
};

const appBanner = document.getElementById("app-banner");

function showBanner(message) {
  appBanner.textContent = message;
  appBanner.hidden = false;
}

const storage = {
  available: (() => {
    try {
      const probe = "__fitness_probe__";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })(),
  get(key) {
    if (!this.available) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    if (!this.available) return false;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
};

function createId(prefix) {
  const random =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

function emptyState() {
  return {
    version: DATA_VERSION,
    exercises: {},
    workouts: [],
    routines: [],
    activeWorkout: null,
    settings: { restSeconds: 90, statPeriod: "3m", weeklyGoal: 3 },
  };
}

function formatWorkoutDefaultName(timestamp) {
  return new Date(timestamp).toLocaleDateString("de-DE", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function inferLegacyTypes(legacyEntries) {
  const counts = {};
  for (const entry of legacyEntries) {
    const name = normalizeExerciseName(entry.exercise);
    const c = counts[name] || (counts[name] = { reps: 0, distance: 0, duration: 0 });
    if (entry.reps) c.reps += 1;
    if (entry.distance) c.distance += 1;
    if (entry.duration) c.duration += 1;
  }
  const types = {};
  for (const [name, c] of Object.entries(counts)) {
    if (c.distance > 0 && c.distance >= c.reps) types[name] = "endurance";
    else if (c.reps === 0 && c.duration > 0) types[name] = "timed";
    else types[name] = "bodyweight";
  }
  return types;
}

// v1 = flat list of { exercise, reps, distance, duration (min), date }.
// Every old entry becomes one finished workout with one exercise and one set.
function migrateV1toV2(data) {
  const legacy = (Array.isArray(data.entries) ? data.entries : []).filter(
    (entry) => entry && typeof entry.exercise === "string" && entry.exercise.trim() && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)
  );
  const next = {
    version: 2,
    exercises: {},
    workouts: [],
    templates: [],
    activeWorkout: null,
    settings: { restSeconds: 90, statPeriod: "3m" },
  };
  const types = inferLegacyTypes(legacy);
  for (const [name, type] of Object.entries(types)) {
    next.exercises[name] = { type };
  }

  legacy.forEach((entry, index) => {
    const name = normalizeExerciseName(entry.exercise);
    const startedAt = new Date(entry.date + "T12:00:00").getTime();
    const durationSec = Number(entry.duration) > 0 ? Math.round(Number(entry.duration) * 60) : null;
    next.workouts.push({
      id: `w-legacy-${entry.id ?? index}-${index}`,
      name: formatWorkoutDefaultName(startedAt),
      startedAt,
      endedAt: startedAt + (durationSec ? durationSec * 1000 : 0),
      pausedMs: 0,
      migrated: true,
      exercises: [
        {
          id: `e-legacy-${index}`,
          name,
          sets: [
            {
              id: `s-legacy-${index}`,
              weight: null,
              reps: Number(entry.reps) > 0 ? Number(entry.reps) : null,
              distance: Number(entry.distance) > 0 ? Number(entry.distance) : null,
              durationSec,
              done: true,
            },
          ],
        },
      ],
    });
  });

  next.workouts.sort((a, b) => a.startedAt - b.startedAt);
  return next;
}

function lastSetsFromWorkouts(workouts, name) {
  const sorted = [...workouts].sort((a, b) => b.startedAt - a.startedAt);
  for (const workout of sorted) {
    const exercise = (workout.exercises || []).find((item) => item.name === name);
    const sets = exercise ? exercise.sets.filter((set) => !set.planned) : [];
    if (sets.length > 0) return sets;
  }
  return [];
}

// v3: templates become "Meine Workouts" (routines) with planned set values;
// workouts get a notes field and a link to the routine they were started from.
function migrateV2toV3(data) {
  const workouts = (data.workouts || []).map((workout) => ({
    ...workout,
    notes: workout.notes || "",
    routineId: workout.routineId || null,
  }));
  const routines = (data.templates || []).map((template, index) => {
    const id = template.id || `r-migrated-${index}`;
    return {
      id,
      name: template.name,
      notes: "",
      createdAt: template.createdAt || Date.now(),
      exercises: (template.exercises || []).map((item, exerciseIndex) => {
        const previous = lastSetsFromWorkouts(workouts, item.name);
        const count = Math.max(1, item.setCount || previous.length || 1);
        return {
          id: `${id}-e${exerciseIndex}`,
          name: item.name,
          sets: Array.from({ length: count }, (_, setIndex) => {
            const source = previous[setIndex] || previous[previous.length - 1] || {};
            return {
              id: `${id}-e${exerciseIndex}-s${setIndex}`,
              weight: source.weight ?? null,
              reps: source.reps ?? null,
              distance: source.distance ?? null,
              durationSec: source.durationSec ?? null,
            };
          }),
        };
      }),
    };
  });
  for (const routine of routines) {
    for (const workout of workouts) {
      if (!workout.routineId && workout.name === routine.name) workout.routineId = routine.id;
    }
  }
  const activeWorkout = data.activeWorkout
    ? { ...data.activeWorkout, notes: data.activeWorkout.notes || "", routineId: data.activeWorkout.routineId || null }
    : null;
  const { templates, ...rest } = data;
  return {
    ...rest,
    version: 3,
    workouts,
    routines,
    activeWorkout,
    settings: { ...data.settings, weeklyGoal: data.settings?.weeklyGoal || 3 },
  };
}

function withDefaults(data) {
  const { app, exportedAt, ...rest } = data;
  const defaults = emptyState();
  return { ...defaults, ...rest, settings: { ...defaults.settings, ...rest.settings } };
}

function backupCorruptData(raw) {
  storage.set(`${DATA_KEY}-defekt-${Date.now()}`, raw);
}

function loadState() {
  let data = null;
  const raw = storage.get(DATA_KEY);

  if (raw) {
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== "object" || typeof data.version !== "number") throw new Error("invalid");
    } catch {
      backupCorruptData(raw);
      showBanner("Die gespeicherten Daten waren beschädigt. Eine Kopie wurde gesichert, die App startet mit leeren Daten.");
      data = null;
    }
  }

  if (!data) {
    const legacyRaw = storage.get(LEGACY_KEY);
    let legacyEntries = [];
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw);
        if (Array.isArray(parsed)) legacyEntries = parsed;
      } catch {
        showBanner("Alte Einträge konnten nicht gelesen werden. Sie bleiben unverändert im Speicher erhalten.");
      }
    }
    data = legacyEntries.length > 0 ? { version: 1, entries: legacyEntries } : emptyState();
  }

  if (data.version > DATA_VERSION) {
    showBanner("Diese Daten stammen aus einer neueren Version der App. Einige Inhalte werden eventuell nicht angezeigt.");
  }

  const startVersion = data.version;
  if (startVersion < DATA_VERSION) {
    const original = startVersion === 1 && !raw ? storage.get(LEGACY_KEY) : raw;
    if (original) {
      pendingBackup = { key: `${DATA_KEY}-sicherung-v${startVersion}-${Date.now()}`, value: original };
      writePendingBackup();
    }
  }
  while (data.version < DATA_VERSION) {
    data = MIGRATIONS[data.version](data);
  }

  const loaded = withDefaults(data);
  if (startVersion !== loaded.version) {
    state = loaded;
    saveState();
  }
  return loaded;
}

// A migration overwrites the stored data only after a safety copy of the old version has been written.
let pendingBackup = null;

function writePendingBackup() {
  if (!pendingBackup) return true;
  if (storage.set(pendingBackup.key, pendingBackup.value)) {
    pendingBackup = null;
    return true;
  }
  showBanner(
    "Für das Update konnte keine Sicherheitskopie angelegt werden, weil der Speicher voll ist. Deine bisherigen Daten bleiben unverändert gespeichert. Exportiere unter „Mehr“ ein Backup und schaffe Platz."
  );
  return false;
}

function saveState() {
  if (!storage.available) return false;
  if (!writePendingBackup()) return false;
  const ok = storage.set(DATA_KEY, JSON.stringify(state));
  if (!ok) {
    showBanner("Speichern fehlgeschlagen: Der Browser-Speicher ist voll oder gesperrt. Neue Eingaben gehen beim Schließen verloren.");
  }
  return ok;
}

let state = null;
if (!storage.available) {
  showBanner("Dein Browser erlaubt keinen lokalen Speicher (z. B. privater Modus). Die App funktioniert, aber Daten gehen beim Schließen verloren.");
}
state = loadState();

function getExerciseType(name) {
  return state.exercises[name]?.type || "bodyweight";
}

function normalizeExerciseName(name) {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getIsoWeekNumber(timestamp) {
  const target = new Date(timestamp);
  target.setHours(0, 0, 0, 0);
  target.setDate(target.getDate() - ((target.getDay() + 6) % 7) + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() - ((firstThursday.getDay() + 6) % 7) + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatShortDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

// ---------- Formatting ----------

function formatClock(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = String(totalSec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function formatDurationLong(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  return `${Math.floor(totalMin / 60)} h ${String(totalMin % 60).padStart(2, "0")} min`;
}

// ---------- Toast and confirm dialog ----------

const toastEl = document.getElementById("toast");
let toastTimer = null;

function hideToast() {
  toastEl.classList.remove("visible", "has-action");
}

function showToast(message, action = null) {
  clearTimeout(toastTimer);
  toastEl.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  toastEl.appendChild(text);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      hideToast();
      action.onClick();
    });
    toastEl.appendChild(button);
  }
  toastEl.classList.toggle("has-action", Boolean(action));
  toastEl.classList.add("visible");
  toastTimer = setTimeout(hideToast, action ? 5000 : 2600);
}

// Deletions are applied right away; "Rückgängig" puts the item back for 5 seconds.
function showUndoToast(message, restore) {
  showToast(message, { label: "Rückgängig", onClick: restore });
}

const confirmDialogEl = document.getElementById("confirm-dialog");
const confirmMessageEl = document.getElementById("confirm-message");
const confirmOkBtn = document.getElementById("confirm-ok");

function confirmDialog(message, { confirmLabel = "OK", danger = false } = {}) {
  confirmMessageEl.textContent = message;
  confirmOkBtn.textContent = confirmLabel;
  confirmOkBtn.classList.toggle("btn-danger", danger);
  confirmOkBtn.classList.toggle("btn-primary", !danger);
  confirmDialogEl.returnValue = "";
  return new Promise((resolve) => {
    confirmDialogEl.addEventListener("close", () => resolve(confirmDialogEl.returnValue === "ok"), { once: true });
    confirmDialogEl.showModal();
  });
}

// ---------- Active workout ----------

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
};

const startScreen = document.getElementById("start-screen");
const workoutScreen = document.getElementById("workout-screen");
const activeCard = document.getElementById("active-workout-card");
const activeCardKicker = activeCard.querySelector(".card-kicker");
const activeCardName = document.getElementById("active-card-name");
const activeCardTimer = document.getElementById("active-card-timer");
const workoutTitle = document.getElementById("workout-title");
const workoutTimer = document.getElementById("workout-timer");
const workoutStatus = document.getElementById("workout-status");
const pauseBtn = document.getElementById("pause-btn");
const wakeLockHint = document.getElementById("wakelock-hint");

let currentTab = "training";
let trainingView = "start";
let editingRoutineId = null;

// Elapsed time is derived from timestamps, so it stays correct across reloads, locked screens and background tabs.
function getElapsedMs(workout, now = Date.now()) {
  const end = workout.endedAt ?? workout.pausedAt ?? now;
  return Math.max(0, end - workout.startedAt - (workout.pausedMs || 0));
}

function copySetValues(set) {
  return { weight: set.weight ?? null, reps: set.reps ?? null, distance: set.distance ?? null, durationSec: set.durationSec ?? null };
}

function startWorkout(template = null) {
  if (state.activeWorkout) {
    showToast("Beende zuerst das laufende Workout.");
    return;
  }
  const now = Date.now();
  const workout = {
    id: createId("w"),
    name: template?.name || formatWorkoutDefaultName(now),
    routineId: template?.id || null,
    notes: "",
    startedAt: now,
    pausedAt: null,
    pausedMs: 0,
    exercises: [],
    restEndsAt: null,
    restTotalSec: null,
  };
  for (const item of template?.exercises || []) {
    workout.exercises.push({
      id: createId("e"),
      name: item.name,
      sets: item.sets.map((set) => ({ id: createId("s"), ...copySetValues(set), done: false, planned: true })),
    });
  }
  state.activeWorkout = workout;
  saveState();
  trainingView = "workout";
  renderAll();
  syncWakeLock();
  window.scrollTo(0, 0);
}

function togglePause() {
  const workout = state.activeWorkout;
  if (!workout) return;
  const now = Date.now();
  if (workout.pausedAt) {
    workout.pausedMs += now - workout.pausedAt;
    workout.pausedAt = null;
  } else {
    workout.pausedAt = now;
  }
  saveState();
  renderTraining();
  syncWakeLock();
}

function finalizeActiveWorkout() {
  const workout = state.activeWorkout;
  const now = Date.now();
  if (workout.pausedAt) {
    workout.pausedMs += now - workout.pausedAt;
    workout.pausedAt = null;
  }
  const exercises = workout.exercises
    .map((exercise) => ({
      id: exercise.id,
      name: exercise.name,
      sets: exercise.sets.filter((set) => !set.planned).map(({ planned, ...set }) => set),
    }))
    .filter((exercise) => exercise.sets.length > 0);
  const finished = {
    id: workout.id,
    name: workout.name,
    routineId: workout.routineId || null,
    notes: workout.notes || "",
    startedAt: workout.startedAt,
    endedAt: now,
    pausedMs: workout.pausedMs,
    exercises,
  };
  state.workouts.push(finished);
  state.activeWorkout = null;
  saveState();
  return finished;
}

async function finishWorkout() {
  const ok = await confirmDialog("Workout jetzt beenden und speichern?", { confirmLabel: "Beenden" });
  if (!ok || !state.activeWorkout) return;
  const finished = finalizeActiveWorkout();
  trainingView = "start";
  renderAll();
  syncWakeLock();
  openSummary(finished);
}

async function discardWorkout() {
  const ok = await confirmDialog("Workout verwerfen? Alle Eingaben dieses Workouts gehen verloren.", {
    confirmLabel: "Verwerfen",
    danger: true,
  });
  if (!ok || !state.activeWorkout) return;
  state.activeWorkout = null;
  saveState();
  trainingView = "start";
  renderAll();
  syncWakeLock();
  showToast("Workout verworfen");
}

function updateTimers() {
  const workout = state.activeWorkout;
  if (!workout) return;
  const text = formatClock(getElapsedMs(workout));
  workoutTimer.textContent = text;
  activeCardTimer.textContent = text;
}

function renderTraining() {
  const workout = state.activeWorkout;
  if (trainingView === "workout" && !workout) trainingView = "start";
  if (trainingView === "routine" && !state.routines.some((routine) => routine.id === editingRoutineId)) trainingView = "start";
  startScreen.hidden = trainingView !== "start";
  workoutScreen.hidden = trainingView !== "workout";
  routineScreen.hidden = trainingView !== "routine";
  document.body.classList.toggle("in-workout", trainingView !== "start" && currentTab === "training");
  activeCard.hidden = !workout;
  renderRoutines();
  if (trainingView === "routine") renderRoutineEditor();

  if (workout) {
    const paused = Boolean(workout.pausedAt);
    activeCardKicker.textContent = paused ? "Workout pausiert" : "Workout läuft";
    activeCardName.textContent = workout.name;
    workoutTitle.textContent = workout.name;
    pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
    pauseBtn.setAttribute("aria-label", paused ? "Workout fortsetzen" : "Workout pausieren");
    workoutStatus.textContent = paused ? "Pausiert – die Zeit läuft nicht weiter" : "";
    workoutScreen.classList.toggle("is-paused", paused);
    updateTimers();
  }
  renderWorkoutExercises();
  updateRestTimer();
}

// ---------- Number and set formatting ----------

const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"/></svg>';

function formatNumber(value, maxDecimals = 2) {
  return Number(value || 0).toLocaleString("de-DE", { maximumFractionDigits: maxDecimals });
}

function parseDecimal(text) {
  const trimmed = String(text ?? "").trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

// Accepts "m:ss", "h:mm:ss" or a plain number interpreted in plainUnit ("min" or "sec"). Returns seconds.
function parseDurationInput(text, plainUnit) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map((part) => Number(part.replace(",", ".")));
    if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
    return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
  }
  const value = parseDecimal(trimmed);
  if (!Number.isFinite(value)) return NaN;
  return Math.round(plainUnit === "min" ? value * 60 : value);
}

function getPaceSecPerKm(set) {
  return set.distance > 0 && set.durationSec > 0 ? set.durationSec / set.distance : null;
}

function formatPace(secPerKm) {
  return `${formatClock(Math.round(secPerKm) * 1000)} min/${UNITS.distance}`;
}

function formatGenericSet(set) {
  const parts = [];
  if (set.weight) parts.push(`${formatNumber(set.weight)} ${UNITS.weight}`);
  if (set.reps) parts.push(`${set.reps} Wdh.`);
  if (set.distance) parts.push(`${formatNumber(set.distance)} ${UNITS.distance}`);
  if (set.durationSec) parts.push(formatClock(set.durationSec * 1000));
  return parts.join(" · ") || "ohne Werte";
}

function formatSet(set, type) {
  if (type === "strength" && set.reps) return `${formatNumber(set.weight)} ${UNITS.weight} × ${set.reps}`;
  if (type === "bodyweight" && set.reps) return `${set.reps} Wdh.`;
  if (type === "timed" && set.durationSec) return formatClock(set.durationSec * 1000);
  if (type === "endurance" && (set.distance || set.durationSec)) {
    const parts = [];
    if (set.distance) parts.push(`${formatNumber(set.distance)} ${UNITS.distance}`);
    if (set.durationSec) parts.push(`in ${formatClock(set.durationSec * 1000)}`);
    const pace = getPaceSecPerKm(set);
    if (pace) parts.push(`(${formatPace(pace)})`);
    return parts.join(" ");
  }
  return formatGenericSet(set);
}

function summarizeSets(sets, type) {
  const allSame = (key) => sets.every((set) => set[key] === sets[0][key]);
  if (type === "strength" && sets.every((set) => set.reps)) {
    if (allSame("weight") && allSame("reps")) {
      return `${sets.length} × ${sets[0].reps} mit ${formatNumber(sets[0].weight)} ${UNITS.weight}`;
    }
    return sets.map((set) => formatSet(set, type)).join(", ");
  }
  if (type === "bodyweight" && sets.every((set) => set.reps)) {
    return allSame("reps") ? `${sets.length} × ${sets[0].reps} Wdh.` : `${sets.map((set) => set.reps).join(", ")} Wdh.`;
  }
  if (type === "timed" && sets.every((set) => set.durationSec)) {
    return allSame("durationSec")
      ? `${sets.length} × ${formatClock(sets[0].durationSec * 1000)}`
      : sets.map((set) => formatClock(set.durationSec * 1000)).join(", ");
  }
  return sets.map((set) => formatSet(set, type)).join(", ");
}

// ---------- Exercises in a workout ----------

// ctx is { kind: "active" } for the running workout or { kind: "finished", workoutId } for a saved one.
function getWorkoutByCtx(ctx) {
  if (ctx.kind === "active") return state.activeWorkout;
  if (ctx.kind === "routine") return state.routines.find((routine) => routine.id === ctx.routineId) || null;
  return state.workouts.find((workout) => workout.id === ctx.workoutId) || null;
}

function getRealSets(exercise) {
  return exercise.sets.filter((set) => !set.planned);
}

function getKnownExercisesByRecency() {
  const lastUsed = new Map();
  const consider = (workout) => {
    for (const exercise of workout.exercises) {
      if ((lastUsed.get(exercise.name) ?? -Infinity) < workout.startedAt) lastUsed.set(exercise.name, workout.startedAt);
    }
  };
  state.workouts.forEach(consider);
  if (state.activeWorkout) consider(state.activeWorkout);
  const names = new Set([...Object.keys(state.exercises), ...lastUsed.keys()]);
  return [...names].sort((a, b) => (lastUsed.get(b) ?? 0) - (lastUsed.get(a) ?? 0) || a.localeCompare(b, "de"));
}

// Sets of this exercise from the most recent saved workout that started before `before`.
function getPreviousSets(name, before, excludeWorkoutId) {
  const candidates = state.workouts
    .filter((workout) => workout.id !== excludeWorkoutId && workout.startedAt < before)
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const workout of candidates) {
    const exercise = workout.exercises.find((item) => item.name === name);
    const sets = exercise ? getRealSets(exercise) : [];
    if (sets.length > 0) return { workout, sets };
  }
  return null;
}

const DEFAULT_SET = {
  strength: { weight: 20, reps: 8 },
  bodyweight: { reps: 10 },
  endurance: { distance: null, durationSec: null },
  timed: { durationSec: 30 },
};

function pickSetValues(set) {
  return { weight: set.weight ?? null, reps: set.reps ?? null, distance: set.distance ?? null, durationSec: set.durationSec ?? null };
}

function getPrefillValues(workout, exercise, index = null) {
  const realSets = getRealSets(exercise);
  if (index === null && realSets.length > 0) return pickSetValues(realSets[realSets.length - 1]);
  const previous = getPreviousSets(exercise.name, workout.startedAt ?? Infinity, workout.id);
  if (previous) {
    const source = index !== null && previous.sets[index] ? previous.sets[index] : previous.sets[previous.sets.length - 1];
    return pickSetValues(source);
  }
  return pickSetValues(DEFAULT_SET[getExerciseType(exercise.name)] || {});
}

function persistAndRender() {
  saveState();
  renderAll();
}

const TIMER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.5" r="7"/><path d="M12 10v3.5l2.2 1.6M10 3h4"/></svg>';
const TIMER_OFF_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13.5" r="7"/><path d="M10 3h4M5 5l14 15"/></svg>';

function restEnabledFor(name) {
  const type = getExerciseType(name);
  return (type === "strength" || type === "bodyweight") && state.exercises[name]?.rest !== false;
}

// Values that can be changed directly in a set row.
const INLINE_FIELDS = {
  strength: [
    { key: "weight", head: UNITS.weight, label: "Gewicht in kg", kind: "decimal", step: 2.5, stepLabel: "2,5 kg", min: 0, required: true },
    { key: "reps", head: "Wdh.", label: "Wiederholungen", kind: "int", step: 1, stepLabel: "1", min: 1, required: true },
  ],
  bodyweight: [{ key: "reps", head: "Wdh.", label: "Wiederholungen", kind: "int", step: 1, stepLabel: "1", min: 1, required: true }],
  endurance: [
    { key: "distance", head: UNITS.distance, label: "Distanz in km", kind: "decimal", min: 0 },
    { key: "durationSec", head: "Zeit", label: "Zeit (Minuten oder mm:ss)", kind: "minutes", min: 0 },
  ],
  timed: [{ key: "durationSec", head: "Dauer", label: "Dauer (Sekunden oder m:ss)", kind: "seconds", step: 5, stepLabel: "5 Sekunden", min: 1, required: true }],
};

function formatFieldValue(set, field) {
  const value = set[field.key];
  if (value === null || value === undefined) return "";
  if (field.kind === "minutes" || field.kind === "seconds") return formatClock(value * 1000);
  if (field.kind === "int") return String(value);
  return formatInputNumber(value);
}

// Returns the parsed value, null for an allowed empty field, or undefined when the input is invalid.
function parseFieldValue(field, text) {
  let value;
  if (field.kind === "minutes") value = parseDurationInput(text, "min");
  else if (field.kind === "seconds") value = parseDurationInput(text, "sec");
  else value = parseDecimal(text);
  if (value === null) return field.required ? undefined : null;
  if (Number.isNaN(value) || value < field.min) return undefined;
  if (field.kind === "int" && !Number.isInteger(value)) return undefined;
  return field.kind === "decimal" ? roundTo(value, 2) : value;
}

function findSet(ctx, exerciseId, setId) {
  const exercise = getWorkoutByCtx(ctx)?.exercises.find((item) => item.id === exerciseId);
  return { exercise, set: exercise?.sets.find((item) => item.id === setId) };
}

// Inline edits only save and update the row, so the input keeps focus and nothing flickers.
function commitSetField(ctx, exerciseId, setId, field, value, row) {
  const { set } = findSet(ctx, exerciseId, setId);
  if (!set) return;
  set[field.key] = value;
  if (set.planned) {
    set.planned = false;
    row.classList.remove("is-planned");
  }
  saveState();
}

function buildFieldControl(ctx, exercise, set, field, index, row) {
  const wrap = document.createElement("div");
  wrap.className = field.step ? "mini-stepper" : "mini-field";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "set-input";
  input.inputMode = field.kind === "int" || field.kind === "seconds" ? "numeric" : "decimal";
  input.autocomplete = "off";
  input.enterKeyHint = "done";
  input.value = formatFieldValue(set, field);
  if (field.kind === "minutes") input.placeholder = "mm:ss";
  input.setAttribute("aria-label", `${field.label}, Satz ${index + 1}`);
  input.addEventListener("focus", () => input.select());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
  input.addEventListener("change", () => {
    const { set: current } = findSet(ctx, exercise.id, set.id);
    if (!current) return;
    const value = parseFieldValue(field, input.value);
    if (value !== undefined) commitSetField(ctx, exercise.id, set.id, field, value, row);
    input.value = formatFieldValue(current, field);
  });

  if (!field.step) {
    wrap.appendChild(input);
    return wrap;
  }
  const makeStep = (direction) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-step";
    button.textContent = direction < 0 ? "−" : "+";
    button.setAttribute("aria-label", `${field.label} Satz ${index + 1} um ${field.stepLabel} ${direction < 0 ? "verringern" : "erhöhen"}`);
    button.addEventListener("click", () => {
      const { set: current } = findSet(ctx, exercise.id, set.id);
      if (!current) return;
      const base = current[field.key] ?? field.min;
      const next = Math.max(field.min, roundTo(base + direction * field.step, 2));
      commitSetField(ctx, exercise.id, set.id, field, next, row);
      input.value = formatFieldValue(current, field);
    });
    return button;
  };
  wrap.append(makeStep(-1), input, makeStep(1));
  return wrap;
}

function renderExerciseList(container, workout, ctx) {
  container.innerHTML = "";
  workout.exercises.forEach((exercise) => {
    const type = getExerciseType(exercise.name);
    const fields = INLINE_FIELDS[type];
    const card = document.createElement("article");
    card.className = "exercise-card";
    card.dataset.exerciseId = exercise.id;

    const head = document.createElement("header");
    head.className = "exercise-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "exercise-title";
    const title = document.createElement("h3");
    title.className = "exercise-name";
    title.textContent = exercise.name;
    const previous = getPreviousSets(exercise.name, workout.startedAt ?? Infinity, workout.id);
    const sub = document.createElement("p");
    sub.className = "exercise-type";
    sub.textContent = previous ? `Letztes Mal: ${summarizeSets(previous.sets, type)}` : EXERCISE_TYPES[type].label;
    titleWrap.append(title, sub);

    const actions = document.createElement("div");
    actions.className = "exercise-actions";
    if ((type === "strength" || type === "bodyweight") && ctx.kind !== "finished") {
      const on = restEnabledFor(exercise.name);
      const restBtn = makeIconButton(on ? TIMER_ICON : TIMER_OFF_ICON, `Pausen-Timer für ${exercise.name}`, () => {
        state.exercises[exercise.name] = { ...(state.exercises[exercise.name] || { type }), rest: !on };
        persistAndRender();
        showToast(`Pausen-Timer für ${exercise.name} ${on ? "aus" : "an"}`);
      });
      restBtn.setAttribute("aria-pressed", String(on));
      restBtn.classList.toggle("is-on", on);
      actions.appendChild(restBtn);
    }
    actions.appendChild(makeIconButton(TRASH_ICON, `Übung ${exercise.name} entfernen`, () => removeExercise(ctx, exercise.id)));
    head.append(titleWrap, actions);
    card.appendChild(head);

    if (exercise.sets.length > 0) {
      const grid = `28px repeat(${fields.length}, minmax(0, 1fr))${ctx.kind === "active" ? " 48px" : ""}`;
      const headRow = document.createElement("div");
      headRow.className = "set-head";
      headRow.style.gridTemplateColumns = grid;
      headRow.setAttribute("aria-hidden", "true");
      headRow.append(document.createElement("span"));
      for (const field of fields) {
        const label = document.createElement("span");
        label.textContent = field.head;
        headRow.appendChild(label);
      }
      if (ctx.kind === "active") headRow.append(document.createElement("span"));
      card.appendChild(headRow);

      const list = document.createElement("ol");
      list.className = "set-list";
      exercise.sets.forEach((set, index) => {
        const row = document.createElement("li");
        row.className = "set-row";
        row.style.gridTemplateColumns = grid;
        row.classList.toggle("is-planned", Boolean(set.planned));
        row.classList.toggle("is-done", Boolean(set.done) && !set.planned && ctx.kind === "active");

        const indexBtn = document.createElement("button");
        indexBtn.type = "button";
        indexBtn.className = "set-index";
        indexBtn.textContent = String(index + 1);
        indexBtn.setAttribute("aria-label", `Satz ${index + 1}: Details und Löschen`);
        indexBtn.addEventListener("click", () => openSetDialog(ctx, exercise.id, set.id));
        row.appendChild(indexBtn);

        for (const field of fields) row.appendChild(buildFieldControl(ctx, exercise, set, field, index, row));

        if (ctx.kind === "active") {
          const check = document.createElement("button");
          check.type = "button";
          check.className = "check-btn";
          const done = Boolean(set.done) && !set.planned;
          check.setAttribute("aria-pressed", String(done));
          check.setAttribute("aria-label", `Satz ${index + 1} ${done ? "nicht mehr als erledigt markieren" : "als erledigt markieren"}`);
          check.innerHTML = CHECK_ICON;
          check.addEventListener("click", () => toggleSetDone(exercise.id, set.id));
          row.appendChild(check);
        }
        list.appendChild(row);
      });
      card.appendChild(list);
    }

    const addSetBtn = document.createElement("button");
    addSetBtn.type = "button";
    addSetBtn.className = "btn btn-secondary btn-block add-set-btn";
    addSetBtn.textContent = "+ Satz";
    addSetBtn.setAttribute("aria-label", `Satz zu ${exercise.name} hinzufügen`);
    addSetBtn.addEventListener("click", () => addSetInstant(ctx, exercise.id));
    card.appendChild(addSetBtn);

    container.appendChild(card);
  });
}

function newSetFor(ctx, values) {
  const set = { id: createId("s"), ...values };
  if (ctx.kind === "active") set.done = false;
  if (ctx.kind === "finished") set.done = true;
  return set;
}

function addSetInstant(ctx, exerciseId) {
  const workout = getWorkoutByCtx(ctx);
  const exercise = workout?.exercises.find((item) => item.id === exerciseId);
  if (!exercise) return;
  const last = exercise.sets[exercise.sets.length - 1];
  exercise.sets.push(newSetFor(ctx, last ? pickSetValues(last) : getPrefillValues(workout, exercise)));
  persistAndRender();
}

function deleteSet(ctx, exerciseId, setId) {
  const { exercise } = findSet(ctx, exerciseId, setId);
  const index = exercise ? exercise.sets.findIndex((item) => item.id === setId) : -1;
  if (index < 0) return;
  const [removed] = exercise.sets.splice(index, 1);
  persistAndRender();
  showUndoToast(`Satz ${index + 1} gelöscht`, () => {
    const target = getWorkoutByCtx(ctx)?.exercises.find((item) => item.id === exerciseId);
    if (!target) return;
    target.sets.splice(Math.min(index, target.sets.length), 0, removed);
    persistAndRender();
  });
}

function removeExercise(ctx, exerciseId) {
  const workout = getWorkoutByCtx(ctx);
  const index = workout ? workout.exercises.findIndex((item) => item.id === exerciseId) : -1;
  if (index < 0) return;
  const [removed] = workout.exercises.splice(index, 1);
  persistAndRender();
  showUndoToast(`„${removed.name}“ entfernt`, () => {
    const target = getWorkoutByCtx(ctx);
    if (!target) return;
    target.exercises.splice(Math.min(index, target.exercises.length), 0, removed);
    persistAndRender();
  });
}

function isSetComplete(set, type) {
  if (type === "strength" || type === "bodyweight") return set.reps > 0;
  if (type === "endurance") return set.distance > 0 || set.durationSec > 0;
  return set.durationSec > 0;
}

function toggleSetDone(exerciseId, setId) {
  const workout = state.activeWorkout;
  const set = workout?.exercises.find((item) => item.id === exerciseId)?.sets.find((item) => item.id === setId);
  if (!set) return;
  if (set.planned && !isSetComplete(set, getExerciseType(workout.exercises.find((item) => item.id === exerciseId).name))) {
    openSetDialog({ kind: "active" }, exerciseId, setId);
    return;
  }
  const nowDone = set.planned ? true : !set.done;
  set.planned = false;
  set.done = nowDone;
  const exercise = workout.exercises.find((item) => item.id === exerciseId);
  if (nowDone && restEnabledFor(exercise.name)) startRest();
  persistAndRender();
}

// ---------- Add exercise dialog ----------

const exerciseDialog = document.getElementById("exercise-dialog");
const exerciseForm = document.getElementById("exercise-form");
const exerciseKnownSection = document.getElementById("exercise-known-section");
const exerciseKnownChips = document.getElementById("exercise-known-chips");
const newExerciseName = document.getElementById("new-exercise-name");
const typePicker = document.getElementById("type-picker");
const exerciseHint = document.getElementById("exercise-hint");
const exerciseError = document.getElementById("exercise-error");
let exerciseDialogCtx = null;

function openExerciseDialog(ctx) {
  exerciseDialogCtx = ctx;
  const workout = getWorkoutByCtx(ctx);
  const inWorkout = new Set(workout.exercises.map((exercise) => exercise.name));
  const known = getKnownExercisesByRecency().filter((name) => !inWorkout.has(name));

  exerciseKnownChips.innerHTML = "";
  for (const name of known) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.setAttribute("aria-label", `${name} hinzufügen (${EXERCISE_TYPES[getExerciseType(name)].label})`);
    chip.addEventListener("click", () => addExerciseToWorkout(name));
    exerciseKnownChips.appendChild(chip);
  }
  exerciseKnownSection.hidden = known.length === 0;
  exerciseForm.reset();
  exerciseHint.textContent = "";
  exerciseError.textContent = "";
  typePicker.disabled = false;
  exerciseDialog.showModal();
}

function addExerciseToWorkout(name, type) {
  const workout = getWorkoutByCtx(exerciseDialogCtx);
  if (!workout) return;
  if (!state.exercises[name]) state.exercises[name] = { type: type || "strength" };
  const exercise = { id: createId("e"), name, sets: [] };
  const firstSet = newSetFor(exerciseDialogCtx, getPrefillValues(workout, exercise));
  if (exerciseDialogCtx.kind === "active") firstSet.planned = true;
  exercise.sets.push(firstSet);
  workout.exercises.push(exercise);
  exerciseDialog.close();
  persistAndRender();
  const card = document.querySelector(`[data-exercise-id="${workout.exercises[workout.exercises.length - 1].id}"]`);
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
}

newExerciseName.addEventListener("input", () => {
  const name = normalizeExerciseName(newExerciseName.value);
  exerciseError.textContent = "";
  const existing = name && state.exercises[name];
  if (existing) {
    exerciseHint.textContent = `„${name}“ gibt es schon (Typ: ${EXERCISE_TYPES[existing.type].label}). Sie wird mit diesem Typ hinzugefügt.`;
    typePicker.disabled = true;
  } else {
    exerciseHint.textContent = "";
    typePicker.disabled = false;
  }
});

exerciseForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = normalizeExerciseName(newExerciseName.value);
  if (!name) {
    exerciseError.textContent = "Bitte gib einen Namen ein oder wähle oben eine Übung.";
    newExerciseName.focus();
    return;
  }
  const workout = getWorkoutByCtx(exerciseDialogCtx);
  if (workout.exercises.some((exercise) => exercise.name === name)) {
    exerciseError.textContent = `„${name}“ ist schon in diesem Workout.`;
    return;
  }
  const type = exerciseForm.elements["exercise-type"].value;
  addExerciseToWorkout(name, type);
});

document.getElementById("exercise-cancel").addEventListener("click", () => exerciseDialog.close());

// ---------- Set editor dialog ----------

const setDialog = document.getElementById("set-dialog");
const setForm = document.getElementById("set-form");
const setDialogTitle = document.getElementById("set-dialog-title");
const setDialogLast = document.getElementById("set-dialog-last");
const setWeightInput = document.getElementById("set-weight");
const setRepsInput = document.getElementById("set-reps");
const setDistanceInput = document.getElementById("set-distance");
const setTimeInput = document.getElementById("set-time");
const setDurationInput = document.getElementById("set-duration");
const setPace = document.getElementById("set-pace");
const setError = document.getElementById("set-error");
const setDeleteBtn = document.getElementById("set-delete");
let setEditor = null;

const FIELDS_BY_TYPE = {
  strength: ["weight", "reps"],
  bodyweight: ["reps"],
  endurance: ["distance", "time"],
  timed: ["duration"],
};

function formatInputNumber(value) {
  return value === null || value === undefined ? "" : String(roundTo(value, 2)).replace(".", ",");
}

function openSetDialog(ctx, exerciseId, setId) {
  const workout = getWorkoutByCtx(ctx);
  const exercise = workout?.exercises.find((item) => item.id === exerciseId);
  if (!exercise) return;
  const type = getExerciseType(exercise.name);
  const set = setId ? exercise.sets.find((item) => item.id === setId) : null;
  const index = set ? exercise.sets.indexOf(set) : exercise.sets.length;
  const values = set ? pickSetValues(set) : getPrefillValues(workout, exercise);
  setEditor = { ctx, exerciseId, setId, type };

  setDialogTitle.textContent = `${exercise.name} · Satz ${index + 1}`;
  const previous = getPreviousSets(exercise.name, workout.startedAt ?? Infinity, workout.id);
  setDialogLast.textContent = previous ? `Letztes Mal: ${summarizeSets(previous.sets, type)}` : "";

  const visible = FIELDS_BY_TYPE[type];
  setForm.querySelectorAll("[data-field]").forEach((group) => {
    group.hidden = !visible.includes(group.dataset.field);
  });
  setWeightInput.value = formatInputNumber(values.weight ?? 0);
  setRepsInput.value = values.reps ? String(values.reps) : "";
  setDistanceInput.value = formatInputNumber(values.distance);
  setTimeInput.value = values.durationSec ? formatClock(values.durationSec * 1000) : "";
  setDurationInput.value = values.durationSec ? String(values.durationSec) : "";
  setError.textContent = "";
  setDeleteBtn.hidden = !set;
  updatePacePreview();
  setDialog.showModal();
}

function updatePacePreview() {
  const distance = parseDecimal(setDistanceInput.value);
  const durationSec = parseDurationInput(setTimeInput.value, "min");
  const pace = getPaceSecPerKm({ distance, durationSec });
  setPace.textContent = pace ? `Tempo: ${formatPace(pace)}` : "";
}

setDistanceInput.addEventListener("input", updatePacePreview);
setTimeInput.addEventListener("input", updatePacePreview);

setForm.querySelectorAll("[data-step-target]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.stepTarget);
    const step = Number(button.dataset.step);
    if (input === setDurationInput) {
      const current = parseDurationInput(input.value, "sec");
      input.value = String(Math.max(0, (Number.isFinite(current) ? current : 0) + step));
      return;
    }
    const current = parseDecimal(input.value);
    const next = Math.max(0, roundTo((Number.isFinite(current) ? current : 0) + step, 2));
    input.value = formatInputNumber(next);
  });
});

function readSetForm(type) {
  const values = { weight: null, reps: null, distance: null, durationSec: null };
  if (type === "strength") {
    const weight = parseDecimal(setWeightInput.value);
    if (weight === null || Number.isNaN(weight) || weight < 0) return { error: "Bitte ein gültiges Gewicht eingeben (0 oder mehr)." };
    values.weight = roundTo(weight, 2);
  }
  if (type === "strength" || type === "bodyweight") {
    const reps = parseDecimal(setRepsInput.value);
    if (!Number.isInteger(reps) || reps < 1) return { error: "Bitte mindestens 1 Wiederholung eingeben." };
    values.reps = reps;
  }
  if (type === "endurance") {
    const distance = parseDecimal(setDistanceInput.value);
    const durationSec = parseDurationInput(setTimeInput.value, "min");
    if (Number.isNaN(distance) || (distance !== null && distance < 0)) return { error: "Bitte eine gültige Distanz eingeben." };
    if (Number.isNaN(durationSec)) return { error: "Bitte die Zeit als Minuten oder mm:ss eingeben." };
    if (!(distance > 0) && !(durationSec > 0)) return { error: "Bitte Distanz oder Zeit eingeben." };
    values.distance = distance > 0 ? roundTo(distance, 2) : null;
    values.durationSec = durationSec > 0 ? durationSec : null;
  }
  if (type === "timed") {
    const durationSec = parseDurationInput(setDurationInput.value, "sec");
    if (!(durationSec > 0)) return { error: "Bitte eine Dauer größer als 0 eingeben." };
    values.durationSec = durationSec;
  }
  return { values };
}

setForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!setEditor) return;
  const { values, error } = readSetForm(setEditor.type);
  if (error) {
    setError.textContent = error;
    return;
  }
  const workout = getWorkoutByCtx(setEditor.ctx);
  const exercise = workout?.exercises.find((item) => item.id === setEditor.exerciseId);
  if (!exercise) return;
  const existing = setEditor.setId ? exercise.sets.find((item) => item.id === setEditor.setId) : null;
  if (existing) {
    Object.assign(existing, values, { planned: false });
  } else {
    exercise.sets.push({ id: createId("s"), ...values, done: false });
  }
  setDialog.close();
  persistAndRender();
});

setDeleteBtn.addEventListener("click", () => {
  if (!setEditor?.setId) return;
  const editor = setEditor;
  setDialog.close();
  deleteSet(editor.ctx, editor.exerciseId, editor.setId);
});

document.getElementById("set-cancel").addEventListener("click", () => setDialog.close());

// ---------- Rest timer ----------

const restTimerEl = document.getElementById("rest-timer");
const restLabel = document.getElementById("rest-label");
const restTime = document.getElementById("rest-time");
const restProgressBar = document.getElementById("rest-progress-bar");
const restSettingValue = document.getElementById("rest-setting-value");
let restDoneUntil = 0;

function startRest() {
  const workout = state.activeWorkout;
  if (!workout) return;
  workout.restTotalSec = state.settings.restSeconds;
  workout.restEndsAt = Date.now() + state.settings.restSeconds * 1000;
  restDoneUntil = 0;
}

function adjustRest(deltaSec) {
  const workout = state.activeWorkout;
  if (!workout?.restEndsAt) return;
  workout.restEndsAt += deltaSec * 1000;
  workout.restTotalSec = Math.max(workout.restTotalSec + deltaSec, 1);
  saveState();
  updateRestTimer();
}

function skipRest() {
  const workout = state.activeWorkout;
  if (!workout) return;
  workout.restEndsAt = null;
  restDoneUntil = 0;
  saveState();
  updateRestTimer();
}

function updateRestTimer() {
  const workout = state.activeWorkout;
  const now = Date.now();
  if (workout?.restEndsAt) {
    const remaining = workout.restEndsAt - now;
    if (remaining <= 0) {
      workout.restEndsAt = null;
      saveState();
      restDoneUntil = now + 4000;
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } else {
      restTimerEl.hidden = false;
      restTimerEl.classList.remove("is-finished");
      restLabel.textContent = "Pause";
      restTime.textContent = formatClock(remaining + 999);
      restProgressBar.style.width = `${Math.min(100, (remaining / (workout.restTotalSec * 1000)) * 100)}%`;
      document.body.classList.add("rest-active");
      return;
    }
  }
  if (now < restDoneUntil) {
    restTimerEl.hidden = false;
    restTimerEl.classList.add("is-finished");
    restLabel.textContent = "Pause vorbei";
    restTime.textContent = "Weiter geht's";
    restProgressBar.style.width = "0%";
    document.body.classList.add("rest-active");
    return;
  }
  restTimerEl.hidden = true;
  document.body.classList.remove("rest-active");
}

function changeRestSetting(deltaSec) {
  state.settings.restSeconds = Math.min(600, Math.max(15, state.settings.restSeconds + deltaSec));
  saveState();
  renderRestSetting();
}

function renderRestSetting() {
  restSettingValue.textContent = formatClock(state.settings.restSeconds * 1000);
}

document.getElementById("rest-minus").addEventListener("click", () => adjustRest(-15));
document.getElementById("rest-plus").addEventListener("click", () => adjustRest(15));
document.getElementById("rest-skip").addEventListener("click", skipRest);
document.getElementById("rest-setting-minus").addEventListener("click", () => changeRestSetting(-15));
document.getElementById("rest-setting-plus").addEventListener("click", () => changeRestSetting(15));

// ---------- Workout screen exercises ----------

const workoutExercisesEl = document.getElementById("workout-exercises");
const workoutEmpty = document.getElementById("workout-empty");

function renderWorkoutExercises() {
  const workout = state.activeWorkout;
  if (!workout) {
    workoutExercisesEl.innerHTML = "";
    return;
  }
  renderExerciseList(workoutExercisesEl, workout, { kind: "active" });
  workoutEmpty.hidden = workout.exercises.length > 0;
  renderRestSetting();
}

document.getElementById("add-exercise-btn").addEventListener("click", () => openExerciseDialog({ kind: "active" }));

// ---------- Workout statistics and personal records ----------

function computeWorkoutStats(workout) {
  let setCount = 0;
  let volume = 0;
  let exerciseCount = 0;
  for (const exercise of workout.exercises) {
    const sets = getRealSets(exercise);
    if (sets.length > 0) exerciseCount += 1;
    const type = getExerciseType(exercise.name);
    for (const set of sets) {
      setCount += 1;
      if (type === "strength" && set.weight > 0 && set.reps > 0) volume += set.weight * set.reps;
    }
  }
  return { durationMs: getElapsedMs(workout), exerciseCount, setCount, volume };
}

function estimateOneRepMax(weight, reps) {
  if (!(weight > 0) || !(reps > 0)) return null;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

const RECORD_DEFS = {
  strength: [
    { label: "Schwerster Satz", value: (set) => (set.reps > 0 ? set.weight || null : null), format: (v) => `${formatNumber(v)} ${UNITS.weight}` },
    { label: "Bestes geschätztes Maximum", value: (set) => estimateOneRepMax(set.weight, set.reps), format: (v) => `${formatNumber(v, 1)} ${UNITS.weight}` },
  ],
  bodyweight: [{ label: "Meiste Wiederholungen", value: (set) => set.reps || null, format: (v) => `${v} Wdh.` }],
  endurance: [
    { label: "Längste Distanz", value: (set) => set.distance || null, format: (v) => `${formatNumber(v)} ${UNITS.distance}` },
    { label: "Bestes Tempo", value: (set) => getPaceSecPerKm(set), format: (v) => formatPace(v), lowerIsBetter: true },
  ],
  timed: [{ label: "Längste Dauer", value: (set) => set.durationSec || null, format: (v) => formatClock(v * 1000) }],
};

function bestRecordValue(sets, def) {
  let best = null;
  for (const set of sets) {
    const value = def.value(set);
    if (value === null || !Number.isFinite(value)) continue;
    if (best === null || (def.lowerIsBetter ? value < best : value > best)) best = value;
  }
  return best;
}

// Records improved by this workout compared to all saved workouts that started before it.
function findNewRecords(workout) {
  const records = [];
  for (const exercise of workout.exercises) {
    const sets = getRealSets(exercise);
    if (sets.length === 0) continue;
    const type = getExerciseType(exercise.name);
    const earlierSets = state.workouts
      .filter((other) => other.id !== workout.id && other.startedAt < workout.startedAt)
      .flatMap((other) => other.exercises.filter((item) => item.name === exercise.name).flatMap(getRealSets));
    if (earlierSets.length === 0) continue;
    for (const def of RECORD_DEFS[type] || []) {
      const current = bestRecordValue(sets, def);
      const previous = bestRecordValue(earlierSets, def);
      if (current === null || previous === null) continue;
      const improved = def.lowerIsBetter ? current < previous - 0.5 : current > previous + 1e-9;
      if (improved) {
        records.push({ exercise: exercise.name, label: def.label, value: def.format(current), previous: def.format(previous) });
      }
    }
  }
  return records;
}

function renderStatGrid(container, workout) {
  const stats = computeWorkoutStats(workout);
  const tiles = [
    ["Dauer", formatDurationLong(stats.durationMs)],
    ["Übungen", String(stats.exerciseCount)],
    ["Sätze", String(stats.setCount)],
    ["Volumen", `${formatNumber(Math.round(stats.volume), 0)} ${UNITS.weight}`],
  ];
  container.innerHTML = "";
  for (const [label, value] of tiles) {
    const tile = document.createElement("div");
    tile.className = "stat-tile";
    const valueEl = document.createElement("span");
    valueEl.className = "stat-value";
    valueEl.textContent = value;
    const labelEl = document.createElement("span");
    labelEl.className = "stat-label";
    labelEl.textContent = label;
    tile.append(valueEl, labelEl);
    container.appendChild(tile);
  }
}

// ---------- Summary dialog ----------

const ARROW_UP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

const summaryDialog = document.getElementById("summary-dialog");
const summaryTemplateBtn = document.getElementById("summary-template-btn");
let summaryWorkoutId = null;

function openSummary(workout) {
  summaryWorkoutId = workout.id;
  document.getElementById("summary-title").textContent = workout.name;
  renderStatGrid(document.getElementById("summary-stats"), workout);

  const records = findNewRecords(workout);
  const prList = document.getElementById("summary-prs");
  prList.innerHTML = "";
  for (const record of records) {
    const item = document.createElement("li");
    item.className = "pr-item";
    const icon = document.createElement("span");
    icon.className = "pr-icon";
    icon.innerHTML = ARROW_UP_ICON;
    const text = document.createElement("div");
    text.className = "pr-text";
    const title = document.createElement("strong");
    title.textContent = `${record.exercise}: ${record.value}`;
    const sub = document.createElement("span");
    sub.textContent = `Neuer Bestwert – ${record.label} (vorher ${record.previous})`;
    text.append(title, sub);
    item.append(icon, text);
    prList.appendChild(item);
  }
  document.getElementById("summary-prs-section").hidden = records.length === 0;
  document.getElementById("summary-no-prs").textContent =
    records.length === 0 ? "Diesmal keine neuen Bestwerte – Hauptsache dabeigeblieben." : "";

  summaryTemplateBtn.disabled = workout.exercises.length === 0;
  summaryTemplateBtn.textContent = "Zu „Meine Workouts“ hinzufügen";
  summaryDialog.showModal();
}

summaryTemplateBtn.addEventListener("click", () => {
  const workout = state.workouts.find((item) => item.id === summaryWorkoutId);
  if (workout) openTemplateDialog(workout);
});
document.getElementById("summary-done-btn").addEventListener("click", () => summaryDialog.close());

// ---------- Templates ----------

const templateDialog = document.getElementById("template-dialog");
const templateForm = document.getElementById("template-form");
const templateNameInput = document.getElementById("template-name");
const templateError = document.getElementById("template-error");
let templateSourceId = null;

function openTemplateDialog(workout) {
  templateSourceId = workout.id;
  templateNameInput.value = workout.name;
  templateError.textContent = "";
  templateDialog.showModal();
  templateNameInput.select();
}

templateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const workout = state.workouts.find((item) => item.id === templateSourceId);
  const name = templateNameInput.value.trim();
  if (!name) {
    templateError.textContent = "Bitte gib einen Namen ein.";
    return;
  }
  if (!workout || workout.exercises.length === 0) {
    templateError.textContent = "Dieses Workout enthält keine Übungen.";
    return;
  }
  const template = {
    id: createId("r"),
    name,
    notes: "",
    createdAt: Date.now(),
    exercises: workout.exercises
      .filter((exercise) => getRealSets(exercise).length > 0)
      .map((exercise) => ({
        id: createId("e"),
        name: exercise.name,
        sets: getRealSets(exercise).map((set) => ({ id: createId("s"), ...copySetValues(set) })),
      })),
  };
  const existingIndex = state.routines.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
  if (existingIndex >= 0) state.routines[existingIndex] = { ...template, id: state.routines[existingIndex].id, createdAt: state.routines[existingIndex].createdAt };
  else state.routines.push(template);
  templateDialog.close();
  if (workout.id === summaryWorkoutId && summaryDialog.open) {
    summaryTemplateBtn.disabled = true;
    summaryTemplateBtn.textContent = "In „Meine Workouts“ gespeichert";
  }
  persistAndRender();
  showToast(existingIndex >= 0 ? `„${name}“ in Meine Workouts aktualisiert` : `„${name}“ zu Meine Workouts hinzugefügt`);
});

document.getElementById("template-cancel").addEventListener("click", () => templateDialog.close());

// ---------- Meine Workouts (planned workouts) ----------

const PENCIL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const NEW_ROUTINE_NAME = "Neues Workout";

const routineScreen = document.getElementById("routine-screen");
const routineList = document.getElementById("routine-list");
const routinesEmpty = document.getElementById("routines-empty");
const routineNameInput = document.getElementById("routine-name");
const routineExercisesEl = document.getElementById("routine-exercises");
const routineEmpty = document.getElementById("routine-empty");
const repeatLastBtn = document.getElementById("repeat-last-btn");

function getRoutine(id) {
  return state.routines.find((routine) => routine.id === id) || null;
}

function getLastWorkoutForRoutine(routineId) {
  return state.workouts.filter((workout) => workout.routineId === routineId).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}

function makeIconButton(icon, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn icon-btn-plain";
  button.innerHTML = icon;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function renderRoutines() {
  const last = getLastWorkout();
  repeatLastBtn.hidden = !last || Boolean(state.activeWorkout);
  if (last) repeatLastBtn.setAttribute("aria-label", `Letztes Training wiederholen: ${last.name}`);
  routineList.innerHTML = "";
  routinesEmpty.hidden = state.routines.length > 0;
  const hasActive = Boolean(state.activeWorkout);
  for (const routine of state.routines) {
    const item = document.createElement("li");
    item.className = "routine-card";

    const head = document.createElement("div");
    head.className = "routine-head";
    const title = document.createElement("h3");
    title.className = "routine-name";
    title.textContent = routine.name;
    const actions = document.createElement("div");
    actions.className = "routine-actions";
    actions.append(
      makeIconButton(PENCIL_ICON, `${routine.name} bearbeiten`, () => openRoutineEditor(routine.id)),
      makeIconButton(COPY_ICON, `${routine.name} duplizieren`, () => duplicateRoutine(routine.id)),
      makeIconButton(TRASH_ICON, `${routine.name} löschen`, () => deleteRoutine(routine.id))
    );
    head.append(title, actions);

    const names = routine.exercises.map((exercise) => exercise.name);
    const exercises = document.createElement("p");
    exercises.className = "routine-exercises";
    exercises.textContent =
      names.length === 0 ? "Noch keine Übungen" : names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");

    const last = getLastWorkoutForRoutine(routine.id);
    const meta = document.createElement("p");
    meta.className = "routine-meta";
    meta.textContent = last ? `Zuletzt ${formatShortDate(last.startedAt)} · ${formatDurationLong(getElapsedMs(last))}` : "Noch nicht trainiert";

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = `btn ${hasActive ? "btn-secondary" : "btn-primary"} btn-block routine-start`;
    startBtn.textContent = "Start";
    startBtn.setAttribute("aria-label", `${routine.name} starten`);
    startBtn.addEventListener("click", () => startWorkout(routine));

    item.append(head, exercises, meta, startBtn);
    routineList.appendChild(item);
  }
}

function getLastWorkout() {
  return state.workouts.reduce((latest, workout) => (!latest || workout.startedAt > latest.startedAt ? workout : latest), null);
}

function repeatLastWorkout() {
  const last = getLastWorkout();
  if (!last) return;
  const keepsDateName = last.name === formatWorkoutDefaultName(last.startedAt);
  startWorkout({
    id: last.routineId || null,
    name: keepsDateName ? null : last.name,
    exercises: last.exercises.map((exercise) => ({ name: exercise.name, sets: getRealSets(exercise) })).filter((exercise) => exercise.sets.length > 0),
  });
}

function createRoutine() {
  const routine = { id: createId("r"), name: NEW_ROUTINE_NAME, notes: "", createdAt: Date.now(), exercises: [] };
  state.routines.push(routine);
  saveState();
  openRoutineEditor(routine.id);
  routineNameInput.focus();
  routineNameInput.select();
}

function openRoutineEditor(routineId) {
  editingRoutineId = routineId;
  trainingView = "routine";
  renderTraining();
  window.scrollTo(0, 0);
}

function closeRoutineEditor() {
  const routine = getRoutine(editingRoutineId);
  // A draft that was opened but never filled in is not kept.
  if (routine && routine.exercises.length === 0 && routine.name === NEW_ROUTINE_NAME) {
    state.routines = state.routines.filter((item) => item.id !== routine.id);
    saveState();
  }
  trainingView = "start";
  editingRoutineId = null;
  renderTraining();
}

function renderRoutineEditor() {
  const routine = getRoutine(editingRoutineId);
  if (!routine) return;
  if (document.activeElement !== routineNameInput) routineNameInput.value = routine.name;
  renderExerciseList(routineExercisesEl, routine, { kind: "routine", routineId: routine.id });
  routineEmpty.hidden = routine.exercises.length > 0;
}

function cloneExercisesWithNewIds(exercises) {
  return exercises.map((exercise) => ({
    ...exercise,
    id: createId("e"),
    sets: exercise.sets.map((set) => ({ id: createId("s"), ...copySetValues(set) })),
  }));
}

function duplicateRoutine(routineId) {
  const index = state.routines.findIndex((routine) => routine.id === routineId);
  if (index < 0) return;
  const source = state.routines[index];
  const copy = { ...source, id: createId("r"), name: `${source.name} (Kopie)`, createdAt: Date.now(), exercises: cloneExercisesWithNewIds(source.exercises) };
  state.routines.splice(index + 1, 0, copy);
  persistAndRender();
  showToast(`„${copy.name}“ erstellt`);
}

function deleteRoutine(routineId) {
  const index = state.routines.findIndex((routine) => routine.id === routineId);
  if (index < 0) return;
  const [removed] = state.routines.splice(index, 1);
  persistAndRender();
  showUndoToast(`„${removed.name}“ gelöscht`, () => {
    state.routines.splice(Math.min(index, state.routines.length), 0, removed);
    persistAndRender();
  });
}

routineNameInput.addEventListener("input", () => {
  const routine = getRoutine(editingRoutineId);
  if (!routine) return;
  routine.name = routineNameInput.value.trim() || NEW_ROUTINE_NAME;
  saveState();
});
routineNameInput.addEventListener("change", () => {
  routineNameInput.value = getRoutine(editingRoutineId)?.name || "";
});
document.getElementById("new-workout-btn").addEventListener("click", createRoutine);
document.getElementById("repeat-last-btn").addEventListener("click", repeatLastWorkout);
document.getElementById("routine-back-btn").addEventListener("click", closeRoutineEditor);
document.getElementById("routine-add-exercise-btn").addEventListener("click", () =>
  openExerciseDialog({ kind: "routine", routineId: editingRoutineId })
);
document.getElementById("routine-start-btn").addEventListener("click", () => {
  const routine = getRoutine(editingRoutineId);
  if (routine) startWorkout(routine);
});

// ---------- History list and detail ----------

const workoutListEl = document.getElementById("workout-list");
const historyEmpty = document.getElementById("history-empty");

function formatWorkoutMeta(workout) {
  const date = new Date(workout.startedAt);
  const day = date.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  if (workout.migrated) return `${day} · übernommen aus alten Einträgen`;
  const time = date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time} Uhr · ${formatDurationLong(getElapsedMs(workout))}`;
}

function renderHistory() {
  const workouts = [...state.workouts].sort((a, b) => b.startedAt - a.startedAt);
  workoutListEl.innerHTML = "";
  historyEmpty.hidden = workouts.length > 0;
  for (const workout of workouts) {
    const stats = computeWorkoutStats(workout);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workout-item";
    const name = document.createElement("span");
    name.className = "workout-item-name";
    name.textContent = workout.name;
    const meta = document.createElement("span");
    meta.className = "workout-item-meta";
    meta.textContent = formatWorkoutMeta(workout);
    const summary = document.createElement("span");
    summary.className = "workout-item-summary";
    const parts = [
      `${stats.exerciseCount} ${stats.exerciseCount === 1 ? "Übung" : "Übungen"}`,
      `${stats.setCount} ${stats.setCount === 1 ? "Satz" : "Sätze"}`,
    ];
    if (stats.volume > 0) parts.push(`${formatNumber(Math.round(stats.volume), 0)} ${UNITS.weight}`);
    summary.textContent = parts.join(" · ");
    button.append(name, meta, summary);
    button.addEventListener("click", () => openDetail(workout.id));
    item.appendChild(button);
    workoutListEl.appendChild(item);
  }
}

const detailDialog = document.getElementById("detail-dialog");
const detailNameInput = document.getElementById("detail-name");
let detailWorkoutId = null;

function openDetail(workoutId) {
  detailWorkoutId = workoutId;
  renderDetail();
  detailDialog.showModal();
  detailDialog.scrollTop = 0;
}

function renderDetail() {
  const workout = state.workouts.find((item) => item.id === detailWorkoutId);
  if (!workout) {
    if (detailDialog.open) detailDialog.close();
    return;
  }
  if (document.activeElement !== detailNameInput) detailNameInput.value = workout.name;
  document.getElementById("detail-meta").textContent = formatWorkoutMeta(workout);
  renderStatGrid(document.getElementById("detail-stats"), workout);
  renderExerciseList(document.getElementById("detail-exercises"), workout, { kind: "finished", workoutId: workout.id });
  document.getElementById("detail-empty").hidden = workout.exercises.length > 0;
  document.getElementById("detail-template").disabled = workout.exercises.length === 0;
}

detailNameInput.addEventListener("change", () => {
  const workout = state.workouts.find((item) => item.id === detailWorkoutId);
  if (!workout) return;
  workout.name = detailNameInput.value.trim() || formatWorkoutDefaultName(workout.startedAt);
  detailNameInput.value = workout.name;
  persistAndRender();
});

document.getElementById("detail-close").addEventListener("click", () => detailDialog.close());
document.getElementById("detail-add-exercise").addEventListener("click", () =>
  openExerciseDialog({ kind: "finished", workoutId: detailWorkoutId })
);
document.getElementById("detail-template").addEventListener("click", () => {
  const workout = state.workouts.find((item) => item.id === detailWorkoutId);
  if (workout) openTemplateDialog(workout);
});
document.getElementById("detail-delete").addEventListener("click", () => {
  const index = state.workouts.findIndex((item) => item.id === detailWorkoutId);
  if (index < 0) return;
  const [removed] = state.workouts.splice(index, 1);
  detailDialog.close();
  persistAndRender();
  showUndoToast(`„${removed.name}“ gelöscht`, () => {
    state.workouts.splice(Math.min(index, state.workouts.length), 0, removed);
    persistAndRender();
  });
});

document.getElementById("history-start-btn").addEventListener("click", () => switchTab("training"));

// ---------- Statistics: periods and helpers ----------

const DAY_MS = 24 * 60 * 60 * 1000;

const PERIODS = {
  "4w": { days: 28, compareLabel: "vorherige 4 Wochen", trendLabel: "in 4 Wochen" },
  "3m": { days: 91, compareLabel: "vorherige 3 Monate", trendLabel: "in 3 Monaten" },
  "1y": { days: 365, compareLabel: "vorheriges Jahr", trendLabel: "in einem Jahr" },
  all: { days: null, compareLabel: null, trendLabel: "seit dem ersten Training" },
};

const ARROW_DOWN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
const FLAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function addDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function startOfIsoWeek(timestamp) {
  const date = new Date(startOfDay(timestamp));
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

function formatLongDate(timestamp) {
  return new Date(timestamp).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
}

function getPeriodKey() {
  return PERIODS[state.settings.statPeriod] ? state.settings.statPeriod : "3m";
}

function getPeriodRange(key) {
  const end = addDays(startOfDay(Date.now()), 1);
  const days = PERIODS[key].days;
  if (!days) {
    const first = state.workouts.reduce((min, workout) => Math.min(min, workout.startedAt), Date.now());
    return { start: startOfDay(first), end, prevStart: null, prevEnd: null };
  }
  const start = addDays(end, -days);
  return { start, end, prevStart: addDays(start, -days), prevEnd: start };
}

function getWorkoutsBetween(start, end) {
  return state.workouts
    .filter((workout) => workout.startedAt >= start && workout.startedAt < end)
    .sort((a, b) => a.startedAt - b.startedAt);
}

// At most maxCount evenly spaced, "round" tick values covering [min, max].
function niceTicks(min, max, { maxCount = 5, time = false, minutes = false, integer = false, includeZero = false } = {}) {
  if (includeZero) min = Math.min(0, min);
  if (min === max) {
    const pad = time ? 30 : Math.max(Math.abs(max) * 0.1, integer ? 1 : 0.5);
    min = Math.max(0, min - pad);
    max += pad;
  }
  const raw = (max - min) / (maxCount - 1);
  let step;
  if (time) {
    step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find((candidate) => candidate >= raw) || 3600 * Math.ceil(raw / 3600);
  } else if (minutes) {
    step = [5, 10, 15, 30, 60, 90, 120, 180, 240, 360, 480, 600].find((candidate) => candidate >= raw) || 60 * Math.ceil(raw / 60);
  } else {
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw);
    if (integer) step = Math.max(1, Math.ceil(step));
  }
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  while (Math.round((hi - lo) / step) + 1 > maxCount) {
    step *= 2;
    lo = Math.floor(min / step) * step;
    hi = Math.ceil(max / step) * step;
  }
  const ticks = [];
  for (let value = lo; value <= hi + step * 1e-6; value += step) ticks.push(roundTo(value, 6));
  return ticks;
}

// ---------- Statistics: charts ----------

const CHART = { width: 340, height: 200, padL: 46, padR: 16, padT: 20, padB: 28 };

function attachChartTooltip(container, targets, onSelect) {
  const tooltip = container.querySelector(".chart-tooltip");
  const show = (index) => {
    const target = targets[index];
    tooltip.textContent = target.text;
    tooltip.hidden = false;
    const leftPct = (target.x / CHART.width) * 100;
    tooltip.style.left = `${leftPct}%`;
    tooltip.style.top = `${(target.y / CHART.height) * 100}%`;
    tooltip.classList.toggle("align-start", leftPct < 22);
    tooltip.classList.toggle("align-end", leftPct > 78);
    onSelect(index);
  };
  container.querySelectorAll("[data-index]").forEach((element) => {
    const index = Number(element.dataset.index);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      show(index);
    });
    element.addEventListener("focus", () => show(index));
    element.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        show(index);
      }
    });
  });
}

document.addEventListener("click", (event) => {
  if (event.target.closest?.("[data-index]")) return;
  document.querySelectorAll(".chart-tooltip").forEach((tooltip) => (tooltip.hidden = true));
  document.querySelectorAll(".chart-focus-ring").forEach((ring) => ring.setAttribute("visibility", "hidden"));
  document.querySelectorAll(".bar.is-selected").forEach((bar) => bar.classList.remove("is-selected"));
});

function yAxisSvg(ticks, y, tickFormat) {
  const { width: W, padL, padR } = CHART;
  return ticks
    .map((value) => {
      const yy = y(value).toFixed(1);
      return `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" class="grid-line"/><text x="${padL - 8}" y="${yy}" class="axis-label" text-anchor="end" dominant-baseline="middle">${escapeHtml(tickFormat(value))}</text>`;
    })
    .join("");
}

function renderLineChart(container, points, metric, domain, ariaLabel) {
  const { width: W, height: H, padL, padR, padT, padB } = CHART;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const values = points.map((point) => point.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), { time: metric.time, integer: metric.integer });
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  let [d0, d1] = domain;
  if (d1 - d0 < DAY_MS) {
    d0 -= DAY_MS;
    d1 += DAY_MS;
  }
  const x = (t) => padL + ((t - d0) / (d1 - d0)) * innerW;
  const y = (v) => padT + (1 - (v - yMin) / (yMax - yMin || 1)) * innerH;
  const baseY = (padT + innerH).toFixed(1);

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escapeHtml(ariaLabel)}">`;
  svg += yAxisSvg(ticks, y, metric.tick);
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${baseY}" y2="${baseY}" class="axis-line"/>`;
  for (let i = 0; i < 4; i += 1) {
    const t = d0 + (i / 3) * (d1 - d0);
    const anchor = i === 0 ? "start" : i === 3 ? "end" : "middle";
    svg += `<text x="${x(t).toFixed(1)}" y="${H - 8}" class="axis-label" text-anchor="${anchor}">${formatShortDate(t)}</text>`;
  }

  const coords = points.map((point) => ({ x: x(point.t), y: y(point.value) }));
  if (coords.length > 1) {
    const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const first = coords[0];
    const last = coords[coords.length - 1];
    svg += `<polygon points="${first.x.toFixed(1)},${baseY} ${line} ${last.x.toFixed(1)},${baseY}" class="chart-area"/>`;
    svg += `<polyline points="${line}" class="chart-line"/>`;
  }
  coords.forEach((c, i) => {
    const isLast = i === coords.length - 1;
    svg += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${isLast ? 5.5 : 3}" class="chart-dot${isLast ? " chart-dot-current" : ""}"/>`;
  });
  const lastCoord = coords[coords.length - 1];
  const labelAnchor = lastCoord.x > W - 70 ? "end" : lastCoord.x < padL + 40 ? "start" : "middle";
  svg += `<text x="${lastCoord.x.toFixed(1)}" y="${Math.max(12, lastCoord.y - 12).toFixed(1)}" class="chart-value-label" text-anchor="${labelAnchor}">${escapeHtml(metric.format(points[points.length - 1].value))}</text>`;
  svg += `<circle class="chart-focus-ring" r="9" cx="0" cy="0" visibility="hidden"/>`;
  coords.forEach((c, i) => {
    const label = `${formatLongDate(points[i].t)}: ${metric.format(points[i].value)}`;
    svg += `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="14" class="chart-hit" data-index="${i}" tabindex="0" role="button" aria-label="${escapeHtml(label)}"/>`;
  });
  svg += `</svg><div class="chart-tooltip" role="status" hidden></div>`;
  container.innerHTML = svg;

  const ring = container.querySelector(".chart-focus-ring");
  attachChartTooltip(
    container,
    coords.map((c, i) => ({ x: c.x, y: c.y, text: `${formatLongDate(points[i].t)} · ${metric.format(points[i].value)}` })),
    (index) => {
      ring.setAttribute("cx", coords[index].x.toFixed(1));
      ring.setAttribute("cy", coords[index].y.toFixed(1));
      ring.setAttribute("visibility", "visible");
    }
  );
}

function renderBarChart(container, weeks, format, tickOptions, ariaLabel) {
  const { width: W, height: H, padL, padR, padT, padB } = CHART;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...weeks.map((week) => week.value));
  const ticks = niceTicks(0, max, { includeZero: true, ...tickOptions });
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v) => padT + (1 - v / yMax) * innerH;
  const slot = innerW / weeks.length;
  const barW = Math.max(2, Math.min(26, slot * 0.66));
  const baseY = padT + innerH;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="${escapeHtml(ariaLabel)}">`;
  svg += yAxisSvg(ticks, y, tickOptions.tickFormat);
  svg += `<line x1="${padL}" x2="${W - padR}" y1="${baseY}" y2="${baseY}" class="axis-line"/>`;
  const labelIndexes =
    weeks.length <= 4 ? weeks.map((_, i) => i) : [0, Math.round((weeks.length - 1) / 3), Math.round(((weeks.length - 1) * 2) / 3), weeks.length - 1];
  for (const i of new Set(labelIndexes)) {
    const cx = padL + slot * (i + 0.5);
    const anchor = weeks.length > 4 && i === 0 ? "start" : weeks.length > 4 && i === weeks.length - 1 ? "end" : "middle";
    const xPos = anchor === "start" ? cx - barW / 2 : anchor === "end" ? cx + barW / 2 : cx;
    svg += `<text x="${xPos.toFixed(1)}" y="${H - 8}" class="axis-label" text-anchor="${anchor}">${formatShortDate(weeks[i].start)}</text>`;
  }
  const targets = [];
  weeks.forEach((week, i) => {
    const cx = padL + slot * (i + 0.5);
    const top = y(week.value);
    const height = Math.max(week.value > 0 ? 2 : 0, baseY - top);
    const isCurrent = i === weeks.length - 1;
    svg += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(baseY - height).toFixed(1)}" width="${barW.toFixed(1)}" height="${height.toFixed(1)}" rx="${Math.min(4, barW / 2).toFixed(1)}" class="bar${isCurrent ? " bar-current" : ""}" data-bar="${i}"/>`;
    const label = `KW ${getIsoWeekNumber(week.start)} (${formatShortDate(week.start)}–${formatShortDate(addDays(week.start, 6))}): ${format(week.value)}`;
    svg += `<rect x="${(padL + slot * i).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${innerH}" class="chart-hit" data-index="${i}" tabindex="0" role="button" aria-label="${escapeHtml(label)}"/>`;
    targets.push({ x: cx, y: baseY - height, text: label });
  });
  svg += `</svg><div class="chart-tooltip" role="status" hidden></div>`;
  container.innerHTML = svg;
  attachChartTooltip(container, targets, (index) => {
    container.querySelectorAll(".bar").forEach((bar) => bar.classList.toggle("is-selected", Number(bar.dataset.bar) === index));
  });
}

// ---------- Statistics: sections ----------

const statsView = { exercise: null, metricByType: {}, weekly: "volume" };

const statsEmpty = document.getElementById("stats-empty");
const statsContent = document.getElementById("stats-content");
const periodEmpty = document.getElementById("period-empty");
const kpiGrid = document.getElementById("kpi-grid");
const trendChips = document.getElementById("trend-exercise-chips");
const trendMetricToggle = document.getElementById("trend-metric-toggle");
const trendHeadline = document.getElementById("trend-headline");
const trendChange = document.getElementById("trend-change");
const trendChart = document.getElementById("trend-chart");
const trendEmpty = document.getElementById("trend-empty");
const weeklyHeadline = document.getElementById("weekly-headline");
const weeklyChart = document.getElementById("weekly-chart");
const weeklyEmpty = document.getElementById("weekly-empty");
const calendarEl = document.getElementById("calendar");
const calendarCaption = document.getElementById("calendar-caption");
const bestsList = document.getElementById("bests-list");
const bestsEmpty = document.getElementById("bests-empty");

function computeKpis(workouts) {
  let totalMs = 0;
  let timedCount = 0;
  let volume = 0;
  for (const workout of workouts) {
    const stats = computeWorkoutStats(workout);
    if (stats.durationMs > 0) {
      totalMs += stats.durationMs;
      timedCount += 1;
    }
    volume += stats.volume;
  }
  return { count: workouts.length, totalMs, avgMs: timedCount ? totalMs / timedCount : 0, volume };
}

function setChange(element, { delta, text, improved, neutral }) {
  const icon = delta > 0 ? ARROW_UP_ICON : delta < 0 ? ARROW_DOWN_ICON : FLAT_ICON;
  element.className = `${element.dataset.baseClass || element.className.split(" ")[0]} ${
    delta === 0 || neutral ? "is-neutral" : improved ? "is-positive" : "is-negative"
  }`;
  element.innerHTML = `${icon}<span>${escapeHtml(text)}</span>`;
}

function renderKpis(range, workouts, periodKey) {
  const current = computeKpis(workouts);
  const previous = range.prevStart !== null ? computeKpis(getWorkoutsBetween(range.prevStart, range.prevEnd)) : null;
  const volumeFormat = (v) => `${formatNumber(Math.round(v), 0)} ${UNITS.weight}`;
  const items = [
    { label: "Workouts", value: current.count, prev: previous?.count, format: (v) => String(v) },
    { label: "Gesamtzeit", value: current.totalMs, prev: previous?.totalMs, format: formatDurationLong },
    { label: "Ø Dauer", value: current.avgMs, prev: previous?.avgMs, format: formatDurationLong, neutral: true },
    { label: "Gesamtvolumen", value: current.volume, prev: previous?.volume, format: volumeFormat },
  ];
  kpiGrid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "kpi-card";
    const label = document.createElement("span");
    label.className = "kpi-label";
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "kpi-value";
    value.textContent = item.format(item.value);
    const change = document.createElement("p");
    change.className = "kpi-change";
    change.dataset.baseClass = "kpi-change";
    if (previous === null) {
      change.textContent = "gesamter Zeitraum";
      change.classList.add("is-neutral");
    } else {
      const rawDelta = item.value - item.prev;
      const delta = item.format(Math.abs(rawDelta)) === item.format(0) ? 0 : Math.sign(rawDelta);
      const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
      setChange(change, {
        delta,
        text: `${sign}${item.format(Math.abs(rawDelta))} ggü. ${PERIODS[periodKey].compareLabel}`,
        improved: delta > 0,
        neutral: item.neutral,
      });
    }
    card.append(label, value, change);
    kpiGrid.appendChild(card);
  }
}

const sumOf = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
const maxOf = (values) => {
  const valid = values.filter((value) => value !== null && Number.isFinite(value));
  return valid.length ? Math.max(...valid) : null;
};

const TREND_METRICS = {
  strength: [
    {
      label: "Geschätztes Maximum",
      value: (sets) => maxOf(sets.map((set) => estimateOneRepMax(set.weight, set.reps))),
      format: (v) => `${formatNumber(v, 1)} ${UNITS.weight}`,
      tick: (v) => formatNumber(v, 1),
    },
    {
      label: "Volumen",
      value: (sets) => sumOf(sets.map((set) => (set.weight > 0 && set.reps > 0 ? set.weight * set.reps : 0))),
      format: (v) => `${formatNumber(Math.round(v), 0)} ${UNITS.weight}`,
      tick: (v) => formatNumber(v, 0),
    },
  ],
  bodyweight: [
    {
      label: "Wiederholungen pro Training",
      value: (sets) => sumOf(sets.map((set) => set.reps)),
      format: (v) => `${formatNumber(v, 0)} Wdh.`,
      tick: (v) => formatNumber(v, 0),
      integer: true,
    },
  ],
  endurance: [
    {
      label: "Tempo",
      value: (sets) => {
        const valid = sets.filter((set) => set.distance > 0 && set.durationSec > 0);
        return valid.length ? sumOf(valid.map((set) => set.durationSec)) / sumOf(valid.map((set) => set.distance)) : null;
      },
      format: (v) => formatPace(v),
      tick: (v) => formatClock(Math.round(v) * 1000),
      time: true,
      lowerIsBetter: true,
      hint: "niedriger ist schneller",
    },
    {
      label: "Distanz",
      value: (sets) => sumOf(sets.map((set) => set.distance)),
      format: (v) => `${formatNumber(v)} ${UNITS.distance}`,
      tick: (v) => formatNumber(v, 1),
    },
  ],
  timed: [
    {
      label: "Längste Dauer",
      value: (sets) => maxOf(sets.map((set) => set.durationSec)),
      format: (v) => formatClock(v * 1000),
      tick: (v) => formatClock(v * 1000),
      time: true,
    },
  ],
};

function getTrendPoints(name, metric, workouts) {
  const points = [];
  for (const workout of workouts) {
    const sets = workout.exercises.filter((exercise) => exercise.name === name).flatMap(getRealSets);
    if (sets.length === 0) continue;
    const value = metric.value(sets);
    if (value === null || !Number.isFinite(value) || value <= 0) continue;
    points.push({ t: workout.startedAt, value });
  }
  return points;
}

function renderSegments(container, labels, activeIndex, onSelect) {
  container.innerHTML = "";
  labels.forEach((label, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(index === activeIndex));
    button.addEventListener("click", () => onSelect(index));
    container.appendChild(button);
  });
}

function renderTrend(range, workouts, periodKey) {
  const namesInPeriod = new Set(workouts.flatMap((workout) => workout.exercises.filter((e) => getRealSets(e).length).map((e) => e.name)));
  const names = getKnownExercisesByRecency().filter((name) => namesInPeriod.has(name));
  if (!names.includes(statsView.exercise)) statsView.exercise = names[0] || null;

  trendChips.innerHTML = "";
  for (const name of names) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(name === statsView.exercise));
    chip.classList.toggle("selected", name === statsView.exercise);
    chip.addEventListener("click", () => {
      statsView.exercise = name;
      renderStatistik();
    });
    trendChips.appendChild(chip);
  }

  const reset = (message) => {
    trendMetricToggle.hidden = true;
    trendHeadline.textContent = "";
    trendChange.innerHTML = "";
    trendChart.innerHTML = "";
    trendEmpty.textContent = message;
  };
  if (!statsView.exercise) {
    reset("Im gewählten Zeitraum gibt es noch keine Sätze. Trage in einem Workout Sätze ein, dann siehst du hier den Verlauf.");
    return;
  }

  const type = getExerciseType(statsView.exercise);
  const metrics = TREND_METRICS[type];
  const metricIndex = Math.min(statsView.metricByType[type] || 0, metrics.length - 1);
  const metric = metrics[metricIndex];
  trendMetricToggle.hidden = metrics.length < 2;
  renderSegments(trendMetricToggle, metrics.map((m) => m.label), metricIndex, (index) => {
    statsView.metricByType[type] = index;
    renderStatistik();
  });

  const points = getTrendPoints(statsView.exercise, metric, workouts);
  if (points.length === 0) {
    reset(`Für „${statsView.exercise}“ gibt es im Zeitraum keine Werte für ${metric.label}.`);
    trendMetricToggle.hidden = metrics.length < 2;
    return;
  }
  trendEmpty.textContent = "";
  trendHeadline.textContent = `${metric.label}${metric.hint ? ` (${metric.hint})` : ""}: aktuell ${metric.format(points[points.length - 1].value)}`;

  if (points.length < 2) {
    trendChange.className = "trend-change is-neutral";
    trendChange.textContent = "Ab zwei Trainings im Zeitraum siehst du hier den Trend.";
  } else {
    const first = points[0].value;
    const last = points[points.length - 1].value;
    const pct = ((last - first) / first) * 100;
    const delta = Math.abs(pct) < 0.5 ? 0 : Math.sign(pct);
    const improved = metric.lowerIsBetter ? delta < 0 : delta > 0;
    const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
    let text = `${sign}${formatNumber(Math.abs(pct), 0)} % ${PERIODS[periodKey].trendLabel}`;
    if (metric.lowerIsBetter && delta !== 0) text += improved ? " (schneller)" : " (langsamer)";
    if (delta === 0) text = `Unverändert ${PERIODS[periodKey].trendLabel}`;
    trendChange.dataset.baseClass = "trend-change";
    setChange(trendChange, { delta, text, improved });
  }

  const domain = PERIODS[periodKey].days ? [range.start, Date.now()] : [points[0].t, points[points.length - 1].t];
  renderLineChart(
    trendChart,
    points,
    metric,
    domain,
    `Verlauf ${statsView.exercise}, ${metric.label}: ${points.length} Trainings, zuletzt ${metric.format(points[points.length - 1].value)}`
  );
}

function getWeeklySeries(range, mode) {
  let firstWeek = startOfIsoWeek(range.start);
  const lastWeek = startOfIsoWeek(Date.now());
  const maxWeeks = 104;
  if ((lastWeek - firstWeek) / (7 * DAY_MS) >= maxWeeks) firstWeek = addDays(lastWeek, -7 * (maxWeeks - 1));
  const weeks = [];
  for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) weeks.push({ start: week, value: 0 });
  const indexByWeek = new Map(weeks.map((week, index) => [week.start, index]));
  for (const workout of getWorkoutsBetween(range.start, range.end)) {
    const index = indexByWeek.get(startOfIsoWeek(workout.startedAt));
    if (index === undefined) continue;
    const stats = computeWorkoutStats(workout);
    weeks[index].value += mode === "volume" ? stats.volume : stats.durationMs / 60000;
  }
  return weeks;
}

function formatMinutes(minutes) {
  return formatDurationLong(minutes * 60000);
}

function renderWeekly(range) {
  const mode = statsView.weekly;
  document.querySelectorAll("#weekly-toggle .segment").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.weekly === mode));
  });
  const weeks = getWeeklySeries(range, mode);
  const total = sumOf(weeks.map((week) => week.value));
  if (total <= 0) {
    weeklyChart.innerHTML = "";
    weeklyHeadline.textContent = "";
    weeklyEmpty.textContent =
      mode === "volume"
        ? "Kein Kraft-Volumen im Zeitraum. Volumen entsteht aus Gewicht × Wiederholungen bei Kraftübungen."
        : "Keine Trainingszeit im Zeitraum. Sie wird aus der Stoppuhr deiner Workouts berechnet.";
    return;
  }
  weeklyEmpty.textContent = "";
  const format = mode === "volume" ? (v) => `${formatNumber(Math.round(v), 0)} ${UNITS.weight}` : formatMinutes;
  const tickOptions =
    mode === "volume"
      ? { tickFormat: (v) => formatNumber(v, 0) }
      : { minutes: true, tickFormat: (v) => (v >= 60 ? `${formatNumber(v / 60, 1)} h` : `${v} min`) };
  weeklyHeadline.textContent = `Ø ${format(total / weeks.length)} pro Woche`;
  renderBarChart(weeklyChart, weeks, format, tickOptions, `${mode === "volume" ? "Trainingsvolumen" : "Trainingszeit"} pro Woche über ${weeks.length} Wochen`);
}

function computeStreaks() {
  const weeks = [...new Set(state.workouts.map((workout) => startOfIsoWeek(workout.startedAt)))].sort((a, b) => a - b);
  const weekSet = new Set(weeks);
  let longest = 0;
  let run = 0;
  let previous = null;
  for (const week of weeks) {
    run = previous !== null && addDays(previous, 7) === week ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = week;
  }
  const thisWeek = startOfIsoWeek(Date.now());
  let cursor = weekSet.has(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  let current = 0;
  while (weekSet.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -7);
  }
  return { current, longest, thisWeekDone: weekSet.has(thisWeek) };
}

function renderStreak() {
  const { current, longest, thisWeekDone } = computeStreaks();
  document.getElementById("streak-value").textContent = String(current);
  let sub;
  if (current === 0) sub = "Starte diese Woche eine neue Serie.";
  else if (!thisWeekDone) sub = "Trainiere diese Woche, um die Serie zu halten.";
  else sub = "Diese Woche ist schon geschafft.";
  if (longest > 0) sub += ` Längste Serie: ${longest} ${longest === 1 ? "Woche" : "Wochen"}.`;
  document.getElementById("streak-sub").textContent = sub;
}

function renderCalendar(range) {
  const today = startOfDay(Date.now());
  const capStart = startOfIsoWeek(addDays(today, -7 * 52));
  const visibleStart = Math.max(range.start, capStart);
  const gridStart = startOfIsoWeek(visibleStart);
  const workoutsPerDay = new Map();
  for (const workout of getWorkoutsBetween(visibleStart, range.end)) {
    const key = toDateStr(new Date(workout.startedAt));
    workoutsPerDay.set(key, (workoutsPerDay.get(key) || 0) + 1);
  }
  const days = [];
  for (let day = gridStart; day <= today; day = addDays(day, 1)) days.push(day);
  const weekCount = Math.ceil(days.length / 7);

  const mainWidth = document.querySelector(".app-main").clientWidth || 390;
  const available = mainWidth - 40 - 50;
  const labelWidth = 22;
  let gap = 3;
  let tile = Math.floor((available - labelWidth - gap * (weekCount - 1)) / weekCount);
  if (tile < 10) {
    gap = 2;
    tile = Math.floor((available - labelWidth - gap * (weekCount - 1)) / weekCount);
  }
  tile = Math.max(4, Math.min(30, tile));
  calendarEl.style.setProperty("--tile", `${tile}px`);
  calendarEl.style.setProperty("--gap", `${gap}px`);

  const trainedDays = days.filter((day) => day >= visibleStart && workoutsPerDay.has(toDateStr(new Date(day)))).length;
  const daysInView = days.filter((day) => day >= visibleStart).length;

  const labels = document.createElement("div");
  labels.className = "calendar-labels";
  labels.setAttribute("aria-hidden", "true");
  ["Mo", "", "Mi", "", "Fr", "", ""].forEach((text) => {
    const span = document.createElement("span");
    span.textContent = text;
    labels.appendChild(span);
  });

  const grid = document.createElement("div");
  grid.className = "calendar-grid";
  grid.setAttribute("role", "img");
  grid.setAttribute("aria-label", `${trainedDays} Trainingstage von ${daysInView} Tagen`);
  for (const day of days) {
    const cell = document.createElement("span");
    const count = workoutsPerDay.get(toDateStr(new Date(day))) || 0;
    cell.className = "cal-day";
    if (day < visibleStart) cell.classList.add("is-outside");
    else if (count > 0) cell.classList.add("is-trained");
    if (day === today) cell.classList.add("is-today");
    cell.title = `${formatLongDate(day)}: ${count ? `${count} ${count === 1 ? "Workout" : "Workouts"}` : "kein Training"}`;
    grid.appendChild(cell);
  }
  calendarEl.innerHTML = "";
  calendarEl.append(labels, grid);
  const capped = range.start < capStart;
  calendarCaption.textContent = `${trainedDays} Trainingstage von ${daysInView} Tagen${capped ? " · Kalender zeigt die letzten 12 Monate" : ""}`;
}

const BEST_DEFS = {
  strength: [
    RECORD_DEFS.strength[0],
    { label: "Meiste Wiederholungen", value: (set) => set.reps || null, format: (v) => `${v} Wdh.` },
    RECORD_DEFS.strength[1],
  ],
  bodyweight: RECORD_DEFS.bodyweight,
  endurance: RECORD_DEFS.endurance,
  timed: RECORD_DEFS.timed,
};

function findBest(name, def) {
  let best = null;
  for (const workout of state.workouts) {
    for (const exercise of workout.exercises) {
      if (exercise.name !== name) continue;
      for (const set of getRealSets(exercise)) {
        const value = def.value(set);
        if (value === null || !Number.isFinite(value)) continue;
        if (!best || (def.lowerIsBetter ? value < best.value : value > best.value)) best = { value, at: workout.startedAt };
      }
    }
  }
  return best;
}

function renderBests() {
  bestsList.innerHTML = "";
  let count = 0;
  for (const name of getKnownExercisesByRecency()) {
    const type = getExerciseType(name);
    const rows = BEST_DEFS[type].map((def) => ({ def, best: findBest(name, def) })).filter((row) => row.best);
    if (rows.length === 0) continue;
    count += 1;
    const card = document.createElement("article");
    card.className = "best-card";
    const head = document.createElement("header");
    head.className = "best-card-head";
    const title = document.createElement("h3");
    title.textContent = name;
    const typeLabel = document.createElement("span");
    typeLabel.textContent = EXERCISE_TYPES[type].label;
    head.append(title, typeLabel);
    const list = document.createElement("dl");
    list.className = "best-rows";
    for (const { def, best } of rows) {
      const term = document.createElement("dt");
      term.textContent = def.label;
      const detail = document.createElement("dd");
      const value = document.createElement("strong");
      value.textContent = def.format(best.value);
      const date = document.createElement("span");
      date.textContent = formatLongDate(best.at);
      detail.append(value, date);
      list.append(term, detail);
    }
    card.append(head, list);
    bestsList.appendChild(card);
  }
  bestsEmpty.hidden = count > 0;
}

function renderStatistik() {
  const hasData = state.workouts.length > 0;
  statsEmpty.hidden = hasData;
  statsContent.hidden = !hasData;
  const periodKey = getPeriodKey();
  document.querySelectorAll("#period-switch .segment").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.period === periodKey));
  });
  if (!hasData) return;
  const range = getPeriodRange(periodKey);
  const workouts = getWorkoutsBetween(range.start, range.end);
  periodEmpty.textContent = workouts.length
    ? ""
    : "Im gewählten Zeitraum gibt es keine Workouts. Wähle einen längeren Zeitraum oder starte ein Training.";
  renderKpis(range, workouts, periodKey);
  renderTrend(range, workouts, periodKey);
  renderWeekly(range);
  renderStreak();
  renderCalendar(range);
  renderBests();
}

document.querySelectorAll("#period-switch .segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.settings.statPeriod = button.dataset.period;
    saveState();
    renderStatistik();
  });
});
document.querySelectorAll("#weekly-toggle .segment").forEach((button) => {
  button.addEventListener("click", () => {
    statsView.weekly = button.dataset.weekly;
    renderStatistik();
  });
});
document.getElementById("stats-start-btn").addEventListener("click", () => switchTab("training"));

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderStatistik, 150);
});

// ---------- Backup: export and import ----------

const APP_ID = "fitness-tracker";
const exportBtn = document.getElementById("export-btn");
const importFile = document.getElementById("import-file");
const importError = document.getElementById("import-error");

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  return `${date.toLocaleDateString("de-DE")}, ${date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`;
}

function renderDataTab() {
  document.getElementById("backup-status").textContent = state.settings.lastExportAt
    ? `Zuletzt exportiert: ${formatDateTime(state.settings.lastExportAt)}`
    : "Noch kein Backup exportiert.";
  const counts = `${state.workouts.length} Workouts, ${Object.keys(state.exercises).length} Übungen, ${state.routines.length} Vorlagen · Datenformat Version ${state.version}`;
  document.getElementById("storage-info").textContent = storage.available
    ? `Lokaler Speicher aktiv. Gespeichert: ${counts}.`
    : `Lokaler Speicher nicht verfügbar – Daten gehen beim Schließen verloren. Aktuell: ${counts}.`;
}

function exportData() {
  const payload = { app: APP_ID, exportedAt: Date.now(), ...state };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `training-backup-${toDateStr(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  state.settings.lastExportAt = payload.exportedAt;
  saveState();
  renderDataTab();
  showToast("Backup-Datei erstellt");
}

const INVALID_BACKUP = "Die Datei ist kein gültiges Backup dieser App.";

function isValidNumberField(value) {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isValidSet(set) {
  return Boolean(set) && typeof set === "object" && ["weight", "reps", "distance", "durationSec"].every((key) => isValidNumberField(set[key]));
}

function isValidWorkout(workout) {
  return (
    Boolean(workout) &&
    typeof workout.id === "string" &&
    Number.isFinite(workout.startedAt) &&
    Array.isArray(workout.exercises) &&
    workout.exercises.every(
      (exercise) => exercise && typeof exercise.name === "string" && exercise.name.trim() && Array.isArray(exercise.sets) && exercise.sets.every(isValidSet)
    )
  );
}

function validateBackup(parsed) {
  if (Array.isArray(parsed)) {
    const valid = parsed.length > 0 && parsed.every((entry) => entry && typeof entry.exercise === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
    return valid ? { data: { version: 1, entries: parsed } } : { error: INVALID_BACKUP };
  }
  if (!parsed || typeof parsed !== "object") return { error: INVALID_BACKUP };
  if (parsed.app !== undefined && parsed.app !== APP_ID) return { error: INVALID_BACKUP };
  if (!Number.isInteger(parsed.version) || parsed.version < 1) return { error: INVALID_BACKUP };
  if (parsed.version > DATA_VERSION) {
    return { error: "Dieses Backup stammt aus einer neueren Version der App und kann hier nicht importiert werden." };
  }
  if (parsed.version === 1) return Array.isArray(parsed.entries) ? { data: parsed } : { error: INVALID_BACKUP };
  if (!Array.isArray(parsed.workouts) || !parsed.workouts.every(isValidWorkout)) {
    return { error: "Die Datei enthält ungültige Workout-Daten und wurde nicht importiert." };
  }
  const exercisesValid =
    parsed.exercises === undefined ||
    (typeof parsed.exercises === "object" &&
      !Array.isArray(parsed.exercises) &&
      Object.values(parsed.exercises).every((exercise) => exercise && EXERCISE_TYPES[exercise.type]));
  if (!exercisesValid) return { error: "Die Datei enthält ungültige Übungstypen und wurde nicht importiert." };
  const listValid = (list) =>
    list === undefined || (Array.isArray(list) && list.every((item) => item && typeof item.name === "string" && Array.isArray(item.exercises)));
  const templatesValid = listValid(parsed.templates) && listValid(parsed.routines);
  if (!templatesValid) return { error: "Die Datei enthält ungültige Vorlagen und wurde nicht importiert." };
  if (parsed.activeWorkout != null && !isValidWorkout(parsed.activeWorkout)) return { error: INVALID_BACKUP };
  return { data: parsed };
}

async function importData(file) {
  importError.textContent = "";
  if (file.size > 20 * 1024 * 1024) {
    importError.textContent = "Die Datei ist zu groß für ein Backup dieser App.";
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    importError.textContent = "Die Datei konnte nicht gelesen werden. Bitte wähle eine JSON-Backup-Datei.";
    return;
  }
  const { data, error } = validateBackup(parsed);
  if (error) {
    importError.textContent = error;
    return;
  }
  let migrated = data;
  while (migrated.version < DATA_VERSION) migrated = MIGRATIONS[migrated.version](migrated);
  const imported = withDefaults(migrated);
  const from = parsed.exportedAt ? ` vom ${formatDateTime(parsed.exportedAt)}` : "";
  const ok = await confirmDialog(
    `Backup${from} mit ${imported.workouts.length} Workouts importieren? Deine aktuellen Daten (${state.workouts.length} Workouts) werden ersetzt. Eine Sicherheitskopie bleibt im Browser gespeichert.`,
    { confirmLabel: "Importieren", danger: true }
  );
  if (!ok) return;
  storage.set(`${DATA_KEY}-vor-import-${Date.now()}`, JSON.stringify(state));
  state = imported;
  trainingView = "start";
  saveState();
  renderAll();
  syncWakeLock();
  showToast(`Backup importiert: ${imported.workouts.length} Workouts`);
}

exportBtn.addEventListener("click", exportData);
document.getElementById("import-btn").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => {
  const file = importFile.files[0];
  importFile.value = "";
  if (file) importData(file);
});

// ---------- Wake Lock ----------

const wakeLockSupported = "wakeLock" in navigator;
let wakeLockSentinel = null;
let wakeLockBusy = false;
let wakeLockFailed = false;

async function syncWakeLock() {
  if (wakeLockBusy) return;
  const shouldHold =
    Boolean(state.activeWorkout) && !state.activeWorkout.pausedAt && document.visibilityState === "visible";
  if (wakeLockSupported) {
    wakeLockBusy = true;
    try {
      if (shouldHold && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockFailed = false;
        wakeLockSentinel.addEventListener("release", () => {
          wakeLockSentinel = null;
          updateWakeLockHint();
        });
      } else if (!shouldHold && wakeLockSentinel) {
        await wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch {
      wakeLockSentinel = null;
      wakeLockFailed = true;
    } finally {
      wakeLockBusy = false;
    }
  }
  updateWakeLockHint();
}

function updateWakeLockHint() {
  const workout = state.activeWorkout;
  let text = "";
  if (workout && !workout.pausedAt) {
    if (wakeLockSentinel) text = "Der Bildschirm bleibt während des Workouts an.";
    else if (!wakeLockSupported || wakeLockFailed)
      text = "Dein Browser kann den Bildschirm nicht wachhalten. Verlängere bei Bedarf die automatische Sperre in den Handy-Einstellungen.";
  }
  wakeLockHint.textContent = text;
}

// ---------- Navigation and rendering ----------

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  document.querySelectorAll(".tab-content").forEach((section) => {
    section.classList.toggle("active", section.id === tab);
  });
  renderTraining();
  window.scrollTo(0, 0);
}

function renderAll() {
  renderTraining();
  renderHistory();
  if (detailDialog.open) renderDetail();
  renderStatistik();
  renderDataTab();
}

function tick() {
  updateTimers();
  updateRestTimer();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("open-workout-btn").addEventListener("click", () => {
  trainingView = "workout";
  renderTraining();
  syncWakeLock();
  window.scrollTo(0, 0);
});
document.getElementById("minimize-workout-btn").addEventListener("click", () => {
  trainingView = "start";
  renderTraining();
});
pauseBtn.addEventListener("click", togglePause);
document.getElementById("finish-workout-btn").addEventListener("click", finishWorkout);
document.getElementById("discard-workout-btn").addEventListener("click", discardWorkout);

document.addEventListener("visibilitychange", () => {
  tick();
  syncWakeLock();
});

window.addEventListener("storage", (event) => {
  if (event.key !== DATA_KEY) return;
  state = loadState();
  renderAll();
});

if (state.activeWorkout?.restEndsAt && state.activeWorkout.restEndsAt < Date.now()) {
  state.activeWorkout.restEndsAt = null;
}
setInterval(tick, 250);
renderAll();
syncWakeLock();

const canUseServiceWorker =
  "serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname));
if (canUseServiceWorker) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
