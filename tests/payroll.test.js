"use strict";

const assert = require("node:assert/strict");
const payroll = require("../payroll.js");

function day(dateKey, plan) {
  return payroll.buildPayrollDay({ dateKey, plan: { worked: true, ...plan } });
}

assert.equal(payroll.automaticBreakMinutes(289), 0);
assert.equal(payroll.automaticBreakMinutes(290), 15);
assert.equal(payroll.automaticBreakMinutes(359), 15);
assert.equal(payroll.automaticBreakMinutes(360), 30);
assert.equal(payroll.automaticBreakMinutes(374), 30);
assert.equal(payroll.automaticBreakMinutes(375), 45);
assert.equal(payroll.automaticBreakMinutes(434), 45);
assert.equal(payroll.automaticBreakMinutes(435), 60);
assert.equal(payroll.automaticBreakMinutes(554), 60);
assert.equal(payroll.automaticBreakMinutes(555), 75);

const example = day("2026-06-01", { start: "15:35", end: "23:25" });
assert.deepEqual(
  {
    source: example.source,
    amplitudeMinutes: example.amplitudeMinutes,
    breakMinutes: example.breakMinutes,
    paidMinutes: example.paidMinutes,
    nightMinutes: example.nightMinutes,
    longMinutes: example.longMinutes
  },
  { source: "planned", amplitudeMinutes: 480, breakMinutes: 60, paidMinutes: 420, nightMinutes: 90, longMinutes: 0 }
);

const actual = day("2026-06-02", {
  start: "15:35", end: "23:25", actualStart: "15:40", actualEnd: "23:20"
});
assert.equal(actual.source, "actual");
assert.equal(actual.amplitudeMinutes, 460);
assert.equal(actual.paidMinutes, 400);
assert.equal(actual.nightMinutes, 80);

const overnight = day("2026-06-03", { start: "22:55", end: "06:55" });
assert.equal(overnight.amplitudeMinutes, 490);
assert.equal(overnight.breakMinutes, 60);
assert.equal(overnight.nightBreakMinutes, 60);
assert.equal(overnight.paidMinutes, 430);
assert.equal(overnight.nightMinutes, 430);

const nightPause = day("2026-06-04", {
  start: "15:35", end: "23:25", breakMinutes: 60, nightBreakMinutes: 15
});
assert.equal(nightPause.nightMinutes, 75);

const overtimeDays = Array.from({ length: 6 }, (_, index) => ({
  dateKey: `2026-06-0${index + 1}`,
  paidMinutes: 480,
  nightMinutes: 0,
  longMinutes: 60,
  source: "actual"
}));
const allocated = payroll.allocateWeeklyOvertime(overtimeDays);
assert.equal(allocated.reduce((sum, item) => sum + item.hs25Minutes, 0), 480);
assert.equal(allocated.reduce((sum, item) => sum + item.hs50Minutes, 0), 300);

assert.deepEqual(payroll.defaultVariablePeriod("2026-06"), { start: "2026-05-03", end: "2026-06-06" });

const estimate = payroll.estimateMonthlyPay([example], { monthKey: "2026-06" });
assert.equal(estimate.lines.fixed, 1893);
assert.equal(estimate.lines.night, 6.18);
assert.equal(estimate.lines.dressing, 3.12);
assert.equal(estimate.lines.longDay, 0);
assert.equal(estimate.grossTotal, 1902.30);
assert.equal(estimate.tax, 0);
assert.equal(estimate.netPaid, estimate.netBeforeTax);

const official = payroll.estimateMonthlyPay(overtimeDays, {
  monthKey: "2026-06",
  officialHs25Minutes: 60,
  officialHs50Minutes: 30
});
assert.equal(official.usesOfficialOvertime, true);
assert.equal(official.hs25Minutes, 60);
assert.equal(official.hs50Minutes, 30);
assert.equal(official.lines.hs25, 15.60);
assert.equal(official.lines.hs50, 9.36);

console.log("Payroll tests: OK");
