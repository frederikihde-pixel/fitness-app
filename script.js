const DATA_KEY = "fitness-tracker-data";
const LEGACY_KEY = "fitness-tracker-entries";
const DATA_VERSION = 2;

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
    templates: [],
    activeWorkout: null,
    settings: { restSeconds: 90 },
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
  const next = emptyState();
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
  while (data.version < DATA_VERSION) {
    data = MIGRATIONS[data.version](data);
  }

  const loaded = { ...emptyState(), ...data, settings: { ...emptyState().settings, ...data.settings } };
  if (startVersion !== loaded.version) {
    state = loaded;
    saveState();
  }
  return loaded;
}

function saveState() {
  if (!storage.available) return false;
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

function workoutDateStr(workout) {
  return toDateStr(new Date(workout.startedAt));
}

function getExerciseType(name) {
  return state.exercises[name]?.type || "bodyweight";
}

// Flattens workouts into one entry per exercise per workout for the weekly overview and statistics.
function loadEntries() {
  const entries = [];
  for (const workout of state.workouts) {
    const date = workoutDateStr(workout);
    workout.exercises.forEach((exercise, index) => {
      const sets = exercise.sets.filter((set) => !set.planned);
      if (sets.length === 0) return;
      const sum = (key) => sets.reduce((total, set) => total + (Number(set[key]) || 0), 0);
      const durationSec = sum("durationSec");
      entries.push({
        id: workout.startedAt + index,
        workoutId: workout.id,
        exercise: exercise.name,
        reps: sum("reps") || null,
        distance: roundTo(sum("distance"), 2) || null,
        duration: durationSec ? roundTo(durationSec / 60, 1) : null,
        date,
      });
    });
  }
  return entries;
}

const entryList = document.getElementById("entry-list");
const emptyList = document.getElementById("empty-list");
const weeklyOverview = document.getElementById("weekly-overview");
const emptyOverview = document.getElementById("empty-overview");

const statChipRow = document.getElementById("stat-chips");
const chartContainer = document.getElementById("trend-chart-container");
const chartEmpty = document.getElementById("chart-empty");
const bestList = document.getElementById("best-list");
const emptyBests = document.getElementById("empty-bests");
const weekCompare = document.getElementById("week-compare");

let selectedStatExercise = null;

function normalizeExerciseName(name) {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getIsoWeekKey(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  const target = new Date(date.valueOf());
  const dayNr = (date.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const weekNumber = 1 + Math.round((target - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${target.getFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
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

function formatShortDate(dateStr) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function computeWeeklyTotals(entries) {
  const totals = {};
  const workoutsPerWeek = {};
  for (const entry of entries) {
    const weekKey = getIsoWeekKey(entry.date);
    if (!totals[weekKey]) {
      totals[weekKey] = { count: 0, reps: 0, distance: 0, duration: 0 };
      workoutsPerWeek[weekKey] = new Set();
    }
    workoutsPerWeek[weekKey].add(entry.workoutId);
    totals[weekKey].count = workoutsPerWeek[weekKey].size;
    if (entry.reps) totals[weekKey].reps += Number(entry.reps);
    if (entry.distance) totals[weekKey].distance += Number(entry.distance);
    if (entry.duration) totals[weekKey].duration += Number(entry.duration);
  }
  return totals;
}

function formatEntryDetails(entry) {
  const parts = [];
  if (entry.reps) parts.push(`${entry.reps} Wdh.`);
  if (entry.distance) parts.push(`${entry.distance} km`);
  if (entry.duration) parts.push(`${entry.duration} min`);
  return parts.join(" · ") || "Keine weiteren Angaben";
}

// Returns the most recent entry per exercise, sorted by most recently used first.
function getExerciseRecency(entries) {
  const latestByExercise = new Map();
  for (const entry of entries) {
    const current = latestByExercise.get(entry.exercise);
    if (!current || entry.date > current.date || (entry.date === current.date && entry.id > current.id)) {
      latestByExercise.set(entry.exercise, entry);
    }
  }
  return [...latestByExercise.values()].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

function renderList() {
  const entries = loadEntries();
  entryList.innerHTML = "";

  if (entries.length === 0) {
    emptyList.style.display = "block";
    return;
  }
  emptyList.style.display = "none";

  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  for (const entry of sorted) {
    const li = document.createElement("li");

    const main = document.createElement("div");
    main.className = "entry-main";

    const exerciseEl = document.createElement("span");
    exerciseEl.className = "entry-exercise";
    exerciseEl.textContent = entry.exercise;

    const detailsEl = document.createElement("span");
    detailsEl.className = "entry-details";
    detailsEl.textContent = formatEntryDetails(entry);

    const dateEl = document.createElement("span");
    dateEl.className = "entry-date";
    dateEl.textContent = new Date(entry.date + "T00:00:00").toLocaleDateString("de-DE");

    main.append(exerciseEl, detailsEl, dateEl);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.setAttribute("aria-label", "Eintrag löschen");
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12"/></svg>';
    deleteBtn.addEventListener("click", () => deleteWorkout(entry.workoutId));

    li.append(main, deleteBtn);
    entryList.appendChild(li);
  }
}

function deleteWorkout(workoutId) {
  state.workouts = state.workouts.filter((workout) => workout.id !== workoutId);
  saveState();
  renderList();
  renderWeeklyOverview();
  renderStatistik();
}

function renderWeeklyOverview() {
  const entries = loadEntries();
  weeklyOverview.innerHTML = "";

  const totalsByWeek = computeWeeklyTotals(entries);

  const weekKeys = Object.keys(totalsByWeek).sort().reverse();

  if (weekKeys.length === 0) {
    emptyOverview.style.display = "block";
    return;
  }
  emptyOverview.style.display = "none";

  for (const weekKey of weekKeys) {
    const totals = totalsByWeek[weekKey];
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.className = "week-label";
    label.textContent = weekKey.replace("-W", " · KW ");

    const stats = document.createElement("div");
    stats.className = "week-stats";

    const statParts = [
      { value: totals.reps, text: `${totals.reps} Wdh.` },
      { value: totals.distance, text: `${roundTo(totals.distance, 2)} km` },
      { value: totals.duration, text: `${roundTo(totals.duration, 0)} min` },
    ].filter((part) => part.value > 0);

    if (statParts.length === 0) {
      statParts.push({ text: "0 Wdh." });
    }

    for (const part of statParts) {
      const statEl = document.createElement("span");
      statEl.className = "week-total";
      statEl.textContent = part.text;
      stats.appendChild(statEl);
    }

    li.append(label, stats);
    weeklyOverview.appendChild(li);
  }
}

const METRIC_LABELS = {
  reps: { unit: "Wdh.", bestLabel: "Beste Wiederholungen" },
  distance: { unit: "km", bestLabel: "Längste Distanz" },
  duration: { unit: "min", bestLabel: "Längste Zeit" },
};

function getExerciseMetricKey(entries, exerciseName) {
  const counts = { reps: 0, distance: 0, duration: 0 };
  for (const entry of entries) {
    if (entry.exercise !== exerciseName) continue;
    if (entry.reps) counts.reps += 1;
    if (entry.distance) counts.distance += 1;
    if (entry.duration) counts.duration += 1;
  }
  if (counts.reps > 0 && counts.reps >= counts.distance && counts.reps >= counts.duration) return "reps";
  if (counts.distance > 0 && counts.distance >= counts.duration) return "distance";
  if (counts.duration > 0) return "duration";
  return null;
}

function renderStatChips(recents) {
  statChipRow.innerHTML = "";
  for (const entry of recents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (entry.exercise === selectedStatExercise) chip.classList.add("selected");
    chip.textContent = entry.exercise;
    chip.addEventListener("click", () => {
      selectedStatExercise = entry.exercise;
      renderStatistik();
    });
    statChipRow.appendChild(chip);
  }
}

function buildTrendChartSvg(points, unit) {
  const width = 320;
  const height = 150;
  const padX = 16;
  const padTop = 24;
  const padBottom = 26;

  const dates = points.map((p) => new Date(p.date + "T00:00:00").getTime());
  const values = points.map((p) => p.value);
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const dateSpan = maxDate - minDate || 1;
  const valSpan = maxVal - minVal || 1;

  const xFor = (d) => (points.length === 1 ? width / 2 : padX + ((d - minDate) / dateSpan) * (width - padX * 2));
  const yFor = (v) => height - padBottom - ((v - minVal) / valSpan) * (height - padTop - padBottom);

  const coords = points.map((p, i) => ({
    x: xFor(dates[i]),
    y: points.length === 1 ? height / 2 : yFor(p.value),
    value: p.value,
    date: p.date,
  }));

  const linePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");

  const dots = coords
    .map((c, i) => {
      const isLast = i === coords.length - 1;
      const r = isLast ? 4.5 : 3;
      const cls = isLast ? "chart-dot chart-dot-current" : "chart-dot";
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${r}" class="${cls}" />`;
    })
    .join("");

  const last = coords[coords.length - 1];
  const first = coords[0];
  const labelAnchor = last.x > width - 40 ? "end" : "middle";
  const labelY = Math.max(12, last.y - 10).toFixed(1);

  const lineOrDot = points.length > 1 ? `<polyline points="${linePoints}" class="chart-line" />` : "";

  return `
    <svg viewBox="0 0 ${width} ${height}" class="trend-svg">
      ${lineOrDot}
      ${dots}
      <text x="${last.x.toFixed(1)}" y="${labelY}" text-anchor="${labelAnchor}" class="chart-value-label">${last.value} ${unit}</text>
      <text x="${padX}" y="${height - 6}" class="chart-date-label">${formatShortDate(first.date)}</text>
      <text x="${width - padX}" y="${height - 6}" text-anchor="end" class="chart-date-label">${formatShortDate(last.date)}</text>
    </svg>
  `;
}

function renderTrendChart(entries, exerciseName) {
  const metricKey = exerciseName ? getExerciseMetricKey(entries, exerciseName) : null;
  const points = metricKey
    ? entries
        .filter((entry) => entry.exercise === exerciseName && entry[metricKey])
        .map((entry) => ({ date: entry.date, value: Number(entry[metricKey]) }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-20)
    : [];

  if (points.length === 0) {
    chartContainer.innerHTML = "";
    chartEmpty.style.display = "block";
    return;
  }
  chartEmpty.style.display = "none";
  chartContainer.innerHTML = buildTrendChartSvg(points, METRIC_LABELS[metricKey].unit);
}

function renderPersonalBests(entries, exerciseName) {
  bestList.innerHTML = "";
  const relevant = entries.filter((entry) => entry.exercise === exerciseName);

  const bests = [];
  for (const key of ["reps", "distance", "duration"]) {
    const best = relevant
      .filter((entry) => entry[key])
      .sort((a, b) => b[key] - a[key] || b.date.localeCompare(a.date))[0];
    if (best) {
      bests.push({
        label: METRIC_LABELS[key].bestLabel,
        value: `${best[key]} ${METRIC_LABELS[key].unit}`,
        date: best.date,
      });
    }
  }

  if (bests.length === 0) {
    emptyBests.style.display = "block";
    return;
  }
  emptyBests.style.display = "none";

  for (const best of bests) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.className = "best-label";
    label.textContent = best.label;

    const stats = document.createElement("div");
    stats.className = "best-stats";

    const valueEl = document.createElement("span");
    valueEl.className = "best-value";
    valueEl.textContent = best.value;

    const dateEl = document.createElement("span");
    dateEl.className = "best-date";
    dateEl.textContent = new Date(best.date + "T00:00:00").toLocaleDateString("de-DE");

    stats.append(valueEl, dateEl);
    li.append(label, stats);
    bestList.appendChild(li);
  }
}

function renderWeekComparison(entries) {
  const totals = computeWeeklyTotals(entries);

  const today = new Date();
  const currentWeekKey = getIsoWeekKey(toDateStr(today));
  const previousDate = new Date(today);
  previousDate.setDate(today.getDate() - 7);
  const previousWeekKey = getIsoWeekKey(toDateStr(previousDate));

  const empty = { count: 0, reps: 0, distance: 0, duration: 0 };
  const current = totals[currentWeekKey] || empty;
  const previous = totals[previousWeekKey] || empty;

  const rows = [
    { label: "Einheiten", unit: "", decimals: 0, current: current.count, previous: previous.count, always: true },
    { label: "Wiederholungen", unit: "Wdh.", decimals: 0, current: current.reps, previous: previous.reps },
    { label: "Distanz", unit: "km", decimals: 2, current: current.distance, previous: previous.distance },
    { label: "Zeit", unit: "min", decimals: 0, current: current.duration, previous: previous.duration },
  ].filter((row) => row.always || row.current > 0 || row.previous > 0);

  weekCompare.innerHTML = "";

  for (const row of rows) {
    const delta = roundTo(row.current - row.previous, row.decimals);
    const currentValue = roundTo(row.current, row.decimals);

    const rowEl = document.createElement("div");
    rowEl.className = "compare-row";

    const label = document.createElement("span");
    label.className = "compare-label";
    label.textContent = row.label;

    const values = document.createElement("div");
    values.className = "compare-values";

    const currentEl = document.createElement("span");
    currentEl.className = "compare-current";
    currentEl.textContent = row.unit ? `${currentValue} ${row.unit}` : `${currentValue}`;

    const deltaEl = document.createElement("span");
    const direction = delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral";
    deltaEl.className = `compare-delta ${direction}`;
    const sign = delta > 0 ? "+" : "";
    deltaEl.textContent = `${sign}${delta}${row.unit ? " " + row.unit : ""} ggü. Vorwoche`;

    values.append(currentEl, deltaEl);
    rowEl.append(label, values);
    weekCompare.appendChild(rowEl);
  }
}

function renderStatistik() {
  const entries = loadEntries();
  const recents = getExerciseRecency(entries);

  if (recents.length === 0) {
    selectedStatExercise = null;
  } else if (!selectedStatExercise || !recents.some((entry) => entry.exercise === selectedStatExercise)) {
    selectedStatExercise = recents[0].exercise;
  }

  renderStatChips(recents);
  renderTrendChart(entries, selectedStatExercise);
  renderPersonalBests(entries, selectedStatExercise);
  renderWeekComparison(entries);
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

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2600);
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
const startCard = document.getElementById("start-card");
const workoutNameInput = document.getElementById("workout-name-input");
const workoutTitle = document.getElementById("workout-title");
const workoutTimer = document.getElementById("workout-timer");
const workoutStatus = document.getElementById("workout-status");
const pauseBtn = document.getElementById("pause-btn");
const wakeLockHint = document.getElementById("wakelock-hint");

let currentTab = "training";
let workoutViewOpen = false;

// Elapsed time is derived from timestamps, so it stays correct across reloads, locked screens and background tabs.
function getElapsedMs(workout, now = Date.now()) {
  const end = workout.endedAt ?? workout.pausedAt ?? now;
  return Math.max(0, end - workout.startedAt - (workout.pausedMs || 0));
}

function startWorkout() {
  const now = Date.now();
  const name = workoutNameInput.value.trim();
  state.activeWorkout = {
    id: createId("w"),
    name: name || formatWorkoutDefaultName(now),
    startedAt: now,
    pausedAt: null,
    pausedMs: 0,
    exercises: [],
    restEndsAt: null,
    restTotalSec: null,
  };
  workoutNameInput.value = "";
  saveState();
  workoutViewOpen = true;
  renderTraining();
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
  finalizeActiveWorkout();
  workoutViewOpen = false;
  renderAll();
  syncWakeLock();
  showToast("Workout gespeichert");
}

async function discardWorkout() {
  const ok = await confirmDialog("Workout verwerfen? Alle Eingaben dieses Workouts gehen verloren.", {
    confirmLabel: "Verwerfen",
    danger: true,
  });
  if (!ok || !state.activeWorkout) return;
  state.activeWorkout = null;
  saveState();
  workoutViewOpen = false;
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
  const showWorkout = Boolean(workout) && workoutViewOpen;
  startScreen.hidden = showWorkout;
  workoutScreen.hidden = !showWorkout;
  document.body.classList.toggle("in-workout", showWorkout && currentTab === "training");
  activeCard.hidden = !workout;
  startCard.hidden = Boolean(workout);

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
}

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
  renderList();
  renderWeeklyOverview();
  renderStatistik();
}

function tick() {
  updateTimers();
}

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

document.getElementById("start-workout-btn").addEventListener("click", startWorkout);
document.getElementById("open-workout-btn").addEventListener("click", () => {
  workoutViewOpen = true;
  renderTraining();
  syncWakeLock();
  window.scrollTo(0, 0);
});
document.getElementById("minimize-workout-btn").addEventListener("click", () => {
  workoutViewOpen = false;
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

setInterval(tick, 500);
renderAll();
syncWakeLock();
