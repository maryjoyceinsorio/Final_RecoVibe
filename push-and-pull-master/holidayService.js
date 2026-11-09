const CALENDAR_ID = "en.philippines#holiday@group.v.calendar.google.com";
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const holidayCache = new Map();
const monthHolidayCache = new Map();
const CHINESE_NEW_YEAR_DATES = {
  2024: "2024-02-10",
  2025: "2025-01-29",
  2026: "2026-02-17",
  2027: "2027-02-06",
  2028: "2028-01-26",
  2029: "2029-02-13",
  2030: "2030-02-03",
};

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function lastMondayOfAugust(year) {
  const date = new Date(Date.UTC(year, 8, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}

function buildStaticHolidayDataset(startYear = 2000, endYear = 2100) {
  const holidays = [];
  const add = (year, month, day, title) => {
    holidays.push({
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      title,
      category: "Holiday",
    });
  };

  for (let year = startYear; year <= endYear; year += 1) {
    add(year, 1, 1, "New Year's Day");
    add(year, 2, 25, "EDSA People Power Revolution Anniversary");
    add(year, 4, 9, "Araw ng Kagitingan");
    add(year, 5, 1, "Labor Day");
    add(year, 6, 12, "Independence Day");
    add(year, 8, 21, "Ninoy Aquino Day");
    holidays.push({
      date: isoDate(lastMondayOfAugust(year)),
      title: "National Heroes Day",
      category: "Holiday",
    });
    add(year, 11, 1, "All Saints' Day");
    add(year, 11, 30, "Bonifacio Day");
    add(year, 12, 8, "Feast of the Immaculate Conception");
    add(year, 12, 25, "Christmas Day");
    add(year, 12, 30, "Rizal Day");
    add(year, 12, 31, "Last Day of the Year");

    const easter = easterSunday(year);
    const maundyThursday = new Date(easter);
    maundyThursday.setUTCDate(easter.getUTCDate() - 3);
    const goodFriday = new Date(easter);
    goodFriday.setUTCDate(easter.getUTCDate() - 2);
    const blackSaturday = new Date(easter);
    blackSaturday.setUTCDate(easter.getUTCDate() - 1);
    holidays.push(
      {
        date: isoDate(maundyThursday),
        title: "Maundy Thursday",
        category: "Holiday",
      },
      { date: isoDate(goodFriday), title: "Good Friday", category: "Holiday" },
      {
        date: isoDate(blackSaturday),
        title: "Black Saturday",
        category: "Holiday",
      },
    );

    const chineseNewYear = CHINESE_NEW_YEAR_DATES[year];
    if (chineseNewYear) {
      holidays.push({
        date: chineseNewYear,
        title: "Chinese New Year",
        category: "Holiday",
      });
    }

    const allSoulsDay = `${year}-11-02`;
    holidays.push({
      date: allSoulsDay,
      title: "All Souls' Day",
      category: "Holiday",
    });
    holidays.push({
      date: `${year}-12-24`,
      title: "Christmas Eve",
      category: "Holiday",
    });
  }

  return holidays.sort((first, second) => first.date.localeCompare(second.date));
}

const STATIC_HOLIDAYS = buildStaticHolidayDataset();

function staticHolidaysForMonth(year, monthIndex) {
  const prefix = `${year}-${String(monthIndex + 1).padStart(2, "0")}-`;
  return STATIC_HOLIDAYS.filter((holiday) => holiday.date.startsWith(prefix)).map(
    (holiday) => ({ ...holiday }),
  );
}

function staticHolidayForDate(date) {
  return STATIC_HOLIDAYS.find((holiday) => holiday.date === date) || null;
}

function holidayDiagnosticsEnabled() {
  try {
    return (
      new URLSearchParams(location.search).get("debugHolidays") === "1" ||
      localStorage.getItem("recovibeDebugHolidays") === "true"
    );
  } catch {
    return new URLSearchParams(location.search).get("debugHolidays") === "1";
  }
}

function holidayLog(...values) {
  if (holidayDiagnosticsEnabled()) {
    console.log("[HolidayService]", ...values);
  }
}

function getGoogleCalendarApiKey() {
  const configuredKey =
    globalThis.RECOVIBE_GOOGLE_CALENDAR_API_KEY ||
    (typeof document !== "undefined"
      ? document
          .querySelector('meta[name="google-calendar-api-key"]')
          ?.getAttribute("content")
      : "");
  return String(configuredKey || "").trim();
}

function getDayBounds(isoDate) {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new TypeError("Holiday lookup requires a date in YYYY-MM-DD format.");
  }

  const utcDate = new Date(`${isoDate}T00:00:00.000Z`);
  if (
    Number.isNaN(utcDate.getTime()) ||
    utcDate.toISOString().slice(0, 10) !== isoDate
  ) {
    throw new TypeError("Holiday lookup received an invalid calendar date.");
  }

  const nextDate = new Date(utcDate.getTime() + DAY_IN_MS)
    .toISOString()
    .slice(0, 10);

  return {
    timeMin: `${isoDate}T00:00:00+08:00`,
    timeMax: `${nextDate}T00:00:00+08:00`,
  };
}

async function fetchCalendarEvents(timeMin, timeMax) {
  const apiKey = getGoogleCalendarApiKey();
  if (!apiKey || apiKey.startsWith("YOUR_")) {
    return [];
  }

  const params = new URLSearchParams({
    key: apiKey,
    singleEvents: "true",
    timeMin,
    timeMax,
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`;
  holidayLog("Requesting holiday events", {
    calendarId: CALENDAR_ID,
    endpoint: url.split("?")[0],
    timeMin,
    timeMax,
    singleEvents: true,
  });
  const response = await fetch(url);
  holidayLog("Google Calendar API HTTP status", response.status);
  if (!response.ok) {
    throw new Error(`Google Calendar API returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  holidayLog("Raw Google Calendar holiday items", data.items);
  if (!Array.isArray(data.items)) {
    throw new Error("Google Calendar API returned an invalid events response.");
  }
  return data.items;
}

function dateTimeInManila(dateTime) {
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) return null;

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeHolidayItems(items) {
  return items
    .filter((event) => event.status !== "cancelled" && event.summary)
    .map((event) => {
      const date = event.start?.date || dateTimeInManila(event.start?.dateTime);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      return { date, title: event.summary, category: "Holiday" };
    })
    .filter(Boolean);
}

export async function getPhilippineHolidaysForMonth(year, month) {
  return fetchMonthHolidays(year, month);
}

export async function fetchMonthHolidays(year, monthIndex) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(monthIndex) ||
    monthIndex < 0 ||
    monthIndex > 11
  ) {
    throw new TypeError("Holiday lookup requires a valid year and month.");
  }

  const cacheKey = `${year}-${monthIndex}`;
  if (monthHolidayCache.has(cacheKey)) {
    return (await monthHolidayCache.get(cacheKey)).map((holiday) => ({
      ...holiday,
    }));
  }

  const fallback = staticHolidaysForMonth(year, monthIndex);
  const firstDate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const lastDate = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  holidayLog("Fetching monthly holidays", {
    year,
    monthIndex,
    cacheKey,
    timeMin: `${firstDate}T00:00:00+08:00`,
    timeMax: `${lastDate}T23:59:59.999+08:00`,
  });
  const request = (async () => {
    const items = await fetchCalendarEvents(
      `${firstDate}T00:00:00+08:00`,
      `${lastDate}T23:59:59.999+08:00`,
    );
    const apiHolidays = normalizeHolidayItems(items);
    holidayLog("Normalized monthly holidays", apiHolidays);
    const byDate = new Map(fallback.map((holiday) => [holiday.date, holiday]));
    apiHolidays.forEach((holiday) => byDate.set(holiday.date, holiday));
    return [...byDate.values()].sort((first, second) =>
      first.date.localeCompare(second.date),
    );
  })();
  monthHolidayCache.set(cacheKey, request);

  try {
    const holidays = await request;
    monthHolidayCache.set(cacheKey, holidays);
    return holidays.map((holiday) => ({ ...holiday }));
  } catch (error) {
    console.warn("Unable to load holidays for the calendar month:", error);
    holidayLog("Using built-in monthly holiday fallback", fallback);
    if (monthHolidayCache.get(cacheKey) === request) {
      monthHolidayCache.delete(cacheKey);
    }
    return fallback;
  }
}

export async function checkPhilippineHoliday(isoDate) {
  const { timeMin, timeMax } = getDayBounds(isoDate);

  if (holidayCache.has(isoDate)) {
    return { ...(await holidayCache.get(isoDate)) };
  }

  const request = (async () => {
    try {
      const items = await fetchCalendarEvents(timeMin, timeMax);
      const holiday = normalizeHolidayItems(items).find(
        (item) => item.date === isoDate,
      );
      const fallback = holiday ? null : staticHolidayForDate(isoDate);
      const result = holiday || fallback;
      return {
        isHoliday: Boolean(result),
        holidayName: result?.title || null,
      };
    } catch (error) {
      const fallback = staticHolidayForDate(isoDate);
      holidayLog("Using built-in single-date holiday fallback", {
        date: isoDate,
        holiday: fallback,
        reason: error.message,
      });
      return {
        isHoliday: Boolean(fallback),
        holidayName: fallback?.title || null,
      };
    }
  })();
  holidayCache.set(isoDate, request);

  try {
    const result = await request;
    holidayCache.set(isoDate, result);
    return { ...result };
  } catch (error) {
    if (holidayCache.get(isoDate) === request) {
      holidayCache.delete(isoDate);
    }
    const fallback = staticHolidayForDate(isoDate);
    return {
      isHoliday: Boolean(fallback),
      holidayName: fallback?.title || null,
    };
  }
}
