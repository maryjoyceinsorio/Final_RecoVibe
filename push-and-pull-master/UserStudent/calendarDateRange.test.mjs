import assert from "node:assert/strict";
import test from "node:test";
import {
  clampEventDateRangeToGrid,
  getEventDateRange,
} from "./calendarDateRange.mjs";

function manilaDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function assertRange(event, expectedStart, expectedEnd) {
  const range = getEventDateRange(event);
  assert.ok(range);
  assert.ok(range.start instanceof Date);
  assert.ok(range.end instanceof Date);
  assert.equal(manilaDateKey(range.start), expectedStart);
  assert.equal(manilaDateKey(range.end), expectedEnd);
}

test("keeps a single-day event on its event date", () => {
  assertRange(
    { date: "2026-11-10", startTime: "08:00 AM", endTime: "12:00 PM" },
    "2026-11-10",
    "2026-11-10",
  );
});

test("places an overnight time range on the next day", () => {
  assertRange(
    { date: "2026-11-10", startTime: "08:00 PM", endTime: "02:00 AM" },
    "2026-11-10",
    "2026-11-11",
  );
});

test("preserves an explicitly multi-day event", () => {
  assertRange(
    { startDate: "2026-12-01", endDate: "2026-12-03" },
    "2026-12-01",
    "2026-12-03",
  );
});

test("defaults a missing end date to the start date", () => {
  assertRange(
    {
      date: "2026-11-10",
      registrationDeadline: "2026-11-30",
      createdAt: "2026-11-09T10:00:00Z",
      recurrence: { endDate: "2026-11-30" },
    },
    "2026-11-10",
    "2026-11-10",
  );
});

test("defaults an invalid end date to the start date", () => {
  const range = getEventDateRange({
    date: "2026-11-10",
    startTime: "08:00 AM",
    endTime: "12:00 PM",
    endDate: "not-a-date",
  });
  assert.ok(range);
  assert.equal(range.end.getTime(), range.start.getTime());
});

test("combines a time-only end value with the start date", () => {
  assertRange(
    { date: "2026-11-10", startTime: "08:00 AM", endDate: "10:00 AM" },
    "2026-11-10",
    "2026-11-10",
  );
});

test("parses six Firestore event payloads with dateISO and combined startAt strings", () => {
  const eventDates = [
    ["2026-11-03", "2026-11-03"],
    ["2026-11-07", "2026-11-07"],
    ["2026-11-10", "2026-11-10"],
    ["2026-11-12", "2026-11-12"],
    ["2026-11-18", "2026-11-18"],
    ["2026-11-25", "2026-11-25"],
  ];
  eventDates.forEach(([date, expectedDate]) => {
    assertRange({
      date,
      dateISO: date,
      dateStart: date,
      dateEnd: date,
      endDate: date,
      timeStart: "08:00 AM",
      timeEnd: "10:00 AM",
      startAt: `${date} 08:00 AM`,
      endAt: `${date} 10:00 AM`,
    }, expectedDate, expectedDate);
  });
});

test("supports start and end aliases and Firestore Timestamp values", () => {
  assertRange(
    {
      start: { seconds: Date.parse("2026-11-10T00:00:00Z") / 1000 },
      end: { toDate: () => new Date("2026-11-12T00:00:00Z") },
    },
    "2026-11-10",
    "2026-11-12",
  );
});

test("reads times from combined startAt and endAt strings", () => {
  const range = getEventDateRange({
    startAt: "2026-11-10 08:00 AM",
    endAt: "2026-11-10 11:30 AM",
  });
  assert.ok(range);
  assert.equal(range.end.getTime() - range.start.getTime(), 3.5 * 60 * 60 * 1000);
});

test("preserves event ranges longer than fourteen calendar days", () => {
  assertRange(
    { startDate: "2026-11-01", endDate: "2026-12-01" },
    "2026-11-01",
    "2026-12-01",
  );
});

test("clips a long event to the visible calendar grid", () => {
  const range = getEventDateRange({
    startDate: "2026-11-10",
    endDate: "2026-12-31",
  });
  assert.ok(range);
  assert.deepEqual(
    clampEventDateRangeToGrid(range, "2026-11-01", "2026-12-05"),
    { start: "2026-11-10", end: "2026-12-05" },
  );
});

test("limits the visible portion of a long event to the 42-cell maximum", () => {
  const range = getEventDateRange({
    startDate: "2026-01-01",
    endDate: "2026-12-31",
  });
  assert.ok(range);
  const visibleRange = clampEventDateRangeToGrid(
    range,
    "2026-07-26",
    "2026-09-05",
  );
  assert.ok(visibleRange);
  const visibleDays =
    (Date.parse(`${visibleRange.end}T00:00:00Z`) -
      Date.parse(`${visibleRange.start}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000) +
    1;
  assert.equal(visibleDays, 42);
});

test("excludes events outside the visible calendar grid", () => {
  const range = getEventDateRange({
    startDate: "2026-10-01",
    endDate: "2026-10-31",
  });
  assert.ok(range);
  assert.equal(clampEventDateRangeToGrid(range, "2026-11-01", "2026-12-05"), null);
});
