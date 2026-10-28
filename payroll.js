(function (root, factory) {
  "use strict";
  const breaks = typeof module === "object" && module.exports ? require("./breaks.js") : root && root.CapBreaks;
  const api = factory(breaks);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CapPayroll = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function (CapBreaks) {
  "use strict";

  const CONSTANTS = Object.freeze({
    monthlyGross: 1893,
    theoreticalMonthlyHours: 151.67,
    referenceHourlyGross: 12.4804,
    weeklyMinutes: 2100,
    dressingPerDay: 3.12,
    nightHourly: 4.118,
    longDayHourly: 6.240,
    overtime25Hourly: 15.601,
    overtime50Hourly: 18.721,
    ordinaryNetCoefficient: 0.758828,
    overtimeNetCoefficient: 0.933156,
    ordinaryFiscalNetCoefficient: 0.816675,
    withholdingRate: 0
  });

  function isTime(value) {
    return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  }

  function timeToMinutes(value) {
    if (!isTime(value)) return null;
    const parts = value.split(":").map(Number);
    return parts[0] * 60 + parts[1];
  }

  function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function toOptionalMinutes(value) {
    if (value === "" || value === null || typeof value === "undefined") return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
  }

  function roundMoney(value) {
    return Math.round((toFiniteNumber(value) + Number.EPSILON) * 100) / 100;
  }

  function automaticBreakMinutes(amplitudeMinutes) {
    if (!CapBreaks || amplitudeMinutes <= 0) return 0;
    const code = CapBreaks.getPauseRuleForAmplitude(amplitudeMinutes);
    return CapBreaks.calculateTotalPauseMinutes(CapBreaks.getPauseDefinitions(code));
  }

  function resolveWorkInterval(plan) {
    if (!plan || !plan.worked) return null;
    const hasActual = isTime(plan.actualStart) && isTime(plan.actualEnd);
    const startValue = hasActual ? plan.actualStart : plan.start;
    const endValue = hasActual ? plan.actualEnd : plan.end;
    if (!isTime(startValue) || !isTime(endValue)) return null;
    const rawStart = timeToMinutes(startValue);
    let rawEnd = timeToMinutes(endValue);
    if (rawStart === rawEnd) return null;
    if (rawEnd < rawStart) rawEnd += 1440;
    const padding = hasActual ? 0 : 5;
    return {
      source: hasActual ? "actual" : "planned",
      start: rawStart - padding,
      end: rawEnd + padding,
      startValue,
      endValue
    };
  }

  function overlap(startA, endA, startB, endB) {
    return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
  }

  function nightOverlapMinutes(start, end) {
    let minutes = 0;
    for (let day = -1; day <= 2; day += 1) {
      const midnight = day * 1440;
      minutes += overlap(start, end, midnight, midnight + 420);
      minutes += overlap(start, end, midnight + 1320, midnight + 1440);
    }
    return minutes;
  }

  function getStructuredPauseIntervals(plan) {
    if (!CapBreaks || !isTime(plan.start) || !isTime(plan.end)) return [];
    let pauses = Array.isArray(plan.pauses) ? CapBreaks.normalizePauses(plan.pauses, plan) : null;
    if (pauses === null && toOptionalMinutes(plan.breakMinutes) === null) {
      pauses = CapBreaks.recalculateShiftPauses({ id: "payroll", start: plan.start, end: plan.end }).pauses;
    }
    if (!pauses) return [];
    const plannedStart = timeToMinutes(plan.start);
    return pauses.map((pause) => ({
      start: plannedStart + pause.startOffsetMinutes,
      end: plannedStart + pause.endOffsetMinutes
    }));
  }

  function calculateRecordedBreaks(plan, interval) {
    const pauseIntervals = getStructuredPauseIntervals(plan);
    if (!pauseIntervals.length) {
      const manualBreak = toOptionalMinutes(plan.breakMinutes);
      const rawAmplitude = CapBreaks && isTime(plan.start) && isTime(plan.end)
        ? CapBreaks.calculateShiftAmplitude(plan.start, plan.end)
        : interval.end - interval.start;
      return {
        breakMinutes: manualBreak === null ? automaticBreakMinutes(rawAmplitude) : manualBreak,
        nightBreakMinutes: Math.max(0, toOptionalMinutes(plan.nightBreakMinutes) || 0)
      };
    }

    return pauseIntervals.reduce((totals, pause) => {
      const start = Math.max(interval.start, pause.start);
      const end = Math.min(interval.end, pause.end);
      if (end <= start) return totals;
      totals.breakMinutes += end - start;
      totals.nightBreakMinutes += nightOverlapMinutes(start, end);
      return totals;
    }, { breakMinutes: 0, nightBreakMinutes: 0 });
  }

  function buildPayrollDay(record) {
    const plan = record && record.plan ? record.plan : {};
    const interval = resolveWorkInterval(plan);
    const empty = {
      dateKey: record && record.dateKey ? record.dateKey : "",
      source: "none",
      amplitudeMinutes: 0,
      breakMinutes: 0,
      nightBreakMinutes: 0,
      paidMinutes: 0,
      nightMinutes: 0,
      longMinutes: 0,
      worked: false
    };
    if (!interval) return empty;

    const amplitudeMinutes = Math.max(0, interval.end - interval.start);
    const recordedBreaks = calculateRecordedBreaks(plan, interval);
    const breakMinutes = Math.min(amplitudeMinutes, recordedBreaks.breakMinutes);
    const nightBreakMinutes = Math.min(
      breakMinutes,
      Math.max(0, recordedBreaks.nightBreakMinutes)
    );
    const paidMinutes = Math.max(0, amplitudeMinutes - breakMinutes);
    const nightMinutes = Math.min(
      paidMinutes,
      Math.max(0, nightOverlapMinutes(interval.start, interval.end) - nightBreakMinutes)
    );

    return {
      dateKey: record && record.dateKey ? record.dateKey : "",
      source: interval.source,
      amplitudeMinutes,
      breakMinutes,
      nightBreakMinutes,
      paidMinutes,
      nightMinutes,
      longMinutes: Math.max(0, paidMinutes - 420),
      worked: paidMinutes > 0
    };
  }

  function mondayKey(dateKey) {
    const date = new Date(`${dateKey}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return "";
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return date.toISOString().slice(0, 10);
  }

  function allocateWeeklyOvertime(days) {
    const sorted = [...days].filter((day) => day.dateKey && day.paidMinutes > 0).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    const weekState = new Map();
    return sorted.map((day) => {
      const weekKey = mondayKey(day.dateKey);
      const current = weekState.get(weekKey) || { paid: 0, overtime: 0 };
      const beforeOvertime = Math.max(0, current.paid - CONSTANTS.weeklyMinutes);
      const afterPaid = current.paid + day.paidMinutes;
      const afterOvertime = Math.max(0, afterPaid - CONSTANTS.weeklyMinutes);
      const dailyOvertime = afterOvertime - beforeOvertime;
      const hs25Minutes = Math.min(dailyOvertime, Math.max(0, 480 - current.overtime));
      const hs50Minutes = Math.max(0, dailyOvertime - hs25Minutes);
      weekState.set(weekKey, { paid: afterPaid, overtime: afterOvertime });
      return { ...day, weekKey, hs25Minutes, hs50Minutes };
    });
  }

  function monthBounds(monthKey) {
    if (!/^\d{4}-\d{2}$/.test(String(monthKey))) return null;
    const year = Number(monthKey.slice(0, 4));
    const month = Number(monthKey.slice(5, 7));
    if (month < 1 || month > 12) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { start: `${monthKey}-01`, end: `${monthKey}-${String(lastDay).padStart(2, "0")}` };
  }

  function defaultVariablePeriod(monthKey) {
    if (monthKey === "2026-06") return { start: "2026-05-03", end: "2026-06-06" };
    return monthBounds(monthKey);
  }

  function estimateMonthlyPay(records, options) {
    const settings = options || {};
    const fallbackPeriod = defaultVariablePeriod(settings.monthKey);
    if (!fallbackPeriod) return null;
    const variableStart = /^\d{4}-\d{2}-\d{2}$/.test(String(settings.variableStart)) ? settings.variableStart : fallbackPeriod.start;
    const variableEndCandidate = /^\d{4}-\d{2}-\d{2}$/.test(String(settings.variableEnd)) ? settings.variableEnd : fallbackPeriod.end;
    const variableEnd = variableEndCandidate >= variableStart ? variableEndCandidate : variableStart;
    const days = records.map((record) => record && typeof record.paidMinutes === "number" ? record : buildPayrollDay(record));
    const allocated = allocateWeeklyOvertime(days);
    const variableDays = allocated.filter((day) => day.dateKey >= variableStart && day.dateKey <= variableEnd && day.paidMinutes > 0);

    const paidMinutes = variableDays.reduce((sum, day) => sum + day.paidMinutes, 0);
    const nightMinutes = variableDays.reduce((sum, day) => sum + day.nightMinutes, 0);
    const longMinutes = variableDays.reduce((sum, day) => sum + day.longMinutes, 0);
    const inferredHs25Minutes = variableDays.reduce((sum, day) => sum + day.hs25Minutes, 0);
    const inferredHs50Minutes = variableDays.reduce((sum, day) => sum + day.hs50Minutes, 0);
    const officialHs25 = toOptionalMinutes(settings.officialHs25Minutes);
    const officialHs50 = toOptionalMinutes(settings.officialHs50Minutes);
    const usesOfficialOvertime = officialHs25 !== null || officialHs50 !== null;
    const hs25Minutes = usesOfficialOvertime ? (officialHs25 || 0) : inferredHs25Minutes;
    const hs50Minutes = usesOfficialOvertime ? (officialHs50 || 0) : inferredHs50Minutes;

    const lines = {
      fixed: roundMoney(CONSTANTS.monthlyGross),
      night: roundMoney(nightMinutes / 60 * CONSTANTS.nightHourly),
      dressing: roundMoney(variableDays.length * CONSTANTS.dressingPerDay),
      longDay: roundMoney(longMinutes / 60 * CONSTANTS.longDayHourly),
      otherOrdinary: roundMoney(Math.max(0, toFiniteNumber(settings.otherOrdinary))),
      recall: roundMoney(Math.max(0, toFiniteNumber(settings.recall))),
      hs25: roundMoney(hs25Minutes / 60 * CONSTANTS.overtime25Hourly),
      hs50: roundMoney(hs50Minutes / 60 * CONSTANTS.overtime50Hourly)
    };
    const ordinaryGross = roundMoney(lines.fixed + lines.night + lines.dressing + lines.longDay + lines.otherOrdinary + lines.recall);
    const overtimeGross = roundMoney(lines.hs25 + lines.hs50);
    const grossTotal = roundMoney(ordinaryGross + overtimeGross);
    const netOrdinary = roundMoney(ordinaryGross * CONSTANTS.ordinaryNetCoefficient);
    const netOvertime = roundMoney(overtimeGross * CONSTANTS.overtimeNetCoefficient);
    const netBeforeTax = roundMoney(netOrdinary + netOvertime);
    const fiscalNet = roundMoney(ordinaryGross * CONSTANTS.ordinaryFiscalNetCoefficient);
    const withholdingRate = Math.max(0, Math.min(1, toFiniteNumber(settings.withholdingRate, CONSTANTS.withholdingRate)));
    const tax = roundMoney(fiscalNet * withholdingRate);
    const netPaid = roundMoney(netBeforeTax - tax);

    return {
      monthKey: settings.monthKey,
      variableStart,
      variableEnd,
      days: variableDays,
      paidMinutes,
      nightMinutes,
      longMinutes,
      workedDays: variableDays.length,
      hs25Minutes,
      hs50Minutes,
      inferredHs25Minutes,
      inferredHs50Minutes,
      usesOfficialOvertime,
      lines,
      ordinaryGross,
      overtimeGross,
      grossTotal,
      netOrdinary,
      netOvertime,
      netBeforeTax,
      fiscalNet,
      withholdingRate,
      tax,
      netPaid
    };
  }

  return {
    CONSTANTS,
    isTime,
    timeToMinutes,
    automaticBreakMinutes,
    resolveWorkInterval,
    nightOverlapMinutes,
    buildPayrollDay,
    mondayKey,
    allocateWeeklyOvertime,
    monthBounds,
    defaultVariablePeriod,
    estimateMonthlyPay,
    roundMoney
  };
}));
