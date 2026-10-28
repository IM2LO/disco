(function () {
  "use strict";

  const PAYROLL_STORAGE_KEY = "disco1-payroll-settings-v1";
  const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const DAY_MS = 86400000;
  const SHIFT_STORAGE_KEY = "disco1-shifts-v1";
  const SETTINGS_STORAGE_KEY = "disco1-settings-v1";
  const OPEN_STARTS = new Set(["06:35", "07:50"]);
  const CLOSE_ENDS = new Set(["22:40", "23:25"]);

  const DEFAULT_SETTINGS = {
    name: "Disco1",
    start: "2026-05-14",
    end: "2026-11-01",
    restDays: [3, 4]
  };

  const WEEKDAY_SHORT = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const longDate = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
  const monthOnly = new Intl.DateTimeFormat("fr-FR", { month: "long" });
  const monthYear = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

  const state = {
    activeView: "planning",
    hoursPeriod: "all",
    payrollSettings: loadPayrollSettings(),
    planningFilter: "all",
    settings: loadSettings(),
    shifts: loadShifts(),
    dayPauseDraft: [],
    dayPauseLastStart: "",
    dayPauseLastEnd: "",
    dayPauseRequiresReset: false,
    dayPauseWarning: "",
    toastTimer: null
  };

  const $ = (id) => document.getElementById(id);
  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

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

  function savePayrollSettings() { localStorage.setItem(PAYROLL_STORAGE_KEY, JSON.stringify(state.payrollSettings)); }

  function formatMoney(value) { return euro.format(Number(value) || 0); }

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

  function safeJsonParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (error) { return fallback; }
  }


  function loadSettings() {
    const saved = safeJsonParse(localStorage.getItem(SETTINGS_STORAGE_KEY), {});
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  }


  function normalizeSettings(value) {
    const start = isDateKey(value.start) ? value.start : DEFAULT_SETTINGS.start;
    const end = isDateKey(value.end) && value.end >= start ? value.end : (start > DEFAULT_SETTINGS.end ? start : DEFAULT_SETTINGS.end);
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


  function saveSettings() { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings)); }

  function saveShifts() { localStorage.setItem(SHIFT_STORAGE_KEY, JSON.stringify(state.shifts)); }

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


  function addDays(date, amount) { const result = new Date(date); result.setDate(result.getDate() + amount); return result; }

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


  function setText(id, text) { const element = $(id); if (element) element.textContent = text; }

  function plural(value, singular, pluralForm = `${singular}s`) { return value > 1 ? pluralForm : singular; }

  function capitalize(value) { return value ? value.charAt(0).toUpperCase() + value.slice(1) : value; }


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


  function openSheet(sheet) { $("sheetBackdrop").hidden = false; sheet.hidden = false; document.body.style.overflow = "hidden"; }

  function closeSheets() { $("sheetBackdrop").hidden = true; document.querySelectorAll(".bottom-sheet").forEach((sheet) => { sheet.hidden = true; }); document.body.style.overflow = ""; }


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
    $("contractStartInput").value = state.settings.start;
    $("contractEndInput").value = state.settings.end;
    document.querySelectorAll('input[name="restDay"]').forEach((input) => { input.checked = state.settings.restDays.includes(Number(input.value)); });
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


  function exportShifts() {
    const payload = {
      app: "disco1-shifts", version: 4, savedAt: new Date().toISOString(),
      contract: { start: state.settings.start, end: state.settings.end, restDays: state.settings.restDays }, payrollSettings: state.payrollSettings, shifts: state.shifts
    };
    downloadJson(payload, `disco1-shifts-${toDateKey(new Date())}.json`);
    setText("shiftBackupStatus", `${Object.keys(state.shifts).length} journées exportées dans un fichier séparé.`);
  }


  async function importShifts(file) {
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed && parsed.shifts ? parsed.shifts : parsed;
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Planning absent");
      const normalized = normalizeShifts(source);
      if (Object.keys(source).length && !Object.keys(normalized).length) throw new Error("Planning invalide");
      if (Object.keys(state.shifts).length && !window.confirm("Remplacer le planning actuel par ce fichier ?")) return;
      state.shifts = normalized;
      if (parsed.payrollSettings && typeof parsed.payrollSettings === "object" && !Array.isArray(parsed.payrollSettings)) {
        state.payrollSettings = Object.fromEntries(Object.entries(parsed.payrollSettings).filter(([key]) => /^\d{4}-\d{2}$/.test(key)).map(([key, value]) => [key, normalizePayrollSettings(key, value || {})]));
        savePayrollSettings();
      }
      if (parsed.contract && isDateKey(parsed.contract.start) && isDateKey(parsed.contract.end) && parsed.contract.end >= parsed.contract.start) {
        state.settings = normalizeSettings({ ...state.settings, ...parsed.contract, name: "Disco1" });
        saveSettings();
      }
      saveShifts();
      renderAll();
      setText("shiftBackupStatus", `${Object.keys(state.shifts).length} journées de planning restaurées.`);
      showToast("Planning des shifts restauré");
    } catch (error) {
      setText("shiftBackupStatus", "Import impossible : ce fichier ne contient pas de shifts valides.");
    }
  }


  function bindEvents() {
    document.querySelectorAll('[data-view], [data-go]').forEach(button => button.addEventListener('click', () => {
      state.activeView = button.dataset.view || button.dataset.go;
      document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-' + state.activeView));
      document.querySelectorAll('.bottom-nav button').forEach(item => item.classList.toggle('active', item.dataset.view === state.activeView));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    $("hoursPeriod").addEventListener("change", event => { state.hoursPeriod = event.target.value; renderHours(getContractData()); });
    $("hoursBreakdown").addEventListener("click", event => { const button = event.target.closest("[data-edit-day]"); if (button) openDayEditor(button.dataset.editDay); });
    ["payrollVariableStart", "payrollVariableEnd", "payrollOtherOrdinary", "payrollRecall", "payrollOfficialHs25", "payrollOfficialHs50", "payrollWithholdingRate"].forEach(id => $(id).addEventListener("change", updatePayrollSettingsFromForm));
    ["actualStart", "actualEnd"].forEach(id => $(id).addEventListener("input", updateShiftDuration));
    $("openSettings").addEventListener("click", openSettings);
    $("sheetBackdrop").addEventListener("click", closeSheets);
    document.querySelectorAll("[data-close-sheet]").forEach((button) => button.addEventListener("click", closeSheets));
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeSheets(); });

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
    $("dayWorked").addEventListener("change", updateDayFormState);
    ["shiftStart", "shiftEnd"].forEach((id) => $(id).addEventListener("input", () => {
      recalculateEditorPauses();
      updateShiftDuration();
    }));
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
        actualStart: isTime($("actualStart").value) ? $("actualStart").value : "",
        actualEnd: isTime($("actualEnd").value) ? $("actualEnd").value : "",
        worked,
        start,
        end,
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

    $("settingsForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const start = $("contractStartInput").value;
      const end = $("contractEndInput").value;
      const restDays = [...document.querySelectorAll('input[name="restDay"]:checked')].map((input) => Number(input.value));
      if (!isDateKey(start) || !isDateKey(end) || end < start) { showToast("La date de fin doit suivre la date de début"); return; }
      if (restDays.length === 7) { showToast("Il faut conserver au moins un jour travaillé"); return; }
      state.settings = normalizeSettings({ name: "Disco1", start, end, restDays });
      saveSettings(); closeSheets(); renderAll(); showToast("Réglages enregistrés");
    });

    $("exportShifts").addEventListener("click", exportShifts);
    $("importShifts").addEventListener("click", () => $("shiftBackupFile").click());
    $("shiftBackupFile").addEventListener("change", async (event) => { const file = event.target.files && event.target.files[0]; if (file) await importShifts(file); event.target.value = ""; });
  }

  function getContractData(now = new Date()) {
    const today = parseDateKey(toDateKey(now));
    const allDays = [];
    for (let day = parseDateKey(state.settings.start); day <= parseDateKey(state.settings.end); day = addDays(day, 1)) allDays.push(day);
    const workDays = allDays.filter(isPlannedWorkDay);
    return { today, allDays, workDays, planning: getPlanningStats(workDays) };
  }
  function renderAll() {
    setText("headerDate", capitalize(longDate.format(new Date())));
    renderPlanning(getContractData());
    renderHours(getContractData());
  }
  function createFormOptions() {
    $("restDayOptions").innerHTML = WEEKDAY_ORDER.map((day) => `<label class="rest-option"><input type="checkbox" name="restDay" value="${day}"><span>${WEEKDAY_SHORT[day]}</span></label>`).join("");
  }
  createFormOptions();
  bindEvents();
  renderAll();
}());
