// Europe/Stockholm wall-clock time without Intl (CET +01:00, CEST +02:00 from the last Sunday of March
// 01:00 UTC to the last Sunday of October 01:00 UTC). RankedIn sends local times with no offset.
const H = 3600e3;
function lastSunday(y, m) {   // m: 0-based month; 01:00 UTC on its last Sunday
  const d = new Date(Date.UTC(y, m + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return +d;
}
export function offsetAt(ms) {
  const y = new Date(ms).getUTCFullYear();
  return ms >= lastSunday(y, 2) && ms < lastSunday(y, 9) ? 2 : 1;
}
// "2026-10-09T17:00:00", "27/09/2026 12:45" or "04/10/2026" -> Date (null when unparsable)
export function localToDate(s) {
  s = String(s || "");
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/.exec(s), y, mo, d, h = 0, mi = 0;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = +(m[4] || 0); mi = +(m[5] || 0); }
  else if ((m = /^(\d\d)\/(\d\d)\/(\d{4})(?: (\d\d):(\d\d))?/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; h = +(m[4] || 0); mi = +(m[5] || 0); }
  else return null;
  if (y < 2000) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(offsetAt(local - 2 * H) === 2 ? local - 2 * H : local - H);
}
// "2026-10-09", "07:00" -> "2026-10-09T07:00:00+02:00"
export function isoLocal(day, hhmm) {
  const t = localToDate(day + "T" + hhmm);
  return day + "T" + hhmm + ":00+0" + offsetAt(+t) + ":00";
}
// Date -> local "YYYY-MM-DD"
export function dayOf(date) {
  const ms = +date;
  return new Date(ms + offsetAt(ms) * H).toISOString().slice(0, 10);
}
// "dd/MM/yyyy" or ISO -> "YYYY-MM-DD"
export function isoDay(s) {
  const m = /^(\d\d)\/(\d\d)\/(\d{4})/.exec(String(s || ""));
  return m ? m[3] + "-" + m[2] + "-" + m[1] : String(s || "").slice(0, 10);
}
