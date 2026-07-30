(function () {
  "use strict";

  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  const MILESTONE_STORAGE_KEY = "contract-milestones-v1";
  const SHIFT_STORAGE_KEY = "contract-shifts-v1";
  const SETTINGS_STORAGE_KEY = "contract-tracker-settings-v2";
  const PAYROLL_STORAGE_KEY = "contract-payroll-settings-v1";
  const OPEN_STARTS = new Set(["06:35", "07:50"]);
  const CLOSE_ENDS = new Set(["22:40", "23:25"]);

  const DEFAULT_SETTINGS = {
    name: "Cap Contrat",
    start: "2026-05-14",
    end: "2026-11-01",
    restDays: [3, 4]
  };

  const COLORS = {
    gold: "#ffd15c", acid: "#d7ff4f", cyan: "#55d9e8", coral: "#ff735d", blue: "#6fa8ff",
    green: "#67dd8e", violet: "#b48cff", pink: "#ff87c8", orange: "#ff9f43", white: "#f6f3eb"
  };

  const LEVEL_NAMES = [
    "Premier pas", "En route", "Rythme trouvé", "Cap maintenu", "Mi-parcours",
    "Endurance", "Dernière ligne", "Presque là", "Sprint final", "Mission accomplie"
  ];
  const WEEKDAY_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const MONTH_HEAD = ["L", "M", "M", "J", "V", "S", "D"];
  const longDate = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
  const monthOnly = new Intl.DateTimeFormat("fr-FR", { month: "long" });
  const monthYear = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
  const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const state = {
    activeView: "home",
    calendarFilter: "all",
    planningFilter: "all",
    hoursPeriod: "all",
    trophyFilter: "next",
    settings: loadSettings(),
    milestones: loadMilestones(),
    shifts: loadShifts(),
    payrollSettings: loadPayrollSettings(),
    dayPauseDraft: [],
    dayPauseLastStart: "",
    dayPauseLastEnd: "",
    dayPauseRequiresReset: false,
    dayPauseWarning: "",
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);

  function safeJsonParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (error) { return fallback; }
  }

  function loadSettings() {
    const saved = safeJsonParse(localStorage.getItem(SETTINGS_STORAGE_KEY), {});
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  }

  function normalizeSettings(value) {
    const start = isDateKey(value.start) ? value.start : DEFAULT_SETTINGS.start;
    const end = isDateKey(value.end) && value.end >= start ? value.end : DEFAULT_SETTINGS.end;
    const restDays = Array.isArray(value.restDays)
      ? [...new Set(value.restDays.map(Number).filter((day) => day >= 0 && day <= 6))]
      : [...DEFAULT_SETTINGS.restDays];
    return {
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 32) : DEFAULT_SETTINGS.name,
      start,
      end,
      restDays: restDays.length < 7 ? restDays : [...DEFAULT_SETTINGS.restDays]
    };
  }

  function loadMilestones() {
    return normalizeMilestones(safeJsonParse(localStorage.getItem(MILESTONE_STORAGE_KEY), []));
  }

  function normalizeMilestones(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item.name === "string" && isDateKey(item.date))
      .map((item, index) => ({
        id: String(item.id || `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`),
        name: item.name.trim().slice(0, 42), date: item.date, color: normalizeColor(item.color), important: Boolean(item.important)
      }))
      .filter((item) => item.name);
  }

  function normalizeColor(color) {
    if (COLORS[color]) return color;
    const byHex = Object.entries(COLORS).find((entry) => entry[1].toLowerCase() === String(color).toLowerCase());
    return byHex ? byHex[0] : "gold";
  }

  function loadShifts() {
    return normalizeShifts(safeJsonParse(localStorage.getItem(SHIFT_STORAGE_KEY), {}));
  }

  function normalizeShifts(source) {
    const raw = source && source.shifts ? source.shifts : source;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const normalized = {};
    Object.entries(raw).forEach(([date, value]) => {
      if (!isDateKey(date) || !value || typeof value !== "object") return;
      const plan = {
        worked: Boolean(value.worked),
        start: isTime(value.start) ? value.start : "",
        end: isTime(value.end) ? value.end : "",
        actualStart: isTime(value.actualStart) ? value.actualStart : "",
        actualEnd: isTime(value.actualEnd) ? value.actualEnd : "",
        breakMinutes: normalizeOptionalMinutes(value.breakMinutes),
        nightBreakMinutes: Math.max(0, Math.round(Number(value.nightBreakMinutes) || 0)),
        attraction: value.attraction === "HSM" || value.attraction === "STT" ? value.attraction : "",
        provisional: Boolean(value.provisional),
        note: typeof value.note === "string" ? value.note.trim().slice(0, 100) : ""
      };
      const pauseData = normalizeShiftPauseData(date, plan, value.pauses);
      normalized[date] = {
        ...plan,
        pauses: pauseData.pauses,
        pauseRuleCode: pauseData.pauseRuleCode,
        pauseValidation: pauseData.validationStatus
      };
    });
    return normalized;
  }

  function normalizeOptionalMinutes(value) {
    if (value === "" || value === null || typeof value === "undefined") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
  }

  function emptyPauseData() {
    return {
      pauses: [],
      pauseRuleCode: "",
      validationStatus: { valid: true, longestContinuousWorkMinutes: 0, problemPeriod: null, message: "Aucun horaire à valider." }
    };
  }

  function normalizeShiftPauseData(dateKey, plan, storedPauses) {
    if (!plan.worked || !isTime(plan.start) || !isTime(plan.end) || !shiftDurationMinutes(plan)) return emptyPauseData();
    const shift = { id: dateKey, dateKey, start: plan.start, end: plan.end };
    const automatic = CapBreaks.recalculateShiftPauses(shift);
    if (!Array.isArray(storedPauses)) return automatic;
    const pauses = CapBreaks.normalizePauses(storedPauses, shift);
    const validationStatus = CapBreaks.validateContinuousWorkLimit(shift, pauses);
    if (!validationStatus.valid && !pauses.some((pause) => pause.source === "manual" || pause.locked)) return automatic;
    return {
      pauses,
      pauseRuleCode: CapBreaks.getPauseRuleForAmplitude(automatic.amplitudeMinutes),
      validationStatus
    };
  }

  function loadPayrollSettings() {
    const saved = safeJsonParse(localStorage.getItem(PAYROLL_STORAGE_KEY), {});
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved)
      .filter(([monthKey]) => /^\d{4}-\d{2}$/.test(monthKey))
      .map(([monthKey, value]) => [monthKey, normalizePayrollSettings(monthKey, value)]));
  }

  function normalizePayrollSettings(monthKey, value = {}) {
    const fallback = CapPayroll.defaultVariablePeriod(monthKey) || { start: `${monthKey}-01`, end: `${monthKey}-01` };
    const variableStart = isDateKey(value.variableStart) ? value.variableStart : fallback.start;
    const variableEnd = isDateKey(value.variableEnd) && value.variableEnd >= variableStart ? value.variableEnd : fallback.end;
    return {
      variableStart,
      variableEnd,
      otherOrdinary: Math.max(0, Number(value.otherOrdinary) || 0),
      recall: Math.max(0, Number(value.recall) || 0),
      officialHs25Minutes: normalizeOptionalMinutes(value.officialHs25Minutes),
      officialHs50Minutes: normalizeOptionalMinutes(value.officialHs50Minutes),
      withholdingRate: clamp(Number(value.withholdingRate) || 0, 0, 1)
    };
  }

  function saveSettings() { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings)); }
  function saveMilestones() { localStorage.setItem(MILESTONE_STORAGE_KEY, JSON.stringify(state.milestones)); }
  function saveShifts() { localStorage.setItem(SHIFT_STORAGE_KEY, JSON.stringify(state.shifts)); }
  function savePayrollSettings() { localStorage.setItem(PAYROLL_STORAGE_KEY, JSON.stringify(state.payrollSettings)); }

  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = parseDateKey(value);
    return !Number.isNaN(parsed.getTime()) && toDateKey(parsed) === value;
  }

  function isTime(value) { return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }

  function parseDateKey(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function toDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function calendarNumber(date) { return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS; }
  function dayDifference(from, to) { return Math.round(calendarNumber(to) - calendarNumber(from)); }
  function addDays(date, amount) { const result = new Date(date); result.setDate(result.getDate() + amount); return result; }
  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function isSameDay(a, b) { return toDateKey(a) === toDateKey(b); }
  function isBaseWorkDay(date) { return !state.settings.restDays.includes(date.getDay()); }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char]));
  }

  function getDayPlan(date) {
    const key = typeof date === "string" ? date : toDateKey(date);
    const override = state.shifts[key];
    if (override) return { ...override, custom: true };
    return {
      worked: isBaseWorkDay(parseDateKey(key)), start: "", end: "", actualStart: "", actualEnd: "",
      breakMinutes: null, nightBreakMinutes: 0, pauses: [], pauseRuleCode: "", pauseValidation: emptyPauseData().validationStatus,
      attraction: "", provisional: false, note: "", custom: false
    };
  }

  function isPlannedWorkDay(date) { return getDayPlan(date).worked; }

  function shiftDurationMinutes(plan) {
    if (!plan.worked || !isTime(plan.start) || !isTime(plan.end)) return 0;
    return CapBreaks.calculateShiftAmplitude(plan.start, plan.end) || 0;
  }

  function formatDuration(minutes) {
    if (!minutes) return "--";
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
  }

  function formatHours(minutes) {
    return minutes ? formatDuration(minutes) : "0 h";
  }

  function formatMoney(value) { return euro.format(Number(value) || 0); }

  function getShiftRoles(plan) {
    if (!plan || !plan.worked) return [];
    const roles = [];
    if (OPEN_STARTS.has(plan.start)) roles.push("OPEN");
    if (CLOSE_ENDS.has(plan.end)) roles.push("CLOSE");
    return roles;
  }

  function getShiftRoleLabel(plan) {
    const roles = getShiftRoles(plan);
    return roles.length ? roles.join(" + ") : "STANDARD";
  }

  function getMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function getShiftRecord(date) {
    const plan = getDayPlan(date);
    const amplitudeMinutes = shiftDurationMinutes(plan);
    const pauseMinutes = CapBreaks.calculateTotalPauseMinutes(plan.pauses);
    const minutes = amplitudeMinutes ? Math.max(0, amplitudeMinutes - pauseMinutes) : 0;
    const roles = getShiftRoles(plan);
    const dateKey = toDateKey(date);
    const payroll = CapPayroll.buildPayrollDay({ dateKey, plan });
    return {
      date: new Date(date),
      dateKey,
      monthKey: getMonthKey(date),
      plan,
      minutes,
      amplitudeMinutes,
      pauseMinutes,
      payroll,
      roles,
      timed: amplitudeMinutes > 0,
      complete: Boolean(plan.worked && amplitudeMinutes > 0 && plan.attraction)
    };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function getLongestWorkStreak(workDays) {
    if (!workDays.length) return { count: 0, start: null, end: null };
    const sorted = [...workDays].sort((a, b) => a - b);
    let best = { count: 1, start: sorted[0], end: sorted[0] };
    let current = { count: 1, start: sorted[0], end: sorted[0] };
    for (let index = 1; index < sorted.length; index += 1) {
      if (dayDifference(sorted[index - 1], sorted[index]) === 1) {
        current = { ...current, count: current.count + 1, end: sorted[index] };
      } else {
        current = { count: 1, start: sorted[index], end: sorted[index] };
      }
      if (current.count > best.count) best = { ...current };
    }
    return best;
  }

  function getPlanningStats(workDays) {
    const records = workDays.map(getShiftRecord);
    const timedRecords = records.filter((record) => record.timed);
    const minutes = timedRecords.reduce((sum, record) => sum + record.minutes, 0);
    const confirmedMinutes = timedRecords.filter((record) => !record.plan.provisional).reduce((sum, record) => sum + record.minutes, 0);
    const provisionalMinutes = timedRecords.filter((record) => record.plan.provisional).reduce((sum, record) => sum + record.minutes, 0);
    const complete = records.filter((record) => record.complete).length;
    const hsm = records.filter((record) => record.plan.attraction === "HSM").length;
    const stt = records.filter((record) => record.plan.attraction === "STT").length;
    const provisional = records.filter((record) => record.plan.provisional).length;
    const open = timedRecords.filter((record) => record.roles.includes("OPEN")).length;
    const close = timedRecords.filter((record) => record.roles.includes("CLOSE")).length;
    return {
      records, timedRecords, minutes, hours: minutes / 60, confirmedMinutes, provisionalMinutes,
      complete, timed: timedRecords.length, provisional, hsm, stt, open, close,
      fill: workDays.length ? complete / workDays.length * 100 : 100
    };
  }

  function getContractData(now = new Date()) {
    const start = parseDateKey(state.settings.start);
    const end = parseDateKey(state.settings.end);
    const today = parseDateKey(toDateKey(now));
    const allDays = [];
    for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) allDays.push(new Date(cursor));
    const workDays = allDays.filter(isPlannedWorkDay);
    const totalDays = allDays.length;
    const beforeStart = today < start;
    const afterEnd = today > end;
    const passedCalendarDays = beforeStart ? 0 : afterEnd ? totalDays : clamp(dayDifference(start, today), 0, totalDays);
    const deadline = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, 0, 0, 0, 0);
    const startTime = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
    const duration = Math.max(1, deadline.getTime() - startTime);
    const progress = clamp((now.getTime() - startTime) / duration * 100, 0, 100);
    const remainingMs = clamp(deadline.getTime() - now.getTime(), 0, duration);
    const workDone = workDays.filter((day) => day < today).length;
    const workRemaining = workDays.filter((day) => day >= today).length;
    const totalWeeks = Math.ceil(totalDays / 7);
    const currentWeek = beforeStart ? 1 : clamp(Math.floor(dayDifference(start, today) / 7) + 1, 1, totalWeeks);
    const nextWork = workDays.find((day) => day >= today) || null;
    const pastMilestones = state.milestones.filter((item) => parseDateKey(item.date) < today).length;
    const planning = getPlanningStats(workDays);
    const xp = passedCalendarDays * 10 + pastMilestones * 50 + Math.floor(planning.hours) * 2;
    const level = clamp(Math.floor(xp / 250) + 1, 1, 10);
    return {
      now, today, start, end, deadline, allDays, workDays, totalDays, passedCalendarDays,
      daysRemaining: Math.max(0, totalDays - passedCalendarDays), progress, remainingMs,
      workDone, workRemaining, workProgress: workDays.length ? workDone / workDays.length * 100 : 100,
      totalWeeks, currentWeek, weeksRemaining: afterEnd ? 0 : Math.max(0, totalWeeks - currentWeek + 1),
      nextWork, planning, xp, level
    };
  }

  function setText(id, text) { const element = $(id); if (element) element.textContent = text; }
  function plural(value, singular, pluralForm = `${singular}s`) { return value > 1 ? pluralForm : singular; }
  function formatPercent(value, decimals = 0) { return `${value.toFixed(decimals).replace(".", ",")} %`; }
  function capitalize(value) { return value ? value.charAt(0).toUpperCase() + value.slice(1) : value; }

  function getUpcomingMilestones(today) {
    return [...state.milestones].filter((item) => parseDateKey(item.date) >= today).sort((a, b) => a.date.localeCompare(b.date));
  }

  function sortMilestones(today) {
    return [...state.milestones].sort((a, b) => {
      const aPast = parseDateKey(a.date) < today;
      const bPast = parseDateKey(b.date) < today;
      if (aPast !== bPast) return aPast ? 1 : -1;
      return aPast ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
    });
  }

  function renderHome(data) {
    const days = Math.floor(data.remainingMs / DAY_MS);
    const hours = Math.floor((data.remainingMs % DAY_MS) / HOUR_MS);
    const minutes = Math.floor((data.remainingMs % HOUR_MS) / 60000);
    const seconds = Math.floor((data.remainingMs % 60000) / 1000);
    const dayFraction = data.now.getHours() / 24 + data.now.getMinutes() / 1440;
    setText("contractNameHeader", state.settings.name);
    setText("headerDate", capitalize(longDate.format(data.now)));
    setText("contractRange", `Du ${shortDate.format(data.start)} au ${shortDate.format(data.end)}`);
    setText("progressPercent", formatPercent(data.progress, 1));
    setText("levelPill", `Niveau ${data.level}`);
    setText("railToday", data.progress >= 100 ? "Terminé" : data.progress <= 0 ? "À venir" : "Aujourd'hui");
    $("progressFill").style.width = `${data.progress}%`;
    $("progressMarker").style.left = `${data.progress}%`;
    setText("countDays", days);
    setText("countdownDetail", `${String(hours).padStart(2, "0")} h · ${String(minutes).padStart(2, "0")} min · ${String(seconds).padStart(2, "0")} s`);
    $("daySlice").style.height = `${clamp(dayFraction * 100, 0, 100)}%`;
    setText("daysPassed", data.passedCalendarDays);
    setText("daysTotal", `sur ${data.totalDays}`);
    setText("workRemaining", data.workRemaining);
    setText("weeksRemaining", data.weeksRemaining);

    const next = getUpcomingMilestones(data.today)[0];
    if (next) {
      const delta = dayDifference(data.today, parseDateKey(next.date));
      setText("nextStopTitle", next.name);
      setText("nextStopDate", delta === 0 ? "Aujourd'hui" : `${capitalize(longDate.format(parseDateKey(next.date)))} · dans ${delta} ${plural(delta, "jour")}`);
      $("nextStop").style.setProperty("--next-color", COLORS[next.color]);
    } else {
      setText("nextStopTitle", "Aucun jalon à venir");
      setText("nextStopDate", "Ajoute une date importante à ta trajectoire.");
    }

    const inContract = data.today >= data.start && data.today <= data.end;
    const plan = getDayPlan(data.today);
    setText("todayStatus", inContract ? (plan.worked ? "Jour travaillé" : "Jour de repos") : (data.today < data.start ? "Avant le départ" : "Contrat terminé"));
    setText("dailyMessage", getDailyMessage(data, inContract ? plan : null));
    $("todayStatusDot").classList.toggle("off", !inContract || !plan.worked);
    setText("weekLabel", `Semaine ${data.currentWeek} sur ${data.totalWeeks}`);
    setText("nextWorkLabel", formatNextWork(data.nextWork));
    const weekElapsed = clamp(dayDifference(addDays(data.start, (data.currentWeek - 1) * 7), data.today) + dayFraction, 0, 7);
    $("weekProgress").style.width = `${weekElapsed / 7 * 100}%`;
  }

  function formatNextWork(date) {
    if (!date) return "Plus aucun service prévu";
    const plan = getDayPlan(date);
    const details = [plan.provisional ? "prévisionnel" : "", plan.start || "horaire libre", plan.attraction, getShiftRoles(plan).join(" + ")].filter(Boolean).join(" · ");
    return `Prochain service : ${shortDate.format(date)}${details ? ` · ${details}` : ""}`;
  }

  function getDailyMessage(data, plan) {
    if (data.today < data.start) return `Le départ est prévu dans ${dayDifference(data.today, data.start)} jours.`;
    if (data.today > data.end) return "La ligne d'arrivée est franchie. Mission accomplie.";
    if (!plan.worked) return "Aujourd'hui compte aussi : le temps progresse pendant le repos.";
    const details = [plan.provisional ? "prévisionnel" : "", plan.start && plan.end ? `${plan.start}–${plan.end}` : "horaires à compléter", plan.attraction, getShiftRoles(plan).join(" + ")].filter(Boolean).join(" · ");
    return `Shift du jour : ${details}. Une journée de plus vers l'arrivée.`;
  }

  function renderBarRows(containerId, items, valueFormatter = (value) => String(value)) {
    const container = $(containerId);
    if (!container) return;
    const visible = items.filter((item) => item.value > 0);
    if (!visible.length) {
      container.innerHTML = '<div class="empty-state compact-empty">Aucune donnée suffisante pour cette période.</div>';
      return;
    }
    const maximum = Math.max(...visible.map((item) => item.value), 1);
    container.innerHTML = visible.map((item) => `<div class="stat-bar-row ${item.tone || ""}">
      <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(valueFormatter(item.value))}</strong></div>
      <div class="stat-bar-track"><i style="width:${item.value / maximum * 100}%"></i></div>
      ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}
    </div>`).join("");
  }

  function getPauseClockLabel(plan, pause) {
    const clock = CapBreaks.getPauseClock(pause, plan.start);
    if (!clock.start || !clock.end) return `${pause.type} — ${pause.durationMinutes} min`;
    const suffix = clock.dayOffset > 0 ? " +1" : "";
    return `${pause.type} ${clock.start}–${clock.end}${suffix}`;
  }

  function getPauseDetailLabel(plan) {
    if (!Array.isArray(plan.pauses) || !plan.pauses.length) return "Aucune pause";
    return plan.pauses.map((pause) => `${getPauseClockLabel(plan, pause)} (${pause.durationMinutes} min)`).join(" · ");
  }

  function renderPlanningPauses(plan) {
    if (!Array.isArray(plan.pauses) || !plan.pauses.length) return '<span class="planning-no-pause">Sans pause</span>';
    return plan.pauses.map((pause) => `<span class="planning-pause-chip ${pause.type === "L" ? "lunch" : "break"}">${escapeHtml(getPauseClockLabel(plan, pause))}</span>`).join("");
  }

  function renderPlanning(data) {
    const planning = data.planning;
    const planningAnchor = data.allDays.find((day) => day >= data.today) || data.allDays[data.allDays.length - 1] || null;
    setText("planningDayCount", data.workDays.length);
    setText("planningTimedCount", planning.timed);
    setText("planningProvisionalCount", planning.provisional);
    setText("planningHoursTotal", formatHours(planning.minutes));

    let records = data.allDays.map(getShiftRecord);
    if (state.planningFilter === "work") records = records.filter((record) => record.plan.worked);
    if (state.planningFilter === "provisional") records = records.filter((record) => record.plan.worked && record.plan.provisional);
    if (!records.length) {
      $("planningList").innerHTML = '<div class="empty-state">Aucune journée ne correspond à ce filtre.</div>';
      return;
    }

    const grouped = records.reduce((months, record) => {
      if (!months[record.monthKey]) months[record.monthKey] = [];
      months[record.monthKey].push(record);
      return months;
    }, {});

    $("planningList").innerHTML = Object.entries(grouped).map(([monthKey, monthRecords]) => {
      const rows = monthRecords.map((record) => {
        const plan = record.plan;
        const isToday = isSameDay(record.date, data.today);
        const isAnchor = planningAnchor && isSameDay(record.date, planningAnchor);
        const roleTags = record.roles.length
          ? record.roles.map((role) => `<span class="shift-role ${role.toLowerCase()}">${role}</span>`).join("")
          : plan.worked ? '<span class="shift-role standard">STANDARD</span>' : "";
        const provisionalTag = plan.provisional ? '<span class="provisional-badge">Prévisionnel</span>' : "";
        const timeLabel = record.timed ? `${plan.start}–${plan.end}` : plan.worked ? "Horaires à compléter" : "Journée de repos";
        const pauseLine = record.timed ? `<span class="planning-pause-line">${renderPlanningPauses(plan)}</span>` : "";
        const todayAttributes = isToday ? ' data-planning-today="true" aria-current="date"' : "";
        const anchorAttribute = isAnchor ? ' data-planning-anchor="true"' : "";
        return `<button class="planning-row ${plan.worked ? "work" : "off"} ${plan.provisional ? "provisional" : ""} ${isToday ? "today" : ""}" type="button" data-edit-day="${record.dateKey}"${todayAttributes}${anchorAttribute}>
          <span class="planning-date"><strong>${WEEKDAY_SHORT[record.date.getDay()]}</strong><b>${record.date.getDate()}</b></span>
          <span class="planning-main"><strong>${escapeHtml(plan.worked ? (plan.attraction || "Sans attraction") : "Repos")}</strong><small>${escapeHtml(timeLabel)}</small>${pauseLine}${provisionalTag}</span>
          <span class="planning-role">${roleTags}</span>
          <span class="planning-duration"><strong>${record.timed ? escapeHtml(formatDuration(record.amplitudeMinutes)) : "—"}</strong><small>${record.timed ? `${escapeHtml(formatDuration(record.minutes))} net` : "amplitude"}</small></span>
        </button>`;
      }).join("");
      return `<section class="planning-month"><div class="planning-month-title"><h2>${escapeHtml(capitalize(monthYear.format(parseDateKey(`${monthKey}-01`))))}</h2><span>${monthRecords.length} ${plural(monthRecords.length, "jour")}</span></div>${rows}</section>`;
    }).join("");
  }

  function renderHours(data) {
    const monthKeys = [...new Set(data.allDays.map(getMonthKey))];
    if (state.hoursPeriod !== "all" && !monthKeys.includes(state.hoursPeriod)) state.hoursPeriod = "all";
    $("hoursPeriod").innerHTML = [
      '<option value="all">Tout le contrat</option>',
      ...monthKeys.map((key) => `<option value="${key}">${escapeHtml(capitalize(monthYear.format(parseDateKey(`${key}-01`))))}</option>`)
    ].join("");
    $("hoursPeriod").value = state.hoursPeriod;

    const records = data.planning.timedRecords.filter((record) => state.hoursPeriod === "all" || record.monthKey === state.hoursPeriod);
    const minutes = records.reduce((sum, record) => sum + record.minutes, 0);
    const confirmedMinutes = records.filter((record) => !record.plan.provisional).reduce((sum, record) => sum + record.minutes, 0);
    const provisionalMinutes = records.filter((record) => record.plan.provisional).reduce((sum, record) => sum + record.minutes, 0);
    const periodLabel = state.hoursPeriod === "all" ? "Tout le contrat" : capitalize(monthYear.format(parseDateKey(`${state.hoursPeriod}-01`)));
    setText("hoursPeriodLabel", periodLabel);
    setText("hoursGrandTotal", formatHours(minutes));
    setText("hoursShiftCount", `${records.length} ${plural(records.length, "shift")} renseigné${records.length > 1 ? "s" : ""}`);
    setText("hoursConfirmed", formatHours(confirmedMinutes));
    setText("hoursProvisional", formatHours(provisionalMinutes));
    setText("hoursAverage", records.length ? formatHours(Math.round(minutes / records.length)) : "0 h");
    setText("hoursDetailCount", records.length);

    renderBarRows("hoursAttractionBars", [
      { label: "HSM", value: records.filter((record) => record.plan.attraction === "HSM").reduce((sum, record) => sum + record.minutes, 0), tone: "cyan" },
      { label: "STT", value: records.filter((record) => record.plan.attraction === "STT").reduce((sum, record) => sum + record.minutes, 0), tone: "coral" },
      { label: "Sans attraction", value: records.filter((record) => !record.plan.attraction).reduce((sum, record) => sum + record.minutes, 0), tone: "muted" }
    ], formatHours);

    $("hoursBreakdown").innerHTML = records.length ? records.map((record) => {
      const plan = record.plan;
      return `<button class="hour-row ${plan.provisional ? "provisional" : ""}" type="button" data-edit-day="${record.dateKey}">
        <span><strong>${escapeHtml(capitalize(shortDate.format(record.date)))}</strong><small>${escapeHtml(plan.attraction || "Sans attraction")} · ${escapeHtml(getShiftRoleLabel(plan))}</small></span>
        <span><strong>${plan.start}–${plan.end}</strong><small>${escapeHtml(plan.pauseRuleCode || "Sans pause")} · ${plan.provisional ? "Prévisionnel" : "Confirmé"}</small></span>
        <b>${escapeHtml(formatDuration(record.minutes))}</b>
      </button>`;
    }).join("") : '<div class="empty-state">Aucun shift avec des horaires complets sur cette période.</div>';

    renderPayroll(data);
  }

  function getPayrollMonthSettings(monthKey) {
    if (!state.payrollSettings[monthKey]) state.payrollSettings[monthKey] = normalizePayrollSettings(monthKey);
    return state.payrollSettings[monthKey];
  }

  function renderPayroll(data) {
    const hasMonth = state.hoursPeriod !== "all";
    $("payrollUnavailable").hidden = hasMonth;
    $("payrollContent").hidden = !hasMonth;
    setText("payrollMonthLabel", hasMonth ? capitalize(monthYear.format(parseDateKey(`${state.hoursPeriod}-01`))) : "—");
    if (!hasMonth) return;

    const settings = getPayrollMonthSettings(state.hoursPeriod);
    $("payrollVariableStart").value = settings.variableStart;
    $("payrollVariableEnd").value = settings.variableEnd;
    $("payrollOtherOrdinary").value = settings.otherOrdinary || 0;
    $("payrollRecall").value = settings.recall || 0;
    $("payrollOfficialHs25").value = settings.officialHs25Minutes === null ? "" : settings.officialHs25Minutes;
    $("payrollOfficialHs50").value = settings.officialHs50Minutes === null ? "" : settings.officialHs50Minutes;
    $("payrollWithholdingRate").value = Number((settings.withholdingRate * 100).toFixed(2));

    const estimate = CapPayroll.estimateMonthlyPay(data.allDays.map(getShiftRecord).map((record) => record.payroll), {
      monthKey: state.hoursPeriod,
      ...settings
    });
    if (!estimate) return;

    setText("payrollNetPaidHero", formatMoney(estimate.netPaid));
    setText("payrollPaidTime", formatHours(estimate.paidMinutes));
    setText("payrollNightTime", formatHours(estimate.nightMinutes));
    setText("payrollLongTime", formatHours(estimate.longMinutes));
    setText("payrollWorkedDays", estimate.workedDays);
    setText("payrollFixed", formatMoney(estimate.lines.fixed));
    setText("payrollNight", formatMoney(estimate.lines.night));
    setText("payrollDressing", formatMoney(estimate.lines.dressing));
    setText("payrollLong", formatMoney(estimate.lines.longDay));
    setText("payrollOther", formatMoney(estimate.lines.otherOrdinary));
    setText("payrollRecallLine", formatMoney(estimate.lines.recall));
    setText("payrollHs25", `${formatMoney(estimate.lines.hs25)} · ${formatHours(estimate.hs25Minutes)}`);
    setText("payrollHs50", `${formatMoney(estimate.lines.hs50)} · ${formatHours(estimate.hs50Minutes)}`);
    setText("payrollGross", formatMoney(estimate.grossTotal));
    setText("payrollNetBeforeTax", formatMoney(estimate.netBeforeTax));
    setText("payrollTax", formatMoney(estimate.tax));
    setText("payrollNetPaid", formatMoney(estimate.netPaid));

    const actualDays = estimate.days.filter((day) => day.source === "actual").length;
    const plannedDays = estimate.days.filter((day) => day.source === "planned").length;
    const overtimeMode = estimate.usesOfficialOvertime ? "HS officielles prioritaires" : "HS inférées du lundi au dimanche";
    setText("payrollPeriodNote", `Variables du ${estimate.variableStart.split("-").reverse().join("/")} au ${estimate.variableEnd.split("-").reverse().join("/")} · ${actualDays} par badgeage · ${plannedDays} par planning · ${overtimeMode}.`);
  }

  function updatePayrollSettingsFromForm() {
    if (state.hoursPeriod === "all") return;
    const monthKey = state.hoursPeriod;
    state.payrollSettings[monthKey] = normalizePayrollSettings(monthKey, {
      variableStart: $("payrollVariableStart").value,
      variableEnd: $("payrollVariableEnd").value,
      otherOrdinary: $("payrollOtherOrdinary").value,
      recall: $("payrollRecall").value,
      officialHs25Minutes: $("payrollOfficialHs25").value,
      officialHs50Minutes: $("payrollOfficialHs50").value,
      withholdingRate: Number($("payrollWithholdingRate").value) / 100
    });
    savePayrollSettings();
    renderPayroll(getContractData());
  }

  function renderCalendar(data) {
    const currentMonthKey = `${data.today.getFullYear()}-${data.today.getMonth()}`;
    const months = [];
    let cursor = new Date(data.start.getFullYear(), data.start.getMonth(), 1, 12);
    const lastMonth = new Date(data.end.getFullYear(), data.end.getMonth(), 1, 12);
    while (cursor <= lastMonth) { months.push(new Date(cursor)); cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12); }

    $("calendarList").innerHTML = months.map((month) => {
      const key = `${month.getFullYear()}-${month.getMonth()}`;
      const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
      const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
      const leading = (first.getDay() + 6) % 7;
      const cells = Array.from({ length: leading }, () => '<span class="calendar-day empty"></span>');
      for (let day = 1; day <= last.getDate(); day += 1) {
        const date = new Date(month.getFullYear(), month.getMonth(), day, 12);
        const dateKey = toDateKey(date);
        const inContract = date >= data.start && date <= data.end;
        const plan = getDayPlan(date);
        const dateMilestones = state.milestones.filter((item) => item.date === dateKey);
        const leadMilestone = dateMilestones.find((item) => item.important) || dateMilestones[0];
        const classes = ["calendar-day", plan.worked ? "work" : "off"];
        if (!inContract) classes.push("out-contract");
        if (date < data.today) classes.push("past");
        if (isSameDay(date, data.today)) classes.push("today");
        if (leadMilestone) classes.push("milestone");
        if (dateMilestones.some((item) => item.important)) classes.push("important");
        if (plan.provisional) classes.push("provisional");
        if (state.calendarFilter === "work" && !plan.worked) classes.push("hidden-by-filter");
        if (state.calendarFilter === "off" && plan.worked) classes.push("hidden-by-filter");
        const shiftTitle = inContract && plan.worked ? [plan.provisional ? "prévisionnel" : "", plan.start && plan.end ? `${plan.start}-${plan.end}` : "horaires libres", plan.attraction, getShiftRoles(plan).join(" + "), plan.start && plan.end ? getPauseDetailLabel(plan) : ""].filter(Boolean).join(" · ") : "repos";
        const milestoneTitle = dateMilestones.length ? ` · ${dateMilestones.map((item) => item.name).join(", ")}` : "";
        const title = `${longDate.format(date)} · ${shiftTitle}${milestoneTitle}`;
        const style = leadMilestone ? ` style="--milestone-color:${COLORS[leadMilestone.color]}"` : "";
        const tag = inContract ? "button" : "span";
        const attrs = inContract ? ` type="button" data-edit-day="${dateKey}" aria-label="Configurer ${escapeHtml(longDate.format(date))}"` : "";
        const pauseMarks = inContract && plan.worked && plan.pauses.length
          ? `<span class="calendar-pause-marks" aria-hidden="true">${plan.pauses.map((pause) => `<i class="calendar-pause-mark ${pause.type === "L" ? "lunch" : "break"}">${pause.type}</i>`).join("")}</span>`
          : "";
        cells.push(`<${tag} class="${classes.join(" ")}" title="${escapeHtml(title)}"${style}${attrs}><span class="calendar-number">${day}</span>${pauseMarks}</${tag}>`);
      }
      return `<section class="month-section ${key === currentMonthKey ? "current-month" : ""}" data-month="${key}">
        <div class="month-title"><h2>${escapeHtml(monthOnly.format(month))}</h2><span>${month.getFullYear()}</span></div>
        <div class="month-head">${MONTH_HEAD.map((label) => `<span>${label}</span>`).join("")}</div><div class="month-grid">${cells.join("")}</div>
      </section>`;
    }).join("");
  }

  function renderGrids(data) {
    setText("calendarGridTitle", `${data.passedCalendarDays} sur ${data.totalDays}`);
    setText("calendarGridPercent", formatPercent(data.progress));
    setText("workGridTitle", `${data.workDone} sur ${data.workDays.length}`);
    setText("workGridPercent", formatPercent(data.workProgress));

    $("calendarMatrix").innerHTML = data.allDays.map((day) => {
      const plan = getDayPlan(day);
      const status = day < data.today ? "done" : isSameDay(day, data.today) ? "today" : "future";
      const details = [capitalize(longDate.format(day)), plan.worked ? "travaillé" : "repos", plan.start && plan.end ? `${plan.start}–${plan.end}` : ""].filter(Boolean).join(" · ");
      return `<button class="sequence-unit ${status} ${plan.worked ? "work" : "off"} ${plan.provisional ? "provisional" : ""}" type="button" data-edit-day="${toDateKey(day)}" title="${escapeHtml(details)}" aria-label="Configurer ${escapeHtml(longDate.format(day))}">${day.getDate()}</button>`;
    }).join("");

    $("workMatrix").innerHTML = data.workDays.map((day) => {
      const plan = getDayPlan(day);
      const status = day < data.today ? "done" : isSameDay(day, data.today) ? "today" : "future";
      const attractionClass = plan.attraction ? `attraction-${plan.attraction.toLowerCase()}` : "";
      const details = [capitalize(longDate.format(day)), plan.start && plan.end ? `${plan.start}–${plan.end}` : "horaires libres", plan.attraction].filter(Boolean).join(" · ");
      return `<button class="sequence-unit work-unit ${status} ${attractionClass} ${plan.provisional ? "provisional" : ""}" type="button" data-edit-day="${toDateKey(day)}" title="${escapeHtml(details)}" aria-label="Configurer ${escapeHtml(longDate.format(day))}">${day.getDate()}</button>`;
    }).join("");
  }

  function renderMilestones(data) {
    const milestones = sortMilestones(data.today);
    const upcoming = milestones.filter((item) => parseDateKey(item.date) >= data.today).length;
    setText("milestoneUpcomingCount", upcoming);
    setText("milestoneImportantCount", milestones.filter((item) => item.important).length);
    setText("milestoneDoneCount", milestones.length - upcoming);
    if (!milestones.length) {
      $("milestoneList").innerHTML = '<div class="empty-state">Aucun jalon pour le moment.<br>Le premier point de repère t’attend.</div>';
      return;
    }
    $("milestoneList").innerHTML = milestones.map((item) => {
      const date = parseDateKey(item.date);
      const delta = dayDifference(data.today, date);
      const timing = delta === 0 ? "Aujourd'hui" : delta > 0 ? `Dans ${delta} ${plural(delta, "jour")}` : `Franchi il y a ${Math.abs(delta)} ${plural(Math.abs(delta), "jour")}`;
      return `<article class="milestone-item ${item.important ? "important" : ""} ${delta < 0 ? "past" : ""}" style="--milestone-color:${COLORS[item.color]}">
        <div><h3>${escapeHtml(item.name)}</h3><p>${capitalize(longDate.format(date))} · ${timing}</p>${item.important ? '<span class="milestone-tag">Important</span>' : ""}</div>
        <button class="edit-milestone" type="button" data-edit-milestone="${escapeHtml(item.id)}" aria-label="Modifier ${escapeHtml(item.name)}">✎</button>
      </article>`;
    }).join("");
  }

  function buildAchievements(data) {
    const achievements = [];
    const add = (code, title, text, category, unlocked) => achievements.push({ code, title, text, category, unlocked });
    const progressNames = ["Échauffement", "Mise en route", "Premier cap", "Vitesse de croisière", "Quart de route", "Cap solide", "Bon rythme", "En plein élan", "Vue dégagée", "Mi-parcours", "Deuxième souffle", "Cap des 60", "Endurance", "Belle avancée", "Trois quarts", "Dernier cinquième", "L'arrivée se dessine", "Sprint final", "Presque là", "Mission accomplie"];
    for (let i = 1; i <= 20; i += 1) add(`${i * 5}%`, progressNames[i - 1], `Atteindre ${i * 5} % du contrat`, "Progression", data.progress >= i * 5);

    const dayThresholds = [1, 3, 7, 10, 14, 21, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, data.totalDays];
    dayThresholds.forEach((threshold, index) => add(`J${index + 1}`, `${threshold} jours derrière soi`, `Franchir ${threshold} jours calendaires`, "Calendrier", data.passedCalendarDays >= threshold));

    for (let i = 1; i <= 20; i += 1) {
      const threshold = Math.max(1, Math.ceil(data.workDays.length * i / 20));
      add(`S${i}`, `Service ${threshold}`, `Terminer ${threshold} jours travaillés`, "Travail", data.workDone >= threshold);
    }

    const hourThresholds = [8, 16, 40, 80, 120, 200, 300, 500, 750, 1000];
    hourThresholds.forEach((threshold, index) => add(`H${index + 1}`, `${threshold} heures au compteur`, `Planifier au moins ${threshold} heures`, "Horaires", data.planning.hours >= threshold));

    for (let i = 1; i <= 10; i += 1) add(`M${i}`, i === 1 ? "Premier repère" : `${i} jalons posés`, `Créer ${i} ${plural(i, "jalon")}`, "Jalons", state.milestones.length >= i);

    const planningChecks = [
      { title: "Premier shift", text: "Renseigner un shift complet", value: data.planning.complete >= 1 },
      { title: "Planning à 25 %", text: "Compléter un quart des shifts", value: data.planning.fill >= 25 },
      { title: "Planning à moitié", text: "Compléter la moitié des shifts", value: data.planning.fill >= 50 },
      { title: "Planning à 75 %", text: "Compléter trois quarts des shifts", value: data.planning.fill >= 75 },
      { title: "Planning impeccable", text: "Compléter tous les shifts", value: data.planning.fill >= 100 }
    ];
    planningChecks.forEach((item, index) => add(`P${index + 1}`, item.title, item.text, "Planning", item.value));
    return achievements;
  }

  function renderTrophies(data) {
    const levelStart = (data.level - 1) * 250;
    const levelProgress = data.level === 10 ? 100 : clamp((data.xp - levelStart) / 250 * 100, 0, 100);
    setText("levelMedal", data.level);
    setText("levelName", LEVEL_NAMES[data.level - 1]);
    setText("xpLabel", `${data.xp} XP`);
    setText("nextLevelLabel", data.level === 10 ? "Niveau maximum atteint" : `Prochain niveau dans ${Math.max(0, data.level * 250 - data.xp)} XP`);
    setText("xpPercent", formatPercent(levelProgress));
    $("xpRing").style.setProperty("--xp", `${levelProgress}%`);

    const achievements = buildAchievements(data);
    const unlocked = achievements.filter((item) => item.unlocked);
    let visible = achievements;
    if (state.trophyFilter === "unlocked") visible = unlocked;
    if (state.trophyFilter === "next") visible = [...unlocked.slice(-6), ...achievements.filter((item) => !item.unlocked).slice(0, 12)];
    setText("achievementTotalTitle", `${achievements.length} trophées`);
    setText("achievementCount", `${unlocked.length}/${achievements.length}`);
    $("achievementGrid").innerHTML = visible.length ? visible.map((item) => `<article class="achievement ${item.unlocked ? "" : "locked"}"><i>${item.code}</i><strong>${item.title}</strong><span>${item.text}</span><span class="achievement-category">${item.category}</span></article>`).join("") : '<div class="empty-state">Aucun trophée débloqué pour le moment.</div>';
  }

  function renderStats(data) {
    const records = data.planning.timedRecords;
    const durations = records.map((record) => record.minutes);
    const averageMinutes = records.length ? Math.round(data.planning.minutes / records.length) : 0;
    const medianMinutes = Math.round(median(durations));
    const highlights = [
      { label: "Heures totales", value: formatHours(data.planning.minutes), tone: "acid" },
      { label: "Shifts renseignés", value: records.length, tone: "cyan" },
      { label: "Durée moyenne", value: formatHours(averageMinutes), tone: "gold" },
      { label: "Durée médiane", value: formatHours(medianMinutes), tone: "violet" },
      { label: "Heures confirmées", value: formatHours(data.planning.confirmedMinutes), tone: "green" },
      { label: "Heures prévisionnelles", value: formatHours(data.planning.provisionalMinutes), tone: "coral" },
      { label: "Shifts OPEN", value: data.planning.open, tone: "cyan" },
      { label: "Shifts CLOSE", value: data.planning.close, tone: "coral" }
    ];
    $("statsHighlights").innerHTML = highlights.map((item) => `<article class="${item.tone}"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></article>`).join("");

    const missingTimes = Math.max(0, data.workDays.length - data.planning.timed);
    const missingAttraction = data.planning.records.filter((record) => record.timed && !record.plan.attraction).length;
    setText("statsCompletionRate", formatPercent(data.planning.fill));
    $("statsCompletionBar").style.width = `${data.planning.fill}%`;
    $("statsQualityGrid").innerHTML = [
      [data.workDays.length, "jours travaillés"],
      [data.planning.timed, "horaires complets"],
      [data.planning.complete, "shifts complets"],
      [missingTimes, "horaires manquants"],
      [missingAttraction, "attractions manquantes"],
      [data.planning.provisional, "prévisionnels"]
    ].map(([value, label]) => `<div><strong>${value}</strong><span>${label}</span></div>`).join("");

    const attractionItems = ["HSM", "STT", ""].map((attraction) => {
      const matching = records.filter((record) => record.plan.attraction === attraction);
      return {
        label: attraction || "Sans attraction",
        value: matching.reduce((sum, record) => sum + record.minutes, 0),
        detail: `${matching.length} ${plural(matching.length, "shift")}`,
        tone: attraction === "HSM" ? "cyan" : attraction === "STT" ? "coral" : "muted"
      };
    });
    renderBarRows("statsAttractionBars", attractionItems, formatHours);

    const openOnly = records.filter((record) => record.roles.length === 1 && record.roles[0] === "OPEN").length;
    const closeOnly = records.filter((record) => record.roles.length === 1 && record.roles[0] === "CLOSE").length;
    const openClose = records.filter((record) => record.roles.length === 2).length;
    const standard = records.filter((record) => !record.roles.length).length;
    renderBarRows("statsRoleBars", [
      { label: "OPEN", value: openOnly, tone: "cyan" },
      { label: "CLOSE", value: closeOnly, tone: "coral" },
      { label: "OPEN + CLOSE", value: openClose, tone: "gold" },
      { label: "Standard", value: standard, tone: "muted" }
    ], (value) => `${value} ${plural(value, "shift")}`);

    const monthItems = [...new Set(data.allDays.map(getMonthKey))].map((key) => ({
      label: capitalize(monthYear.format(parseDateKey(`${key}-01`))),
      key,
      value: records.filter((record) => record.monthKey === key).reduce((sum, record) => sum + record.minutes, 0),
      tone: "acid"
    }));
    renderBarRows("statsMonthBars", monthItems, formatHours);

    const weekdayItems = WEEKDAY_ORDER.map((day) => ({
      label: WEEKDAY_SHORT[day],
      day,
      value: records.filter((record) => record.date.getDay() === day).reduce((sum, record) => sum + record.minutes, 0),
      tone: "violet"
    }));
    renderBarRows("statsWeekdayBars", weekdayItems, formatHours);

    const allPauses = records.flatMap((record) => Array.isArray(record.plan.pauses) ? record.plan.pauses : []);
    const breakCount = allPauses.filter((pause) => pause.type === "B").length;
    const lunchCount = allPauses.filter((pause) => pause.type === "L").length;
    const totalPauseMinutes = CapBreaks.calculateTotalPauseMinutes(allPauses);
    const manualCount = allPauses.filter((pause) => pause.source === "manual" || pause.locked).length;
    const conformingShifts = records.filter((record) => CapBreaks.validateContinuousWorkLimit(record.plan, record.plan.pauses).valid).length;
    const pauseShiftCount = records.filter((record) => record.plan.pauses.length).length;
    const averagePauseMinutes = records.length ? Math.round(totalPauseMinutes / records.length) : 0;
    $("statsPauseSummary").innerHTML = [
      [breakCount, "breaks de 15 min"],
      [lunchCount, "lunchs de 45 min"],
      [formatHours(totalPauseMinutes), "temps total en pause"],
      [averagePauseMinutes ? `${averagePauseMinutes} min` : "0 min", "pause moyenne par shift"],
      [manualCount, "pauses déplacées manuellement"],
      [`${conformingShifts}/${records.length}`, "shifts conformes aux 3 h 30"]
    ].map(([value, label]) => `<article><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></article>`).join("");
    const pauseRegimes = ["B", "BB", "L", "BL", "BLB"].map((code) => ({
      label: code,
      value: records.filter((record) => record.plan.pauseRuleCode === code).length,
      detail: `${records.filter((record) => record.plan.pauseRuleCode === code).length} ${plural(records.filter((record) => record.plan.pauseRuleCode === code).length, "shift")}`,
      tone: code.includes("L") ? "cyan" : "gold"
    }));
    pauseRegimes.push({ label: "Sans pause", value: Math.max(0, records.length - pauseShiftCount), tone: "muted" });
    renderBarRows("statsPauseBars", pauseRegimes, (value) => `${value} ${plural(value, "shift")}`);

    const longest = records.reduce((best, record) => !best || record.minutes > best.minutes ? record : best, null);
    const shortest = records.reduce((best, record) => !best || record.minutes < best.minutes ? record : best, null);
    const busiestMonth = monthItems.reduce((best, item) => !best || item.value > best.value ? item : best, null);
    const busiestWeekday = weekdayItems.reduce((best, item) => !best || item.value > best.value ? item : best, null);
    const longestStreak = getLongestWorkStreak(data.workDays);
    const recordItems = [
      { label: "Shift le plus long", value: longest ? formatDuration(longest.minutes) : "—", detail: longest ? capitalize(shortDate.format(longest.date)) : "Aucune donnée" },
      { label: "Shift le plus court", value: shortest ? formatDuration(shortest.minutes) : "—", detail: shortest ? capitalize(shortDate.format(shortest.date)) : "Aucune donnée" },
      { label: "Plus longue salve", value: `${longestStreak.count} ${plural(longestStreak.count, "jour")}`, detail: longestStreak.start ? `${shortDate.format(longestStreak.start)} → ${shortDate.format(longestStreak.end)}` : "Aucune donnée" },
      { label: "Mois le plus chargé", value: busiestMonth && busiestMonth.value ? formatHours(busiestMonth.value) : "—", detail: busiestMonth && busiestMonth.value ? busiestMonth.label : "Aucune donnée" },
      { label: "Jour le plus chargé", value: busiestWeekday && busiestWeekday.value ? formatHours(busiestWeekday.value) : "—", detail: busiestWeekday && busiestWeekday.value ? busiestWeekday.label : "Aucune donnée" },
      { label: "Moyenne par semaine", value: formatHours(Math.round(data.planning.minutes / Math.max(1, data.totalWeeks))), detail: `${data.totalWeeks} ${plural(data.totalWeeks, "semaine")}` }
    ];
    $("statsRecords").innerHTML = recordItems.map((item) => `<article><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail)}</small></article>`).join("");
  }

  function renderAll() {
    const data = getContractData();
    renderHome(data);
    renderPlanning(data);
    renderHours(data);
    renderCalendar(data);
    renderGrids(data);
    renderMilestones(data);
    renderStats(data);
    renderTrophies(data);
    updateFormBounds();
  }

  function activateView(view) {
    if (!$("view-" + view)) return;
    state.activeView = view;
    document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
    document.querySelectorAll(".bottom-nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: "smooth" });
    const data = getContractData();
    if (view === "planning") renderPlanning(data);
    if (view === "hours") renderHours(data);
    if (view === "grids") renderGrids(data);
    if (view === "stats") renderStats(data);
    if (view === "trophies") renderTrophies(data);
  }

  function createFormOptions() {
    $("colorOptions").innerHTML = Object.entries(COLORS).map(([name, value], index) => `<label class="color-option" title="${name}"><input type="radio" name="milestoneColor" value="${name}" ${index === 0 ? "checked" : ""}><span style="--swatch:${value}"></span></label>`).join("");
    $("restDayOptions").innerHTML = WEEKDAY_ORDER.map((day) => `<label class="rest-option"><input type="checkbox" name="restDay" value="${day}"><span>${WEEKDAY_SHORT[day]}</span></label>`).join("");
  }

  function updateFormBounds() { $("milestoneDate").min = state.settings.start; $("milestoneDate").max = state.settings.end; }
  function openSheet(sheet) { $("sheetBackdrop").hidden = false; sheet.hidden = false; document.body.style.overflow = "hidden"; }
  function closeSheets() { $("sheetBackdrop").hidden = true; document.querySelectorAll(".bottom-sheet").forEach((sheet) => { sheet.hidden = true; }); document.body.style.overflow = ""; }

  function resetMilestoneForm() {
    $("milestoneForm").reset();
    $("milestoneEditId").value = "";
    document.querySelector('input[name="milestoneColor"][value="gold"]').checked = true;
    setText("milestoneSheetTitle", "Nouveau jalon");
    setText("saveMilestone", "Ajouter le jalon");
    $("deleteMilestone").hidden = true;
    updateFormBounds();
  }

  function openMilestoneEditor(id = null) {
    resetMilestoneForm();
    if (id) {
      const item = state.milestones.find((milestone) => milestone.id === id);
      if (!item) return;
      $("milestoneEditId").value = item.id;
      $("milestoneName").value = item.name;
      $("milestoneDate").value = item.date;
      $("milestoneImportant").checked = item.important;
      const color = document.querySelector(`input[name="milestoneColor"][value="${item.color}"]`);
      if (color) color.checked = true;
      setText("milestoneSheetTitle", "Modifier le jalon");
      setText("saveMilestone", "Enregistrer les changements");
      $("deleteMilestone").hidden = false;
    } else {
      const data = getContractData();
      $("milestoneDate").value = toDateKey(new Date(Math.min(Math.max(data.today.getTime(), data.start.getTime()), data.end.getTime())));
    }
    openSheet($("milestoneSheet"));
    setTimeout(() => $("milestoneName").focus(), 150);
  }

  function openDayEditor(dateKey) {
    if (!isDateKey(dateKey)) return;
    const plan = getDayPlan(dateKey);
    const date = parseDateKey(dateKey);
    $("dayEditDate").value = dateKey;
    setText("daySheetTitle", capitalize(new Intl.DateTimeFormat("fr-FR", { weekday: "long" }).format(date)));
    setText("daySheetDate", capitalize(longDate.format(date)));
    $("dayWorked").checked = plan.worked;
    $("dayProvisional").checked = Boolean(plan.provisional);
    $("shiftStart").value = plan.start;
    $("shiftEnd").value = plan.end;
    $("actualStart").value = plan.actualStart;
    $("actualEnd").value = plan.actualEnd;
    state.dayPauseDraft = CapBreaks.normalizePauses(plan.pauses, { id: dateKey, dateKey });
    state.dayPauseLastStart = plan.start;
    state.dayPauseLastEnd = plan.end;
    state.dayPauseRequiresReset = Boolean(plan.pauseValidation && !plan.pauseValidation.valid);
    state.dayPauseWarning = state.dayPauseRequiresReset ? plan.pauseValidation.message : "";
    $("shiftNote").value = plan.note;
    const attraction = document.querySelector(`input[name="attraction"][value="${plan.attraction}"]`);
    if (attraction) attraction.checked = true;
    updateDayFormState();
    openSheet($("daySheet"));
  }

  function updateDayFormState() {
    const worked = $("dayWorked").checked;
    if (!worked) $("dayProvisional").checked = false;
    [$("shiftStart"), $("shiftEnd"), $("actualStart"), $("actualEnd"), $("shiftNote")].forEach((input) => { input.disabled = !worked; });
    $("dayProvisional").disabled = !worked;
    document.querySelectorAll('input[name="attraction"]').forEach((input) => { input.disabled = !worked; });
    $("dayForm").querySelector(".shift-time-fields").classList.toggle("disabled", !worked);
    $("dayForm").querySelector(".badge-field").classList.toggle("disabled", !worked);
    $("dayForm").querySelector(".break-field").classList.toggle("disabled", !worked);
    $("dayForm").querySelector(".attraction-field").classList.toggle("disabled", !worked);
    $("dayForm").querySelector(".provisional-toggle").classList.toggle("disabled", !worked);
    $("shiftNote").closest(".field").classList.toggle("disabled", !worked);
    if (!worked) {
      state.dayPauseDraft = [];
      state.dayPauseRequiresReset = false;
      state.dayPauseWarning = "";
    } else if (isTime($("shiftStart").value) && isTime($("shiftEnd").value) && !state.dayPauseDraft.length) {
      recalculateEditorPauses(true);
    }
    updateShiftDuration();
  }

  function editorShift() {
    return {
      id: $("dayEditDate").value || "draft",
      dateKey: $("dayEditDate").value,
      start: $("shiftStart").value,
      end: $("shiftEnd").value
    };
  }

  function translatePauseOffset(pause, previousStart, nextStart) {
    const previousStartMinutes = CapBreaks.timeToMinutes(previousStart);
    const nextStartMinutes = CapBreaks.timeToMinutes(nextStart);
    if (previousStartMinutes === null || nextStartMinutes === null) return pause.startOffsetMinutes;
    let nextOffset = previousStartMinutes + pause.startOffsetMinutes - nextStartMinutes;
    while (nextOffset < 0) nextOffset += 1440;
    return nextOffset;
  }

  function recalculateEditorPauses(force = false) {
    const shift = editorShift();
    const amplitude = CapBreaks.calculateShiftAmplitude(shift.start, shift.end);
    if (!amplitude) {
      const hasManualPause = state.dayPauseDraft.some((pause) => pause.source === "manual" || pause.locked);
      if (hasManualPause) {
        state.dayPauseRequiresReset = true;
        state.dayPauseWarning = "Les horaires sont incomplets. Les pauses manuelles sont conservées jusqu’au prochain recalcul.";
      } else {
        state.dayPauseDraft = [];
        state.dayPauseRequiresReset = false;
        state.dayPauseWarning = "";
        state.dayPauseLastStart = shift.start;
        state.dayPauseLastEnd = shift.end;
      }
      return;
    }

    const automatic = CapBreaks.recalculateShiftPauses(shift);
    const manualPauses = state.dayPauseDraft.filter((pause) => pause.source === "manual" || pause.locked);
    const timesChanged = shift.start !== state.dayPauseLastStart || shift.end !== state.dayPauseLastEnd;
    if (force || !manualPauses.length || !timesChanged) {
      state.dayPauseDraft = automatic.pauses;
      state.dayPauseRequiresReset = !automatic.validationStatus.valid;
      state.dayPauseWarning = automatic.validationStatus.valid ? "" : automatic.validationStatus.message;
    } else {
      const previousRule = CapBreaks.getPauseRuleForAmplitude(CapBreaks.calculateShiftAmplitude(state.dayPauseLastStart, state.dayPauseLastEnd));
      if (previousRule !== automatic.pauseRuleCode) {
        state.dayPauseDraft = state.dayPauseDraft.map((pause) => {
          const startOffsetMinutes = translatePauseOffset(pause, state.dayPauseLastStart, shift.start);
          return { ...pause, startOffsetMinutes, endOffsetMinutes: startOffsetMinutes + pause.durationMinutes };
        });
        state.dayPauseRequiresReset = true;
        state.dayPauseWarning = `Le shift passe de ${previousRule || "sans pause"} à ${automatic.pauseRuleCode || "sans pause"}. Les pauses manuelles ont été conservées : lance un recalcul pour appliquer le nouveau régime.`;
      } else {
        const candidate = automatic.pauses.map((pause, index) => {
          const previous = state.dayPauseDraft[index];
          if (!previous || previous.type !== pause.type || (previous.source !== "manual" && !previous.locked)) return pause;
          const startOffsetMinutes = translatePauseOffset(previous, state.dayPauseLastStart, shift.start);
          return { ...pause, id: previous.id, startOffsetMinutes, endOffsetMinutes: startOffsetMinutes + pause.durationMinutes, source: "manual", locked: true };
        });
        const validation = CapBreaks.validateContinuousWorkLimit(shift, candidate);
        state.dayPauseDraft = candidate;
        state.dayPauseRequiresReset = !validation.valid;
        state.dayPauseWarning = validation.valid ? "Les pauses manuelles ont été conservées à leur heure verrouillée." : `${validation.message} Recalcule les pauses ou déplace-les manuellement.`;
      }
    }
    state.dayPauseLastStart = shift.start;
    state.dayPauseLastEnd = shift.end;
  }

  function renderPauseEditor(plan) {
    const amplitude = CapBreaks.calculateShiftAmplitude(plan.start, plan.end);
    const ruleCode = CapBreaks.getPauseRuleForAmplitude(amplitude);
    const totalMinutes = CapBreaks.calculateTotalPauseMinutes(state.dayPauseDraft);
    setText("shiftPauseRule", ruleCode || "Aucune");
    setText("shiftPauseTotal", totalMinutes ? formatDuration(totalMinutes) : "0 min");
    setText("shiftEffectiveDuration", amplitude ? formatDuration(Math.max(0, amplitude - totalMinutes)) : "--");

    $("shiftPauseList").innerHTML = state.dayPauseDraft.length ? state.dayPauseDraft.map((pause, index) => {
      const clock = CapBreaks.getPauseClock(pause, plan.start);
      const name = pause.type === "L" ? "Lunch" : "Break";
      const source = pause.source === "manual" || pause.locked ? "Manuelle · verrouillée" : "Automatique";
      return `<label class="pause-editor-row"><span class="pause-editor-type ${pause.type === "L" ? "lunch" : "break"}">${pause.type}</span><span class="pause-editor-copy"><strong>${name} — ${pause.durationMinutes} min</strong><small>${source}${clock.dayOffset > 0 ? " · lendemain" : ""}</small></span><input type="time" value="${clock.start}" data-pause-index="${index}" aria-label="Début de la pause ${pause.type}"></label>`;
    }).join("") : '<div class="empty-state compact-empty">Aucune pause accordée pour cette amplitude.</div>';

    const validationElement = $("shiftPauseValidation");
    validationElement.className = "pause-validation";
    if (!amplitude) {
      validationElement.textContent = "Renseigne deux horaires différents pour calculer les pauses.";
    } else if (state.dayPauseRequiresReset) {
      validationElement.classList.add("invalid");
      validationElement.textContent = state.dayPauseWarning || "Les pauses doivent être recalculées avant l’enregistrement.";
    } else {
      const validation = CapBreaks.validateContinuousWorkLimit(plan, state.dayPauseDraft);
      validationElement.classList.add(validation.valid ? "valid" : "invalid");
      validationElement.textContent = state.dayPauseWarning || (validation.valid
        ? `Conforme à la limite des 3 h 30 · plus longue période : ${formatDuration(validation.longestContinuousWorkMinutes)}.`
        : validation.message);
    }
    $("recalculatePauses").hidden = !amplitude || (!state.dayPauseDraft.length && !state.dayPauseRequiresReset);
  }

  function updateShiftDuration() {
    const plan = {
      worked: $("dayWorked").checked,
      start: $("shiftStart").value,
      end: $("shiftEnd").value,
      actualStart: $("actualStart").value,
      actualEnd: $("actualEnd").value,
      pauses: state.dayPauseDraft
    };
    setText("shiftDuration", formatDuration(shiftDurationMinutes(plan)));
    renderPauseEditor(plan);
    const payroll = CapPayroll.buildPayrollDay({ dateKey: $("dayEditDate").value, plan });
    setText("shiftPaidDuration", payroll.paidMinutes ? `${formatDuration(payroll.paidMinutes)} · pause ${payroll.breakMinutes} min · ${payroll.source === "actual" ? "badgeage" : "± 5 min"}` : "--");
    const roles = getShiftRoles(plan);
    const status = $("shiftAutoStatus");
    status.textContent = roles.length ? roles.join(" + ") : "STANDARD";
    status.classList.toggle("open", roles.includes("OPEN"));
    status.classList.toggle("close", roles.includes("CLOSE"));
  }

  function setManualPauseStart(index, value) {
    const pause = state.dayPauseDraft[index];
    const shift = editorShift();
    if (!pause || !isTime(value) || !isTime(shift.start) || !isTime(shift.end)) return;
    const startOffsetMinutes = CapBreaks.getOffsetForClock(value, shift.start);
    if (startOffsetMinutes === null) return;
    state.dayPauseDraft[index] = {
      ...pause,
      startOffsetMinutes,
      endOffsetMinutes: startOffsetMinutes + pause.durationMinutes,
      source: "manual",
      locked: true
    };
    const validation = CapBreaks.validateContinuousWorkLimit(shift, state.dayPauseDraft);
    state.dayPauseRequiresReset = !validation.valid;
    state.dayPauseWarning = validation.valid
      ? `Pause ${pause.type} verrouillée manuellement à ${value}.`
      : `${validation.message} Déplace la pause ou relance le calcul automatique.`;
    updateShiftDuration();
  }

  function openSettings() {
    $("contractNameInput").value = state.settings.name;
    $("contractStartInput").value = state.settings.start;
    $("contractEndInput").value = state.settings.end;
    document.querySelectorAll('input[name="restDay"]').forEach((input) => { input.checked = state.settings.restDays.includes(Number(input.value)); });
    setText("backupStatus", "");
    setText("shiftBackupStatus", "");
    openSheet($("settingsSheet"));
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    state.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600);
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getBackupPayload() {
    return {
      app: "cap-contrat", version: 4, savedAt: new Date().toISOString(), settings: state.settings,
      contract: { start: state.settings.start, end: state.settings.end, restDays: state.settings.restDays },
      milestones: state.milestones, payrollSettings: state.payrollSettings
    };
  }

  function exportBackup() {
    downloadJson(getBackupPayload(), `cap-contrat-sauvegarde-${toDateKey(new Date())}.json`);
    setText("backupStatus", "Sauvegarde générale exportée.");
  }

  function exportShifts() {
    const payload = {
      app: "cap-contrat-shifts", version: 4, savedAt: new Date().toISOString(),
      contract: { start: state.settings.start, end: state.settings.end }, shifts: state.shifts
    };
    downloadJson(payload, `cap-contrat-shifts-${toDateKey(new Date())}.json`);
    setText("shiftBackupStatus", `${Object.keys(state.shifts).length} journées exportées dans un fichier séparé.`);
  }

  async function importBackup(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const milestoneSource = Array.isArray(parsed) ? parsed : parsed.milestones;
      if (!Array.isArray(milestoneSource)) throw new Error("Aucun jalon trouvé");
      state.milestones = normalizeMilestones(milestoneSource);
      saveMilestones();
      if (!Array.isArray(parsed)) {
        const settingsSource = parsed.settings || (parsed.contract ? { ...parsed.contract, name: state.settings.name } : null);
        if (settingsSource) { state.settings = normalizeSettings({ ...state.settings, ...settingsSource }); saveSettings(); }
        if (parsed.payrollSettings && typeof parsed.payrollSettings === "object") {
          state.payrollSettings = Object.fromEntries(Object.entries(parsed.payrollSettings)
            .filter(([monthKey]) => /^\d{4}-\d{2}$/.test(monthKey))
            .map(([monthKey, value]) => [monthKey, normalizePayrollSettings(monthKey, value)]));
          savePayrollSettings();
        }
      }
      renderAll();
      setText("backupStatus", `${state.milestones.length} ${plural(state.milestones.length, "jalon")} restauré${state.milestones.length > 1 ? "s" : ""}.`);
      showToast("Sauvegarde restaurée avec succès");
    } catch (error) {
      setText("backupStatus", "Import impossible : fichier invalide ou incompatible.");
    }
  }

  async function importShifts(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed && parsed.shifts ? parsed.shifts : parsed;
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Planning absent");
      state.shifts = normalizeShifts(source);
      saveShifts();
      renderAll();
      setText("shiftBackupStatus", `${Object.keys(state.shifts).length} journées de planning restaurées.`);
      showToast("Planning des shifts restauré");
    } catch (error) {
      setText("shiftBackupStatus", "Import impossible : ce fichier ne contient pas de shifts valides.");
    }
  }

  function bindEvents() {
    document.querySelectorAll(".bottom-nav [data-view]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
    document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.go)));
    $("openSettings").addEventListener("click", openSettings);
    $("sheetBackdrop").addEventListener("click", closeSheets);
    document.querySelectorAll("[data-close-sheet]").forEach((button) => button.addEventListener("click", closeSheets));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSheets(); });

    $("calendarFilter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.calendarFilter = button.dataset.filter;
      document.querySelectorAll("#calendarFilter button").forEach((item) => item.classList.toggle("active", item === button));
      renderCalendar(getContractData());
    });
    $("calendarList").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });
    $("calendarMatrix").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });
    $("workMatrix").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });

    $("planningFilter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-planning-filter]");
      if (!button) return;
      state.planningFilter = button.dataset.planningFilter;
      document.querySelectorAll("#planningFilter button").forEach((item) => item.classList.toggle("active", item === button));
      renderPlanning(getContractData());
    });
    $("planningList").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });
    $("jumpTodayPlanning").addEventListener("click", () => {
      state.planningFilter = "all";
      document.querySelectorAll("#planningFilter button").forEach((button) => button.classList.toggle("active", button.dataset.planningFilter === "all"));
      renderPlanning(getContractData());
      requestAnimationFrame(() => {
        const target = document.querySelector("[data-planning-today]") || document.querySelector("[data-planning-anchor]") || $("planningList");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    $("hoursPeriod").addEventListener("change", (event) => { state.hoursPeriod = event.target.value; renderHours(getContractData()); });
    $("hoursBreakdown").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });
    ["payrollVariableStart", "payrollVariableEnd", "payrollOtherOrdinary", "payrollRecall", "payrollOfficialHs25", "payrollOfficialHs50", "payrollWithholdingRate"]
      .forEach((id) => $(id).addEventListener("change", updatePayrollSettingsFromForm));

    $("jumpCurrentMonth").addEventListener("click", () => {
      const data = getContractData();
      const target = document.querySelector(`[data-month="${data.today.getFullYear()}-${data.today.getMonth()}"]`) || $("calendarList").firstElementChild;
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    $("addMilestone").addEventListener("click", () => openMilestoneEditor());
    $("milestoneList").addEventListener("click", (event) => { const button = event.target.closest("[data-edit-milestone]"); if (button) openMilestoneEditor(button.dataset.editMilestone); });
    $("milestoneForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const id = $("milestoneEditId").value;
      const name = $("milestoneName").value.trim();
      const date = $("milestoneDate").value;
      const selectedColor = document.querySelector('input[name="milestoneColor"]:checked');
      if (!name || !isDateKey(date) || !selectedColor) return;
      const item = { id: id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, name: name.slice(0, 42), date, color: normalizeColor(selectedColor.value), important: $("milestoneImportant").checked };
      state.milestones = id ? state.milestones.map((milestone) => milestone.id === id ? item : milestone) : [...state.milestones, item];
      saveMilestones(); closeSheets(); renderAll(); showToast(id ? "Jalon mis à jour" : "Nouveau jalon ajouté");
    });
    $("deleteMilestone").addEventListener("click", () => {
      const id = $("milestoneEditId").value;
      const item = state.milestones.find((milestone) => milestone.id === id);
      if (!item || !window.confirm(`Supprimer le jalon « ${item.name} » ?`)) return;
      state.milestones = state.milestones.filter((milestone) => milestone.id !== id);
      saveMilestones(); closeSheets(); renderAll(); showToast("Jalon supprimé");
    });

    $("dayWorked").addEventListener("change", updateDayFormState);
    ["shiftStart", "shiftEnd"].forEach((id) => $(id).addEventListener("input", () => {
      recalculateEditorPauses();
      updateShiftDuration();
    }));
    ["actualStart", "actualEnd"].forEach((id) => $(id).addEventListener("input", updateShiftDuration));
    $("shiftPauseList").addEventListener("input", (event) => {
      const input = event.target.closest("[data-pause-index]");
      if (input) setManualPauseStart(Number(input.dataset.pauseIndex), input.value);
    });
    $("recalculatePauses").addEventListener("click", () => {
      recalculateEditorPauses(true);
      updateShiftDuration();
      showToast("Toutes les pauses ont été recalculées automatiquement");
    });
    $("dayForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const date = $("dayEditDate").value;
      if (!isDateKey(date)) return;
      const attraction = document.querySelector('input[name="attraction"]:checked');
      const worked = $("dayWorked").checked;
      const start = isTime($("shiftStart").value) ? $("shiftStart").value : "";
      const end = isTime($("shiftEnd").value) ? $("shiftEnd").value : "";
      let pauses = [];
      let pauseRuleCode = "";
      let pauseValidation = emptyPauseData().validationStatus;
      if (worked && start && end) {
        const amplitude = CapBreaks.calculateShiftAmplitude(start, end);
        if (!amplitude) { showToast("Le début et la fin du shift doivent être différents"); return; }
        const shift = { id: date, dateKey: date, start, end };
        pauseValidation = CapBreaks.validateContinuousWorkLimit(shift, state.dayPauseDraft);
        if (state.dayPauseRequiresReset || !pauseValidation.valid) {
          showToast(pauseValidation.message || "Recalcule les pauses avant d’enregistrer");
          return;
        }
        pauses = CapBreaks.normalizePauses(state.dayPauseDraft, shift);
        pauseRuleCode = CapBreaks.getPauseRuleForAmplitude(amplitude);
      }
      state.shifts[date] = {
        worked,
        start,
        end,
        actualStart: isTime($("actualStart").value) ? $("actualStart").value : "",
        actualEnd: isTime($("actualEnd").value) ? $("actualEnd").value : "",
        pauses,
        pauseRuleCode,
        pauseValidation,
        attraction: attraction && (attraction.value === "HSM" || attraction.value === "STT") ? attraction.value : "",
        provisional: worked && $("dayProvisional").checked,
        note: $("shiftNote").value.trim().slice(0, 100)
      };
      saveShifts(); closeSheets(); renderAll(); showToast("Journée enregistrée dans le planning");
    });
    $("resetDay").addEventListener("click", () => {
      const date = $("dayEditDate").value;
      if (!isDateKey(date)) return;
      delete state.shifts[date];
      saveShifts(); closeSheets(); renderAll(); showToast("Planning par défaut rétabli");
    });

    $("trophyFilter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-trophy-filter]");
      if (!button) return;
      state.trophyFilter = button.dataset.trophyFilter;
      document.querySelectorAll("#trophyFilter button").forEach((item) => item.classList.toggle("active", item === button));
      renderTrophies(getContractData());
    });

    $("settingsForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const start = $("contractStartInput").value;
      const end = $("contractEndInput").value;
      const restDays = [...document.querySelectorAll('input[name="restDay"]:checked')].map((input) => Number(input.value));
      if (!isDateKey(start) || !isDateKey(end) || end < start) { showToast("La date de fin doit suivre la date de début"); return; }
      if (restDays.length === 7) { showToast("Il faut conserver au moins un jour travaillé"); return; }
      state.settings = normalizeSettings({ name: $("contractNameInput").value, start, end, restDays });
      saveSettings(); closeSheets(); renderAll(); showToast("Réglages enregistrés");
    });

    $("exportBackup").addEventListener("click", exportBackup);
    $("importBackup").addEventListener("click", () => $("backupFile").click());
    $("backupFile").addEventListener("change", async (event) => { const file = event.target.files && event.target.files[0]; if (file) await importBackup(file); event.target.value = ""; });
    $("exportShifts").addEventListener("click", exportShifts);
    $("importShifts").addEventListener("click", () => $("shiftBackupFile").click());
    $("shiftBackupFile").addEventListener("change", async (event) => { const file = event.target.files && event.target.files[0]; if (file) await importShifts(file); event.target.value = ""; });
  }

  createFormOptions();
  bindEvents();
  renderAll();
  setInterval(() => {
    if (state.activeView === "home") renderHome(getContractData());
  }, 1000);
}());
