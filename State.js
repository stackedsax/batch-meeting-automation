// Persistent state management for pending meetings.
// State is stored as JSON in ScriptProperties under PENDING_MEETINGS.
//
// Shape of each meeting entry:
// {
//   prepopulated:      boolean,  // upcoming block added to Google Doc
//   summaryProcessed:  boolean,  // LFX email found and parsed
//   summaryLink:       string,   // URL from the LFX email
//   summaryContent:    string,   // fetched text (may be null if behind auth)
//   youtubeVideoId:    string,
//   youtubeUrl:        string,
//   transcript:        string,   // VTT content
//   notificationsSent: boolean,  // Slack + mailing list sent
// }

function getPendingMeetings() {
  const raw = getConfig(CONFIG_KEYS.PENDING_MEETINGS);
  return raw ? JSON.parse(raw) : {};
}

function savePendingMeetings(state) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG_KEYS.PENDING_MEETINGS,
    JSON.stringify(state)
  );
}

function getMeetingState(dateKey) {
  return getPendingMeetings()[dateKey] || null;
}

function setMeetingState(dateKey, update) {
  const pending = getPendingMeetings();
  pending[dateKey] = Object.assign(pending[dateKey] || {}, update);
  savePendingMeetings(pending);
}

function clearMeetingState(dateKey) {
  const pending = getPendingMeetings();
  delete pending[dateKey];
  savePendingMeetings(pending);
}

// Debugging helper — logs all pending state to the Apps Script console.
function logPendingMeetings() {
  console.log(JSON.stringify(getPendingMeetings(), null, 2));
}

// Logs just the date keys and key fields — avoids truncation from large summaries.
function logPendingMeetingDates() {
  const pending = getPendingMeetings();
  const summary = Object.entries(pending).sort().map(([k, v]) =>
    `${k}: summaryProcessed=${v.summaryProcessed}, summaryLink=${!!v.summaryLink}, youtubeUrl=${!!v.youtubeUrl}, summaryContent=${!!v.summaryContent}`
  );
  console.log(summary.join('\n'));
}
