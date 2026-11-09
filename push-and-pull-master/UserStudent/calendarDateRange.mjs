const MANILA_OFFSET = "+08:00";
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function dateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function makeManilaDate(date, time = "00:00:00") {
  const parsed = new Date(`${date}T${time}${MANILA_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseTime(value) {
  const match = String(value || "").trim().match(
    /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(AM|PM)?$/i,
  );
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  if (minutes > 59 || seconds > 59 || hours > 24) return null;
  const meridiem = match[4]?.toUpperCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
  }
  if (hours === 24 && (minutes || seconds)) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function datePart(value) {
  if (value == null || value === "") return null;
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? { date: dateKey(date), instant: date }
      : null;
  }
  if (typeof value === "object" && Number.isFinite(value.seconds)) {
    const date = new Date(value.seconds * 1000);
    return { date: dateKey(date), instant: date };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : { date: dateKey(value), instant: value };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : { date: dateKey(date), instant: date };
  }

  const raw = String(value).trim();
  if (!raw) return null;
  const onlyDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (onlyDate) {
    const date = makeManilaDate(raw);
    return date && dateKey(date) === raw ? { date: raw, instant: date } : null;
  }
  const dateAndTime = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](.+)$/);
  const combinedTime = dateAndTime && parseTime(dateAndTime[2]);
  if (dateAndTime && combinedTime) {
    const instant = makeManilaDate(dateAndTime[1], combinedTime);
    return instant ? { date: dateAndTime[1], instant, time: combinedTime } : null;
  }
  const timeOnly = parseTime(raw);
  if (timeOnly) return { time: timeOnly };

  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2}\s+\d/.test(normalized)) {
    normalized = normalized.replace(/\s+/, "T");
  }
  const localDateTime =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(normalized) &&
    !/(Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const instant = new Date(localDateTime ? `${normalized}${MANILA_OFFSET}` : normalized);
  if (Number.isNaN(instant.getTime())) return null;
  return { date: dateKey(instant), instant };
}

function timeFromEvent(value, event) {
  const directTime = parseTime(value);
  if (directTime) return directTime;
  const range = String(event.time || "").split(/\s*[-–—]\s*/);
  const rangeTime = parseTime(range[0]);
  if (rangeTime) return rangeTime;
  const dateTimeValue = value ?? event.startAt ?? event.start_at;
  const parsed = datePart(dateTimeValue);
  if (parsed?.time) return parsed.time;
  if (!parsed?.instant) return null;
  return parseTime(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(parsed.instant),
  );
}

function addManilaDays(date, days) {
  return new Date(date.getTime() + days * DAY_IN_MS);
}

export function clampEventDateRangeToGrid(range, visibleStartISO, visibleEndISO) {
  if (!range) return null;
  const eventStartISO = dateKey(range.start);
  const eventEndISO = dateKey(range.end);
  const start = eventStartISO < visibleStartISO ? visibleStartISO : eventStartISO;
  const end = eventEndISO > visibleEndISO ? visibleEndISO : eventEndISO;
  return start <= end ? { start, end } : null;
}

export function getEventDateRange(event) {
  if (!event || typeof event !== "object") return null;

  const startValue = [
    event.dateISO,
    event.eventDate,
    event.event_date,
    event.date,
    event.startDate,
    event.start_date,
    event.dateStart,
    event.startDateTime,
    event.start,
    event.startAt,
    event.start_at,
    event.schedule?.date,
    event.schedule?.startDate,
    event.schedule?.startAt,
  ].map(datePart).find((value) => value?.date);
  if (!startValue) return null;

  const eventTime = String(event.time || "").split(/\s*[-–—]\s*/);
  const startTime = timeFromEvent(
    event.startTime || event.timeStart || eventTime[0],
    event,
  );
  const start = startTime
    ? makeManilaDate(startValue.date, startTime)
    : startValue.instant || makeManilaDate(startValue.date);
  if (!start || Number.isNaN(start.getTime())) return null;

  const endDateFields = [
    event.endDateISO,
    event.eventEndDate,
    event.endDate,
    event.end_date,
    event.dateEnd,
    event.endDateTime,
    event.end_date_time,
    event.end,
    event.schedule?.endDate,
  ];
  const rawEndDate = endDateFields.find((value) => value != null && value !== "");
  const endCandidate = datePart(rawEndDate);
  if (rawEndDate != null && !endCandidate) {
    return { start: new Date(start.getTime()), end: new Date(start.getTime()) };
  }
  const endDateValue = endCandidate?.date ? endCandidate : null;
  const endValue =
    event.endTime ||
      event.timeEnd ||
      event.schedule?.endTime ||
      endCandidate?.time ||
      eventTime[1] ||
      event.endAt ||
      event.end_at;
  const endTime = parseTime(endValue) ||
    (datePart(endValue)?.time) ||
    (datePart(endValue)?.instant
      ? parseTime(
          new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Manila",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }).format(datePart(endValue).instant),
        )
      : null);
  const endDate = endDateValue?.date || startValue.date;
  let end = endDateValue?.instant || makeManilaDate(endDate);
  if (endTime) end = makeManilaDate(endDate, endTime);
  else if (!endDateValue && event.endAt != null) {
    const explicitEndAt = datePart(event.endAt);
    if (explicitEndAt?.instant) end = explicitEndAt.instant;
  } else if (!endDateValue && event.end_at != null) {
    const explicitEndAt = datePart(event.end_at);
    if (explicitEndAt?.instant) end = explicitEndAt.instant;
  }
  if (!end || Number.isNaN(end.getTime())) end = new Date(start.getTime());

  const startDateKey = dateKey(start);
  const endDateKey = dateKey(end);
  if (!endDateValue && endTime && endDateKey === startDateKey && end <= start) {
    end = addManilaDays(end, 1);
  } else if (end <= start) {
    end = new Date(start.getTime());
  }

  return { start: new Date(start.getTime()), end: new Date(end.getTime()) };
}
