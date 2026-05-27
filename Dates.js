// Meeting date utilities.
// Meetings are every other Tuesday at 8am PDT/PST.
// Reference date: Oct 7, 2025 (confirmed meeting Tuesday).

const REFERENCE_MEETING_MS = new Date('2025-10-07T15:00:00Z').getTime(); // 8am PDT
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
const SHORT_MONTHS = [
  'Jan','Feb','Mar','Apr','May','Jun',
  'Jul','Aug','Sep','Oct','Nov','Dec'
];

function getNextMeetingDate(fromDate) {
  const now = (fromDate || new Date()).getTime();
  const weeksSince = (now - REFERENCE_MEETING_MS) / TWO_WEEKS_MS;
  const nextBiweek = Math.ceil(weeksSince);
  return new Date(REFERENCE_MEETING_MS + nextBiweek * TWO_WEEKS_MS);
}

// Returns YYYY-MM-DD string from a Date (using UTC date).
function dateToKey(date) {
  const d = new Date(date);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// "2026-04-07" → "Apr 7, 2026"
function keyToDisplayDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${SHORT_MONTHS[month - 1]} ${day}, ${year}`;
}

// Parse date from LFX email subject.
// "AI Meeting Summary Completed: Batch Subproject, April 7th" → "2026-04-07"
function parseDateFromEmailSubject(subject) {
  const match = subject.match(/,\s+([A-Za-z]+ \d+)(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (!match) return null;
  const year = match[2] || new Date().getFullYear();
  const date = new Date(`${match[1]}, ${year}`);
  return isNaN(date.getTime()) ? null : dateToKey(date);
}

// Try to match a YouTube video title to a meeting date.
function videoMatchesMeeting(videoTitle, videoPublishedAt, dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const title = videoTitle || '';

  // Match by published date (same UTC day or day after — videos often publish next day)
  if (videoPublishedAt) {
    const pubKey = dateToKey(new Date(videoPublishedAt));
    const pubDate = new Date(videoPublishedAt);
    const nextDay = new Date(pubDate); nextDay.setUTCDate(pubDate.getUTCDate() - 1);
    if (pubKey === dateKey || dateToKey(nextDay) === dateKey) return true;
  }

  // Match by full or abbreviated month name + day number in title
  const hasMonth = title.includes(MONTH_NAMES[month - 1]) || title.includes(SHORT_MONTHS[month - 1]);
  const hasDay   = new RegExp(`\\b${day}\\b`).test(title);
  if (hasMonth && hasDay) return true;

  // Match numeric date formats: MM/DD, MM/DD/YYYY, YYYY-MM-DD
  const pm = String(month).padStart(2, '0');
  const pd = String(day).padStart(2, '0');
  if (title.includes(`${pm}/${pd}`) || title.includes(`${year}-${pm}-${pd}`)) return true;

  return false;
}
