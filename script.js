const STORAGE_KEY = "fitness-tracker-entries";

const form = document.getElementById("entry-form");
const dateInput = document.getElementById("date");
const feedback = document.getElementById("save-feedback");
const entryList = document.getElementById("entry-list");
const emptyList = document.getElementById("empty-list");
const weeklyOverview = document.getElementById("weekly-overview");
const emptyOverview = document.getElementById("empty-overview");

const chipRow = document.getElementById("exercise-chips");
const newExerciseInput = document.getElementById("new-exercise-input");
const lastEntryInfo = document.getElementById("last-entry-info");
const repsInput = document.getElementById("reps");
const repsMinus = document.getElementById("reps-minus");
const repsPlus = document.getElementById("reps-plus");
const distanceInput = document.getElementById("distance");
const durationInput = document.getElementById("duration");

let selectedExercise = null;
let isNewExerciseMode = false;

resetDateToToday();

function resetDateToToday() {
  dateInput.valueAsDate = new Date();
}

function loadEntries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

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

function renderChips() {
  const entries = loadEntries();
  const recents = getExerciseRecency(entries);

  chipRow.innerHTML = "";

  for (const entry of recents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    if (entry.exercise === selectedExercise && !isNewExerciseMode) {
      chip.classList.add("selected");
    }
    chip.textContent = entry.exercise;
    chip.addEventListener("click", () => selectExercise(entry.exercise, recents));
    chipRow.appendChild(chip);
  }

  const newChip = document.createElement("button");
  newChip.type = "button";
  newChip.className = "chip chip-new";
  if (isNewExerciseMode) newChip.classList.add("selected");
  newChip.textContent = "+ Neue Übung";
  newChip.addEventListener("click", selectNewExercise);
  chipRow.appendChild(newChip);

  return recents;
}

function updateLastEntryInfo(entry) {
  if (!entry) {
    lastEntryInfo.textContent = "";
    return;
  }
  const dateStr = new Date(entry.date + "T00:00:00").toLocaleDateString("de-DE");
  lastEntryInfo.textContent = `Zuletzt: ${formatEntryDetails(entry)} · ${dateStr}`;
}

function selectExercise(name, recents) {
  selectedExercise = name;
  isNewExerciseMode = false;
  newExerciseInput.classList.add("hidden");
  newExerciseInput.value = "";

  const last = recents.find((entry) => entry.exercise === name);
  repsInput.value = last?.reps ?? 0;
  distanceInput.value = last?.distance ?? "";
  durationInput.value = last?.duration ?? "";
  updateLastEntryInfo(last);

  renderChips();
}

function selectNewExercise() {
  selectedExercise = null;
  isNewExerciseMode = true;
  newExerciseInput.classList.remove("hidden");
  newExerciseInput.value = "";
  newExerciseInput.focus();

  repsInput.value = 0;
  distanceInput.value = "";
  durationInput.value = "";
  updateLastEntryInfo(null);

  renderChips();
}

repsMinus.addEventListener("click", () => {
  repsInput.value = Math.max(0, Number(repsInput.value || 0) - 1);
});

repsPlus.addEventListener("click", () => {
  repsInput.value = Number(repsInput.value || 0) + 1;
});

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
    deleteBtn.addEventListener("click", () => deleteEntry(entry.id));

    li.append(main, deleteBtn);
    entryList.appendChild(li);
  }
}

function deleteEntry(id) {
  const entries = loadEntries().filter((entry) => entry.id !== id);
  saveEntries(entries);
  renderList();
  renderWeeklyOverview();
  renderChips();
}

function renderWeeklyOverview() {
  const entries = loadEntries();
  weeklyOverview.innerHTML = "";

  const totalsByWeek = {};
  for (const entry of entries) {
    const weekKey = getIsoWeekKey(entry.date);
    if (!totalsByWeek[weekKey]) {
      totalsByWeek[weekKey] = { reps: 0, distance: 0, duration: 0 };
    }
    if (entry.reps) totalsByWeek[weekKey].reps += Number(entry.reps);
    if (entry.distance) totalsByWeek[weekKey].distance += Number(entry.distance);
    if (entry.duration) totalsByWeek[weekKey].duration += Number(entry.duration);
  }

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

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const exerciseName = isNewExerciseMode
    ? normalizeExerciseName(newExerciseInput.value)
    : selectedExercise;
  const date = dateInput.value;

  if (!exerciseName || !date) return;

  const reps = Number(repsInput.value) || 0;
  const distance = distanceInput.value ? Number(distanceInput.value) : null;
  const duration = durationInput.value ? Number(durationInput.value) : null;

  const entries = loadEntries();
  const newEntry = {
    id: Date.now(),
    exercise: exerciseName,
    reps: reps > 0 ? reps : null,
    distance,
    duration,
    date,
  };
  entries.push(newEntry);
  saveEntries(entries);

  selectedExercise = exerciseName;
  isNewExerciseMode = false;
  newExerciseInput.classList.add("hidden");
  resetDateToToday();

  feedback.textContent = "Eintrag gespeichert";
  setTimeout(() => (feedback.textContent = ""), 2000);

  renderChips();
  updateLastEntryInfo(newEntry);
  renderList();
  renderWeeklyOverview();
});

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

function init() {
  const recents = renderChips();
  if (recents.length > 0) {
    selectExercise(recents[0].exercise, recents);
  } else {
    selectNewExercise();
  }
  renderList();
  renderWeeklyOverview();
}

init();
