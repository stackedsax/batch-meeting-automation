// Orchestration and trigger management.
//
// Trigger schedule:
//   processSummaryEmails()  — every 5 minutes  (watches Gmail for LFX summary emails)
//   checkYouTube()          — every hour       (watches YouTube playlist for new videos)
//   dailyMaintenance()      — daily at 9am     (pre-populates upcoming meeting in Google Doc)
//
// First-time setup:
//   1. npm install && clasp login && clasp create --title "Batch Meeting Automation" --type standalone
//   2. clasp push
//   3. Run setInitialConfig() in Apps Script editor to set secrets
//   4. Create a Gmail filter: from:no-reply@zoom.us subject:"AI Meeting Summary Completed: Batch Subproject"
//      → apply label "LFX-Batch-Summary"
//   5. Run createTriggers() once to install all time-based triggers

// ── Trigger entry points ────────────────────────────────────────────────────

function processSummaryEmails() {
  try {
    processLFXSummaryEmails();
  } catch (e) {
    Logger.log('processSummaryEmails error: ' + e);
  }
}

function checkYouTube() {
  try {
    checkYouTubeForPendingMeetings();
  } catch (e) {
    Logger.log('checkYouTube error: ' + e);
  }
}

function dailyMaintenance() {
  try {
    prepopulateUpcomingMeeting();
  } catch (e) {
    Logger.log('dailyMaintenance error: ' + e);
  }
}

// ── Notification dispatch ───────────────────────────────────────────────────

// Called once both summary + video are ready for a given meeting date.
function sendNotifications(dateKey) {
  Logger.log(`Sending notifications for ${dateKey}`);
  postToSlack(dateKey);
  sendToMailingList(dateKey);
}

// ── Trigger setup ───────────────────────────────────────────────────────────

// Run once manually from the Apps Script editor.
function createTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processSummaryEmails')
    .timeBased().everyMinutes(5).create();

  ScriptApp.newTrigger('checkYouTube')
    .timeBased().everyHours(1).create();

  ScriptApp.newTrigger('dailyMaintenance')
    .timeBased().everyDays(1).atHour(9).create();

  Logger.log('Triggers created: processSummaryEmails (5min), checkYouTube (1hr), dailyMaintenance (9am)');
}

// ── Manual / debug helpers ──────────────────────────────────────────────────

// Manually trigger the full pipeline for a specific date.
// Useful for backfilling past meetings or testing.
// Usage: set dateKey below and run from Apps Script editor.
function manualRunForDate() {
  const dateKey = '2026-04-07'; // ← change this

  Logger.log('Manual run for: ' + dateKey);
  processSummaryEmails();
  checkYouTube();
  Logger.log('State after run:');
  logPendingMeetings();
}

// Force-send notifications for a date (even if already sent).
function forceNotify() {
  const dateKey = '2026-04-07'; // ← change this
  sendNotifications(dateKey);
}
