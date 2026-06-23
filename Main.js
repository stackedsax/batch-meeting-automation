// Orchestration and trigger management.
//
// Trigger schedule:
//   processSummaryEmails()  — every 5 minutes  (watches Gmail for LFX summary emails)
//   checkYouTube()          — every hour       (watches YouTube playlist for new videos)
//   dailyMaintenance()      — daily at 9am     (pre-populates upcoming meeting ~11 days out, i.e. two Fridays before)
//
// First-time setup:
//   1. npm install && clasp login && clasp create --title "Batch Meeting Automation" --type standalone
//   2. clasp push
//   3. Run setInitialConfig() in Apps Script editor to set secrets
//   4. Create a Gmail filter: from:no-reply@zoom.us subject:"AI Meeting Summary Completed: Batch Subproject"
//      → apply label "LFX-Batch-Summary"
//   5. Run createTriggers() once to install all time-based triggers

// ── Bootstrap / reprocess helper (move back to debug section when done) ─────

// Moves all threads from LFX-Batch-Summary/processed back to LFX-Batch-Summary,
// clears their summaryProcessed state, then re-runs the email processor.
// Use this to retry processing without manually touching Gmail.
function reprocessAllSummaryEmails() {
  const labelName      = getConfig(CONFIG_KEYS.GMAIL_LABEL);
  const processedLabel = GmailApp.getUserLabelByName(labelName + PROCESSED_LABEL_SUFFIX);
  const pendingLabel   = GmailApp.getUserLabelByName(labelName)
    || GmailApp.createLabel(labelName);

  if (!processedLabel) {
    console.log('No processed label found — nothing to reprocess');
    return;
  }

  const threads = processedLabel.getThreads(0, 50);
  console.log(`Found ${threads.length} thread(s) in processed label`);

  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      const subject = message.getSubject();
      if (!subject.includes(LFX_SUBJECT_MARKER)) continue;

      const dateKey = parseDateFromEmailSubject(subject);
      if (!dateKey) continue;

      // Clear only the summary fields so the email gets re-processed;
      // preserves any YouTube state already collected.
      const existing = getMeetingState(dateKey) || {};
      setMeetingState(dateKey, {
        ...existing,
        summaryProcessed: false,
        summaryLink:      null,
        summaryContent:   null,
        summaryDetails:   null,
        summaryNextSteps: null,
        emailProcessedAt: null,
      });
      console.log(`Reset state for ${dateKey}`);
    }

    thread.removeLabel(processedLabel);
    thread.addLabel(pendingLabel);
  }

  console.log('All threads moved back to pending — running processor now');
  processLFXSummaryEmails();
  console.log('Email processing done — checking YouTube for all unmatched meetings');
  checkYouTubeForPendingMeetings();
}

// ── Trigger entry points ────────────────────────────────────────────────────

function processSummaryEmails() {
  try {
    processLFXSummaryEmails();
  } catch (e) {
    console.log('processSummaryEmails error: ' + e);
  }
}

function checkYouTube() {
  try {
    checkYouTubeForPendingMeetings();
  } catch (e) {
    console.log('checkYouTube error: ' + e);
  }
}

function dailyMaintenance() {
  try {
    prepopulateUpcomingMeeting();
  } catch (e) {
    console.log('dailyMaintenance error: ' + e);
  }
}

// ── Notification dispatch ───────────────────────────────────────────────────

// Called once both summary + video are ready for a given meeting date.
function sendNotifications(dateKey) {
  console.log(`Sending notifications for ${dateKey}`);
  postToSlack(dateKey);
  sendToMailingList(dateKey);
  openMeetingNotesPR(dateKey);
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

  console.log('Triggers created: processSummaryEmails (5min), checkYouTube (1hr), dailyMaintenance (9am)');
}

// ── Manual / debug helpers ──────────────────────────────────────────────────

// Manually trigger the full pipeline for a specific date.
// Useful for backfilling past meetings or testing.
// Usage: set dateKey below and run from Apps Script editor.
function manualRunForDate() {
  const dateKey = '2026-04-07'; // ← change this

  console.log('Manual run for: ' + dateKey);
  processSummaryEmails();
  checkYouTube();
  console.log('State after run:');
  logPendingMeetings();
}

// Force-send notifications for a date (even if already sent).
function forceNotify() {
  const dateKey = '2026-04-07'; // ← change this
  sendNotifications(dateKey);
}

// Re-fetches LFX summaries from stored summaryLinks and rebuilds everything.
// Use when summary parsing logic has changed and you want to re-extract content.
function refreshSummaryContent() {
  const pending = getPendingMeetings();
  const dateKeys = Object.keys(pending).sort();
  console.log(`Refreshing summaries for ${dateKeys.length} meeting(s)`);
  for (const dateKey of dateKeys) {
    const state = getMeetingState(dateKey);
    if (!state || !state.summaryLink) { console.log(`No summaryLink for ${dateKey} — skipping`); continue; }
    console.log(`Re-fetching summary for ${dateKey}`);
    const parsed = fetchSummaryContent(state.summaryLink);
    setMeetingState(dateKey, {
      summaryContent:   parsed ? parsed.content   : state.summaryContent,
      summaryDetails:   parsed ? parsed.details   : state.summaryDetails,
      summaryNextSteps: parsed ? parsed.nextSteps : state.summaryNextSteps,
    });
    createOrUpdateGitHubEntry(dateKey);
    upsertMeetingInGoogleDoc(dateKey);
  }
  console.log('Done refreshing summaries');
}

// Removes all meeting blocks from the Google Doc (everything between the
// meetings section heading and end of doc), then rebuilds from saved state.
function clearAndRebuildGoogleDoc() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();

  // Remove all existing meeting blocks by finding 📅 date headings and
  // deleting from each heading to the next divider (inclusive).
  let removed = 0;
  const allMeetings = getPendingMeetings();
  for (const dateKey of Object.keys(allMeetings)) {
    const marker = escapeRegex(`📅 ${keyToDisplayDate(dateKey)}`);
    let found = body.findText(marker);
    while (found) {
      const headingEl = found.getElement().getParent();
      const headingIdx = body.getChildIndex(headingEl);
      // Delete from heading forward until we hit the next 📅 heading or run out
      let j = headingIdx;
      while (j < body.getNumChildren()) {
        const child = body.getChild(j);
        // Stop if we've hit the next date heading (not the one we started from)
        if (j > headingIdx && getChildText(child).startsWith('📅')) break;
        const isDividerEl = isDivider(child);
        try { child.removeFromParent(); removed++; } catch(e) { j++; continue; }
        if (isDividerEl) break; // stop after removing divider
        // Don't increment j — removal shifts everything down
      }
      found = body.findText(marker);
    }
  }
  console.log(`Cleared ${removed} element(s) from meetings section`);
  doc.saveAndClose();

  // Rebuild from state oldest-first (so newest ends up at top)
  const pending  = getPendingMeetings();
  const dateKeys = Object.keys(pending).sort();
  console.log(`Rebuilding ${dateKeys.length} meeting block(s): ${JSON.stringify(dateKeys)}`);
  for (const dateKey of dateKeys) {
    upsertMeetingInGoogleDoc(dateKey);
  }
  console.log('Done — Google Doc rebuilt');
}

// Rebuilds Google Doc blocks from saved state (use when Doc was manually cleared).
// Does not need Gmail threads — reads state from Script Properties directly.
function rebuildGoogleDocFromState() {
  const pending = getPendingMeetings();
  const dateKeys = Object.keys(pending).sort(); // oldest first
  console.log(`Rebuilding Google Doc for ${dateKeys.length} meeting(s): ${JSON.stringify(dateKeys)}`);
  for (const dateKey of dateKeys) {
    console.log(`Upserting Google Doc block for ${dateKey}`);
    upsertMeetingInGoogleDoc(dateKey);
  }
  console.log('Done rebuilding Google Doc');
}

// Re-runs updateGoogleDocVideoLinks for all pending meetings.
// Use this to backfill links that were skipped on first run.
function updateAllDocLinks() {
  const pending = getPendingMeetings();
  for (const dateKey of Object.keys(pending)) {
    console.log(`Updating Google Doc links for ${dateKey}`);
    updateGoogleDocVideoLinks(dateKey);
  }
  console.log('Done updating all doc links');
}

// Migrates all meeting blocks to match the current format.
//
// Note: many older date headings use Google smart chips for the date (e.g. "📅 [chip]"),
// where getText() only returns "📅 " — not the full date text. The code handles this by
// treating any H2 starting with "📅" as a date heading, regardless of what follows.
//
// Passes (in order):
//   0. Restore: re-promote NORMAL paragraphs starting with "📅" back to H2
//      (repairs headings demoted by a previous migration run)
//   1. Promote: H3/H4/H5 paragraphs that contain a full date → H2 + normalise text
//   2. Normalise: H2 headings that start with 📽️ or other icons → strip icon, add 📅
//   3. Collect: build block ranges — all H2s starting with 📅 or containing a date
//   4. Process each block:
//      A. Remove blank paragraphs between consecutive list items (handles double blanks)
//      B. Demote H3+ and non-date H2s within block content to NORMAL; apply emoji labels
function migrateOldMeetingBlocks() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();

  const DATE_ANYWHERE_RE = /([A-Z][a-z]+ \d{1,2},\s*\d{4})/;
  let restored = 0, promoted = 0, normalised = 0, headingsDemoted = 0, blanksRemoved = 0;

  // ── Phase 0: Restore accidentally-demoted date headings ──────────────────
  // The previous migration run demoted H2 date headings whose dates were smart
  // chips (getText returns "📅 " — no date text), causing them to be missed as
  // block boundaries and then demoted by Pass B. Re-promote any NORMAL paragraph
  // starting with 📅 — that prefix is used exclusively for meeting date headings.
  for (let i = 0; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.NORMAL) continue;
    if (!para.getText().startsWith('📅')) continue;
    para.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    restored++;
  }
  console.log(`Phase 0: restored ${restored} date heading(s) to H2`);

  // ── Phase 1: Promote H3+ date headings → H2 ──────────────────────────────
  for (let i = 0; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para    = child.asParagraph();
    const heading = para.getHeading();
    if (heading === DocumentApp.ParagraphHeading.NORMAL  ||
        heading === DocumentApp.ParagraphHeading.HEADING1 ||
        heading === DocumentApp.ParagraphHeading.HEADING2) continue;
    const dateMatch = para.getText().match(DATE_ANYWHERE_RE);
    if (!dateMatch) continue;
    para.setHeading(DocumentApp.ParagraphHeading.HEADING2);
    para.setText('📅 ' + dateMatch[1]);
    promoted++;
  }
  console.log(`Phase 1: promoted ${promoted} H3+ date heading(s) to H2`);

  // Normalizes a date heading string:
  //   • strips trailing 📽️ (and anything after it)
  //   • replaces full month names and "Sept" with 3-letter abbreviations
  function normaliseHeadingText(text) {
    let clean = text.replace(/\s*📽️.*$/, '').trim();
    clean = clean.replace(
      /\b(January|February|March|April|June|July|August|September|October|November|December|Sept)\b/g,
      m => ({ January:'Jan', February:'Feb', March:'Mar', April:'Apr', June:'Jun',
               July:'Jul', August:'Aug', September:'Sep', October:'Oct',
               November:'Nov', December:'Dec', Sept:'Sep' }[m])
    );
    return clean;
  }

  // Normalises the month name in a date string and strips trailing 📽️ from the DATE
  // portion only. Returns just the normalised date string (not any suffix).
  const MONTH_NORM_MAP = {
    January:'Jan', February:'Feb', March:'Mar', April:'Apr', June:'Jun',
    July:'Jul', August:'Aug', September:'Sep', October:'Oct',
    November:'Nov', December:'Dec', Sept:'Sep',
  };
  function normaliseMonthInDate(dateStr) {
    return dateStr.replace(
      /\b(January|February|March|April|June|July|August|September|October|November|December|Sept)\b/g,
      m => MONTH_NORM_MAP[m]
    );
  }

  // Rebuild a plain-text date heading, preserving any topic suffix after the date.
  // "📅 October 7, 2025 📽️" → "📅 Oct 7, 2025"
  // "📅 Oct 7, 2025 — Kueue deep dive" → "📅 Oct 7, 2025 — Kueue deep dive"
  // "📅 June 20, 2022 📽️ — intro" → "📅 Jun 20, 2022 — intro"
  function normHeading(text, m) {
    const normDate = normaliseMonthInDate(m[1]);
    // Everything after the date match — trim and strip any trailing 📽️ icon
    const suffix = text.substring(m.index + m[0].length).replace(/\s*📽️.*$/, '').trimEnd();
    return '📅 ' + normDate + suffix;
  }

  // ── Phase 2: Normalise H2 date heading text ───────────────────────────────
  // IMPORTANT: some headings use Google smart chips for the date. getText() for
  // those headings returns only "📅 " (no date text). We MUST NOT call setText()
  // on those — it would destroy the chip. We only modify headings where we can
  // actually find a date string in the getText() output.
  //
  // Topic suffixes (e.g. "— Kueue deep dive") are PRESERVED — only the date
  // portion is normalised and any trailing 📽️ icon is stripped.
  //
  // Cases handled:
  //   a) Starts with "📅" and date is in text: normalise month, strip 📽️, keep suffix.
  //   b) Starts with "📅" but NO date in text: chip heading — skip entirely.
  //   c) Starts with "📽️" and date is in text: rebuild as "📅 <date> <suffix>".
  //   d) Starts with "📽️" but NO date in text: chip — swap emoji via editAsText.
  //   e) Date in text with no emoji prefix: rebuild as "📅 <date> <suffix>".
  for (let i = 0; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para    = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText();
    const m    = DATE_ANYWHERE_RE.exec(text);

    if (text.startsWith('📅')) {
      // Case (a): plain-text date — safe to call setText(), preserving topic suffix
      if (m) {
        const clean = normHeading(text, m);
        if (clean !== text) { para.setText(clean); normalised++; }
      }
      // Case (b): chip date — do nothing
      continue;
    }

    if (m) {
      // Cases (c) and (e): plain-text date with wrong/missing emoji
      para.setText(normHeading(text, m));
      normalised++;
    } else if (text.startsWith('📽️')) {
      // Case (d): chip date under 📽️ — swap emoji via editAsText to preserve chip.
      // '📽️' = U+1F4FD + U+FE0F = 3 JS chars; '📅' = U+1F4C5 = 2 JS chars.
      para.editAsText().deleteText(0, '📽️'.length - 1);
      para.editAsText().insertText(0, '📅');
      normalised++;
    }
  }
  console.log(`Phase 2: normalised ${normalised} H2 date heading(s)`);

  // ── Phase 3: Collect ALL meeting block ranges ─────────────────────────────
  // Treat any H2 that starts with 📅 (smart chip or plain) OR contains a date
  // pattern as a block boundary.
  const blocks = [];
  let blockStart = -1;

  for (let i = 0; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText();
    if (!text.startsWith('📅') && !DATE_ANYWHERE_RE.test(text)) continue;

    if (blockStart >= 0) blocks.push({ start: blockStart, end: i - 1 });
    blockStart = i;
  }
  if (blockStart >= 0) blocks.push({ start: blockStart, end: body.getNumChildren() - 1 });
  console.log(`Phase 3: found ${blocks.length} meeting block(s)`);

  const LABEL_MAP = [
    [/^📋\s*Agenda:?$/i,              null],
    [/^Agenda:?$/i,                   '📋 Agenda:'],
    [/^Recording and Transcript:?$/i, '🎬 Meeting Artifacts:'],
    [/^Recording:?$/i,                '🎬 Meeting Artifacts:'],
    [/^Notes:?$/i,                    '📝 Notes:'],
    [/^Quick Recap:?$/i,              '📝 Quick Recap:'],
    [/^Next Steps:?$/i,               '➡️ Next Steps:'],
  ];

  // Helpers shared by Phase 4 (blank removal) and Phase 5 (spacing restoration).
  const SECTION_PFXS = ['📅', '📋', '🎬', '👥', '📝', '➡️'];
  function isSecHdr(el) {
    if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
    const t = el.asParagraph().getText();
    return SECTION_PFXS.some(p => t.startsWith(p));
  }
  // Returns true if el is a non-empty paragraph whose first character is explicitly bold.
  // Matches the section sub-headings written by the automation in Summary sections
  // (via editAsText().setBold(true)), but NOT heading-style bold (which returns null).
  function isBoldPara(el) {
    if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
    const para = el.asParagraph();
    if (para.getText().length === 0) return false;
    try { return para.editAsText().isBold(0) === true; } catch(e) { return false; }
  }

  // ── Phase 4: Process each block (reverse order for stable indices) ─────────
  for (let b = blocks.length - 1; b >= 0; b--) {
    let { start, end } = blocks[b];

    // Pass A: remove blank paragraphs that sit between non-header content elements.
    // Preserves blanks adjacent to section headers (emoji-prefixed lines) and adjacent
    // to bold sub-headings (Summary section labels in automated blocks).
    // Uses nearest-non-blank scan so runs of 2+ blanks are fully cleared in one pass.

    for (let i = end; i > start; i--) {
      if (i >= body.getNumChildren()) continue;
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      if (child.asParagraph().getText().trim() !== '') continue;

      // Nearest non-blank element before this blank (within block)
      let prev = null;
      for (let pi = i - 1; pi >= start; pi--) {
        const pc = body.getChild(pi);
        if (pc.getType() !== DocumentApp.ElementType.PARAGRAPH || pc.asParagraph().getText().trim() !== '') {
          prev = pc; break;
        }
      }
      // Nearest non-blank element after this blank (within block)
      let next = null;
      for (let ni = i + 1; ni <= end && ni < body.getNumChildren(); ni++) {
        const nc = body.getChild(ni);
        if (nc.getType() !== DocumentApp.ElementType.PARAGRAPH || nc.asParagraph().getText().trim() !== '') {
          next = nc; break;
        }
      }

      // Remove blank only if both neighbors exist and neither is a section header.
      // This preserves spacing around 📅/📋/🎬/etc. labels.
      if (prev && next && !isSecHdr(prev) && !isSecHdr(next) && !isBoldPara(prev) && !isBoldPara(next)) {
        try { child.removeFromParent(); blanksRemoved++; end--; } catch (e) {}
      }
    }

    // Pass B (forward from start+1): demote H3+ sub-headings and wayward H2s.
    // Preserve H2s starting with 📅 — those are legitimate date headings within
    // a merged block range (e.g. smart-chip dates missed in Phase 3).
    for (let i = start + 1; i <= end && i < body.getNumChildren(); i++) {
      const child = body.getChild(i);
      if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
      const para    = child.asParagraph();
      const heading = para.getHeading();
      if (heading === DocumentApp.ParagraphHeading.NORMAL ||
          heading === DocumentApp.ParagraphHeading.HEADING1) continue;
      if (heading === DocumentApp.ParagraphHeading.HEADING2 && para.getText().startsWith('📅')) continue;

      para.setHeading(DocumentApp.ParagraphHeading.NORMAL);
      headingsDemoted++;

      const text = para.getText().trim();
      for (const [pattern, replacement] of LABEL_MAP) {
        if (pattern.test(text)) {
          if (replacement) para.setText(replacement);
          break;
        }
      }
    }
  }

  // ── Phase 5: Restore blank spacing around bold section headings ────────────
  // A previous migration run (before isBoldPara was added) may have removed blanks
  // adjacent to bold sub-headings in Summary sections. This phase re-inserts them.
  // Only runs within blocks that contain "📋 Summary:" (automated blocks only).
  // Scans each block in reverse so insertions don't shift earlier-to-process elements.
  let blanksRestored = 0;

  for (let b = blocks.length - 1; b >= 0; b--) {
    const { start } = blocks[b];
    let end = blocks[b].end;

    // Check if this block has a Summary section
    let hasSummary = false;
    for (let i = start; i <= end && i < body.getNumChildren(); i++) {
      const c = body.getChild(i);
      if (c.getType() === DocumentApp.ElementType.PARAGRAPH &&
          c.asParagraph().getText() === '📋 Summary:') { hasSummary = true; break; }
    }
    if (!hasSummary) continue;

    // Scan backwards; for each bold paragraph ensure blanks exist before and after it.
    for (let i = end; i >= start; i--) {
      if (i >= body.getNumChildren()) continue;
      const child = body.getChild(i);
      if (!isBoldPara(child)) continue;

      // Ensure blank AFTER bold paragraph (bold-break blank)
      const afterIdx = i + 1;
      if (afterIdx < body.getNumChildren()) {
        const after = body.getChild(afterIdx);
        const afterBlank = after.getType() === DocumentApp.ElementType.PARAGRAPH
          && after.asParagraph().getText().trim() === '';
        if (!afterBlank) { body.insertParagraph(afterIdx, ''); end++; blanksRestored++; }
      }

      // Ensure blank BEFORE bold paragraph (section separator)
      // Skip if immediately preceded by a section header (e.g. "📋 Summary:")
      if (i > start) {
        const before = body.getChild(i - 1);
        const beforeBlank = before.getType() === DocumentApp.ElementType.PARAGRAPH
          && before.asParagraph().getText().trim() === '';
        if (!beforeBlank && !isSecHdr(before)) {
          body.insertParagraph(i, '');
          end++; blanksRestored++;
        }
      }
    }
  }
  console.log(`Phase 5: restored ${blanksRestored} blank(s) around bold section headings`);

  doc.saveAndClose();
  console.log(`Migration done. restored: ${restored}, promoted: ${promoted}, normalised: ${normalised}, demoted: ${headingsDemoted}, blanks removed: ${blanksRemoved}, blanks restored: ${blanksRestored}`);
}

// ── Meeting notes export ─────────────────────────────────────────────────────

// One-time migration: moves existing nested meetings/YYYY-MM-DD/notes.md files
// to the flat meeting-notes/YYYY-MM-DD.md layout, then deletes the old files.
function migrateMeetingsToFlatPath() {
  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const headers = githubHeaders();
  const oldBase = 'tags/tag-workloads-foundation/subprojects/batch/meetings';
  const newBase = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);

  // List the old meetings/ directory
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${oldBase}`;
  const listResp = UrlFetchApp.fetch(listUrl, { headers, muteHttpExceptions: true });
  if (listResp.getResponseCode() !== 200) {
    console.log(`meetings/ directory not found or already removed (${listResp.getResponseCode()})`);
    return;
  }
  const dirs = JSON.parse(listResp.getContentText());
  console.log(`Found ${dirs.length} item(s) in meetings/`);

  for (const dir of dirs) {
    if (dir.type !== 'dir') continue;
    const dateKey = dir.name; // YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;

    // Fetch old notes.md
    const oldPath = `${oldBase}/${dateKey}/notes.md`;
    const fetchUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${oldPath}`;
    const fileResp = UrlFetchApp.fetch(fetchUrl, { headers, muteHttpExceptions: true });
    if (fileResp.getResponseCode() !== 200) {
      console.log(`No notes.md found for ${dateKey} — skipping`);
      continue;
    }
    const fileJson = JSON.parse(fileResp.getContentText());
    const content  = Utilities.newBlob(Utilities.base64Decode(fileJson.content.replace(/\n/g, ''))).getDataAsString();
    const oldSha   = fileJson.sha;

    // Write to new flat path
    upsertGitHubFile({
      owner, repo, headers,
      path:    `${newBase}/${dateKey}.md`,
      content,
      message: `Meeting notes: migrate ${dateKey} to flat path`,
    });

    // Delete old nested file
    const delUrl  = `https://api.github.com/repos/${owner}/${repo}/contents/${oldPath}`;
    const delBody = JSON.stringify({ message: `Remove nested meeting notes: ${dateKey}`, sha: oldSha, branch: 'main' });
    const delResp = UrlFetchApp.fetch(delUrl, { method: 'DELETE', headers, payload: delBody, muteHttpExceptions: true });
    if (delResp.getResponseCode() === 200) {
      console.log(`Deleted old file: ${oldPath}`);
    } else {
      console.log(`Failed to delete ${oldPath}: ${delResp.getResponseCode()} ${delResp.getContentText()}`);
    }

    Utilities.sleep(300);
  }
  console.log('Migration to flat path complete');
}

// Creates or updates meeting-notes/README.md in the GitHub repo.
// Dynamically builds the meeting list from Google Doc H2 headings (newest-first).
function upsertMeetingNotesReadme() {
  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const headers = githubHeaders();
  const base    = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);

  const meetingLines = buildMeetingListFromDoc();
  const meetingSection = meetingLines.length > 0
    ? `\n## Meetings\n\n${meetingLines.join('\n')}\n`
    : '';

  const content = `# Batch Subproject — Meeting Notes

Meeting notes for the [CNCF Batch Subproject](https://tag-workloads-foundation.cncf.io/batch/).

## Resources

- **Google Doc (full notes):** https://docs.google.com/document/d/1GuZGyBkRGG0lEeiPA8q0PfvFlwUlwa5k-ZfXafCTdBY/edit
- **Charter:** [charter.md](../charter.md)
- **YouTube playlist:** https://www.youtube.com/playlist?list=PLlo2EEMTvVU-jMMA208R-cSEcVkmPYjxZ
- **LFX meeting page:** https://lfx.linuxfoundation.org/tools/open-source-summit/project-management/meetings
- **Zoom:** https://zoom-lfx.platform.linuxfoundation.org/meeting/99965231171?password=2a169dd5-e375-4b5a-9b40-b2b5db5bfe91
${meetingSection}
## Cadence

Meetings are held **every other Tuesday at 8:00 AM PDT** (biweekly).

## File naming

Each file in this directory is named \`YYYY-MM-DD.md\` corresponding to the meeting date.
`;

  upsertGitHubFile({
    owner, repo, headers,
    path:    `${base}/README.md`,
    content,
    message: 'Meeting notes: update README',
  });
}

// Scans the Google Doc for all dated H2 headings and returns an array of
// Markdown list entries (newest-first, matching doc order) like:
//   - [📅 May 19, 2026 — Topology-Awareness in Slurm Redux](./2026-05-19.md)
function buildMeetingListFromDoc() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  const DATE_RE = /([A-Z][a-z]+ \d{1,2},?\s*\d{4})/;
  const n = body.getNumChildren();
  const lines = [];

  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText().trim();
    if (!text.startsWith('📅')) continue;

    const m = DATE_RE.exec(text);
    if (!m) continue;

    const cleaned = m[1].replace(/(\d+)(st|nd|rd|th)/gi, '$1');
    const parsed  = new Date(cleaned);
    if (isNaN(parsed.getTime())) continue;
    const dateKey = dateToKey(parsed);

    // Strip leading "📅 " for the display text; keep any topic suffix
    const display = text.replace(/^📅\s*/, '').trim();
    lines.push(`- [📅 ${display}](./${dateKey}.md)`);
  }

  doc.saveAndClose();
  return lines; // doc is newest-first, so result is already newest-to-oldest
}

// Pushes the real charter.md content to the GitHub repo branch.
// Run once to replace the placeholder "Charter content here" that was committed
// when the branch was first set up.
function upsertCharter() {
  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const headers = githubHeaders();
  const basePath = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  // charter.md lives one directory up from meeting-notes/
  const charterPath = basePath.replace(/\/[^/]+$/, '') + '/charter.md';

  const content = `# TAG Workloads Foundation Batch Subproject Charter

## Mission

The cloud-native batch scheduling ecosystem is fragmented — different projects tackle job scheduling, queueing, and resource management in incompatible ways. The Batch subproject brings together maintainers and users across the ecosystem to reduce that fragmentation: aligning on common Kubernetes APIs and primitives, developing best practices, and improving outcomes for batch workloads — whether HPC, AI/ML, data analytics, or CI — in cloud-native environments.

## Scope

### In Scope

To reduce fragmentation in the Kubernetes batch ecosystem: congregate leads and users from different external and internal projects and user groups (CNCF TAGs, Kubernetes sub-projects focused on batch-related features such as topology-aware scheduling) in the batch ecosystem to gather requirements, validate designs and encourage reutilization of core Kubernetes APIs.

The following recommendations for enhancements:

* Additions to the batch API group, currently including Job and CronJob resources that benefit batch use cases such as HPC, AI/ML, data analytics and CI.
* Primitives for job-level queueing, not limited to the Kubernetes Job resource. Long-term, this could include multi-cluster support.
* Primitives to control and maximize utilization of resources in fixed-size clusters (on-prem) and elastic clusters (cloud).
* Benchmarking models for Batch systems
* Data Locality
* User Stories
* Scheduling support for specialized hardware (Accelerators, NUMA, Networking, etc.)

### Out of Scope

* Addition of new API kinds that serve a specialized type of workload. The focus should be on general APIs that specialized controllers can build on top of.
* Uses of the batch APIs as support for serving workloads (eg. backups, upgrades, migrations). These can be served by existing SIGs.
* Proposals that duplicate the functionality of core Kubernetes components (job-controller, kube-scheduler, cluster-autoscaler).
* Job workflows or pipelines. Mature third party frameworks serve these use cases with the current Kubernetes primitives. But additional primitives to support these frameworks could be in scope.

## Deliverables

* **Project Landscape** — a living catalogue of batch scheduling projects in the cloud-native ecosystem, maintained at [bsi-landscape.netlify.app](https://bsi-landscape.netlify.app/).
* **Whitepapers and Technical Research** — the subproject produces papers and research on topics relevant to cloud-native batch scheduling, such as benchmarking of batch systems, data locality, scheduling best practices, and user stories. An initial series of five whitepapers is complete, with more planned as the space evolves.
`;

  upsertGitHubFile({
    owner, repo, headers,
    path:    charterPath,
    content,
    message: 'Batch subproject: replace charter placeholder with real content',
  });
}

// Creates initiative_benchmarking/README.md on the GitHub repo branch.
// Run once to seed the directory; future content can be committed manually.
function upsertInitiativeBenchmarkingReadme() {
  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const headers = githubHeaders();
  const basePath = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const dirPath  = basePath.replace(/\/[^/]+$/, '') + '/initiative_benchmarking/README.md';

  const content = `# Batch Subproject — Benchmarking Initiative

This directory contains work from the benchmarking initiative of the [CNCF Batch Subproject](https://tag-workloads-foundation.cncf.io/batch/).

## Overview

The benchmarking initiative develops models, methodologies, and tools for evaluating and comparing batch scheduling systems in cloud-native environments.
`;

  upsertGitHubFile({
    owner, repo, headers,
    path:    dirPath,
    content,
    message: 'Batch subproject: add initiative_benchmarking directory',
  });
}

// Injects missing Quick Recap / Next Steps / Summary sections into existing Google Doc
// blocks for all meetings in PropertiesService that have summary content.
// Safe to re-run — injectSummaryIntoBlock skips sections already present.
function backfillSummaryInGoogleDoc() {
  const pending = getPendingMeetings();
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  const processedDates = [];

  for (const [dateKey, state] of Object.entries(pending)) {
    const anchor = body.findText(escapeRegex(`📅 ${keyToDisplayDate(dateKey)}`));
    if (!anchor) { console.log(`backfill: no block found for ${dateKey}`); continue; }
    const anchorPara = anchor.getElement().getParent().asParagraph();
    const anchorIdx  = body.getChildIndex(anchorPara);
    // Strip [UPCOMING] suffix if still present
    const headingText = anchorPara.getText();
    if (headingText.includes('[UPCOMING]'))
      anchorPara.setText(headingText.replace(/\s*\[UPCOMING\]/, ''));
    injectSummaryIntoBlock(body, anchorIdx, findBlockEnd(body, anchorIdx), state);
    processedDates.push(dateKey);
    console.log(`backfill: injected summary for ${dateKey}`);
  }

  doc.saveAndClose();

  // Update recording/summary links in a second pass (updateGoogleDocVideoLinks opens its own handle)
  for (const dateKey of processedDates) {
    updateGoogleDocVideoLinks(dateKey);
  }

  console.log(`backfillSummaryInGoogleDoc done: processed ${processedDates.length} block(s)`);
}

// ── Private helpers ───────────────────────────────────────────────────────────

// Returns the first hyperlink URL found in the element, or null.
function extractFirstLink(el) {
  try {
    const text = el.editAsText();
    const len  = text.getText().length;
    for (let i = 0; i < len; i++) {
      const url = text.getLinkUrl(i);
      if (url) return url;
    }
  } catch (e) {}
  return null;
}

// Scans block elements [start+1, end] for the first line starting with 📽️,
// then returns its first hyperlink URL if it contains "youtu", otherwise null.
function extractFirstYouTubeUrl(body, start, end) {
  for (let i = start + 1; i <= end && i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    let text = '';
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH)
      text = child.asParagraph().getText();
    else if (child.getType() === DocumentApp.ElementType.LIST_ITEM)
      text = child.asListItem().getText();
    if (!text.startsWith('📽️')) continue;
    const url = extractFirstLink(child.getType() === DocumentApp.ElementType.PARAGRAPH
      ? child.asParagraph() : child.asListItem());
    if (url && url.includes('youtu')) return url;
  }
  return null;
}

// Extracts a YouTube video ID from a URL, or null.
function parseYouTubeVideoId(url) {
  if (!url) return null;
  let m = url.match(/[?&]v=([^&]+)/);
  if (m) return m[1];
  m = url.match(/youtu\.be\/([^?]+)/);
  return m ? m[1] : null;
}

// Fetches the YouTube publishedAt date for a video and snaps to the nearest
// preceding Tuesday (UTC day 2). Returns a YYYY-MM-DD dateKey or null.
function youTubeDateKey(videoId, apiKey) {
  if (!videoId || !apiKey) return null;
  try {
    const url  = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&part=snippet&key=${apiKey}`;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return null;
    const data = JSON.parse(resp.getContentText());
    if (!data.items || !data.items.length) return null;
    const published = new Date(data.items[0].snippet.publishedAt);
    // Snap to nearest preceding Tuesday (UTC day 2: Sun=0…Sat=6)
    for (let offset = 0; offset <= 3; offset++) {
      const d = new Date(published.getTime() - offset * 86400000);
      if (d.getUTCDay() === 2) return dateToKey(d);
    }
    return dateToKey(published); // fallback
  } catch (e) {
    console.log(`youTubeDateKey error for ${videoId}: ${e}`);
    return null;
  }
}

// Identifies which meeting section a line of text belongs to.
// Returns a section name string or null.
function identifyMeetingSection(text) {
  if (/^📋\s*Agenda:|^Agendas?:/i.test(text))                          return 'agenda';
  if (/^🎬\s*Meeting Artifacts:|^Recording(s)?\s*(and\s*Transcript)?:|^Recordings?,/i.test(text)) return 'artifacts';
  if (/^👥\s*Attendees|^Attendees?\s*[:(✋]/i.test(text))               return 'attendees';
  if (/^📝\s*Quick Recap:|^Quick Recap:/i.test(text))                   return 'recap';
  if (/^➡️\s*Next Steps:|^Next Steps:/i.test(text))                     return 'nextsteps';
  if (/^📋\s*Summary:/i.test(text))                                     return 'summary';
  if (/^Discussion\s*(Notes)?:|^Notes:/i.test(text))                    return 'discussion';
  return null;
}

// Returns true if el is a non-empty paragraph whose first character is explicitly bold.
function isBoldPara(el) {
  if (el.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
  const para = el.asParagraph();
  if (para.getText().length === 0) return false;
  try { return para.editAsText().isBold(0) === true; } catch(e) { return false; }
}

// Walks a meeting block [start+1, end] and extracts structured content.
// Returns { heading, recordingUrl, summaryUrl, agendaItems, attendees,
//           recap, nextSteps, summaryBlocks, discussion }.
function extractDocBlockContent(body, start, end, headingText) {
  let section = 'preamble';
  let recordingUrl = null, summaryUrl = null;
  const agendaItems = [], attendees = [], recap = [], nextSteps = [], summaryBlocks = [], discussion = [];
  let currentSummaryLabel = null;

  for (let i = start + 1; i <= end && i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    const type  = child.getType();

    // Stop at horizontal rule (block divider)
    if (type === DocumentApp.ElementType.HORIZONTAL_RULE) break;

    let text = '';
    let el   = null;
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      el   = child.asParagraph();
      text = el.getText().trim();
    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      el   = child.asListItem();
      text = el.getText().trim();
    }
    if (!text) continue;

    // Detect section changes
    const detected = identifyMeetingSection(text);
    if (detected) {
      section = detected;
      if (section === 'summary') currentSummaryLabel = null;
      continue;
    }

    // Always extract recording/summary links from 📽️/🤖 lines
    if (text.startsWith('📽️') && el) {
      const url = extractFirstLink(el);
      if (url && url.includes('youtu')) recordingUrl = url;
      continue;
    }
    if (text.startsWith('🤖') && el) {
      const url = extractFirstLink(el);
      if (url) summaryUrl = url;
      continue;
    }
    // Skip 📜 transcript lines
    if (text.startsWith('📜')) continue;
    // Skip pure emoji-label lines
    if (/^[📅📋🎬👥📝➡️🤖📽️📜]/.test(text) && text.length < 40) continue;

    switch (section) {
      case 'agenda':
        agendaItems.push(text);
        break;

      case 'artifacts':
        // Old format: topics may follow the recording line — treat as discussion
        if (el) {
          const url = extractFirstLink(el);
          if (!url) discussion.push(text);
        }
        break;

      case 'attendees':
        // Skip ✋ marker lines
        if (text === '✋' || text === '✋ ') break;
        attendees.push(text);
        break;

      case 'recap':
        recap.push(text);
        break;

      case 'nextsteps':
        nextSteps.push(text);
        break;

      case 'summary':
        if (el && isBoldPara(child)) {
          currentSummaryLabel = text;
          summaryBlocks.push({ label: text, lines: [] });
        } else if (summaryBlocks.length > 0) {
          summaryBlocks[summaryBlocks.length - 1].lines.push(text);
        } else {
          summaryBlocks.push({ label: null, lines: [text] });
        }
        break;

      case 'discussion':
      case 'preamble':
      default:
        discussion.push(text);
        break;
    }
  }

  return { heading: headingText, recordingUrl, summaryUrl, agendaItems, attendees, recap, nextSteps, summaryBlocks, discussion };
}

// Renders a structured meeting content object as a Markdown string.
function docBlockToMarkdown(content, dateKey) {
  const lines = [];

  lines.push(`# ${content.heading || ('Meeting Notes — ' + keyToDisplayDate(dateKey))}`);
  lines.push('');

  if (content.recordingUrl) {
    lines.push(`📽️ [Recording](${content.recordingUrl})`);
  }
  if (content.summaryUrl) {
    lines.push(`🤖 [AI Summary](${content.summaryUrl})`);
  }
  if (content.recordingUrl || content.summaryUrl) lines.push('');

  if (content.attendees && content.attendees.length > 0) {
    lines.push('## 👥 Attendees');
    lines.push('');
    content.attendees.forEach(a => lines.push(`- ${a}`));
    lines.push('');
  }

  if (content.agendaItems && content.agendaItems.length > 0) {
    lines.push('## 📋 Agenda');
    lines.push('');
    content.agendaItems.forEach(a => lines.push(`- ${a}`));
    lines.push('');
  }

  if (content.recap && content.recap.length > 0) {
    lines.push('## 📝 Quick Recap');
    lines.push('');
    content.recap.forEach(r => lines.push(r));
    lines.push('');
  }

  if (content.nextSteps && content.nextSteps.length > 0) {
    lines.push('## ➡️ Next Steps');
    lines.push('');
    content.nextSteps.forEach(s => lines.push(`- ${s}`));
    lines.push('');
  }

  if (content.summaryBlocks && content.summaryBlocks.length > 0) {
    lines.push('## 📋 Summary');
    lines.push('');
    for (const block of content.summaryBlocks) {
      if (block.label) {
        lines.push(`### ${block.label}`);
        lines.push('');
      }
      block.lines.forEach(l => lines.push(l));
      lines.push('');
    }
  }

  if (content.discussion && content.discussion.length > 0) {
    lines.push('## Discussion Notes');
    lines.push('');
    content.discussion.forEach(d => lines.push(d));
    lines.push('');
  }

  return lines.join('\n');
}

// Logs every H2 heading in the doc exactly as getText() sees it — for debugging date resolution.
function dumpH2Headings() {
  const body = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID)).getBody();
  const n = body.getNumChildren();
  const lines = [];
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    lines.push(`[${i}] "${para.getText()}"`);
  }
  console.log(lines.join('\n'));
}

// Returns all biweekly Tuesday dateKeys strictly between olderKey and newerKey,
// ordered oldest-first.
function biweeklyDatesInRange(olderKey, newerKey) {
  const olderMs = new Date(olderKey + 'T00:00:00Z').getTime();
  const newerMs = new Date(newerKey + 'T00:00:00Z').getTime();
  const offsetWeeks = (olderMs - REFERENCE_MEETING_MS) / TWO_WEEKS_MS;
  const startN = Math.floor(offsetWeeks) + 1;
  const results = [];
  for (let n = startN; ; n++) {
    const d = new Date(REFERENCE_MEETING_MS + n * TWO_WEEKS_MS);
    if (d.getTime() >= newerMs) break;
    results.push(dateToKey(d));
  }
  return results; // oldest-first
}

// Exports all meeting blocks from the Google Doc as flat meeting-notes/YYYY-MM-DD.md
// files in the GitHub repo. Idempotent — safe to re-run.
function exportMeetingNotesFromDoc() {
  const doc     = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body    = doc.getBody();
  const apiKey  = getConfig(CONFIG_KEYS.YOUTUBE_API_KEY);
  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const base    = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const headers = githubHeaders();

  const DATE_RE = /([A-Z][a-z]+ \d{1,2},?\s*\d{4})/;

  // ── Pass 1: block collection + date resolution ────────────────────────────
  const blocks = [];
  let blockStart = -1;
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText();
    if (!text.startsWith('📅') && !DATE_RE.test(text)) continue;
    if (blockStart >= 0) blocks.push({ start: blockStart, end: i - 1 });
    blockStart = i;
  }
  if (blockStart >= 0) blocks.push({ start: blockStart, end: n - 1 });
  console.log(`exportMeetingNotesFromDoc: found ${blocks.length} block(s)`);

  // Resolve dateKey for each block
  const blockData = blocks.map(({ start, end }) => {
    const headingText = body.getChild(start).asParagraph().getText().trim();
    let dateKey = null;

    // Strategy 1: plain-text date in heading
    const m = DATE_RE.exec(headingText);
    if (m) {
      const cleaned = m[1].replace(/(\d+)(st|nd|rd|th)/gi, '$1');
      const parsed  = new Date(cleaned);
      if (!isNaN(parsed.getTime())) dateKey = dateToKey(parsed);
    }

    // Strategy 2: scan block body elements for any date string (catches chip headings
    // where getText() returns only "📅 " but body paragraphs contain plain-text dates)
    if (!dateKey) {
      for (let i = start + 1; i <= end && i < body.getNumChildren(); i++) {
        const child = body.getChild(i);
        let text = '';
        if (child.getType() === DocumentApp.ElementType.PARAGRAPH)
          text = child.asParagraph().getText();
        else if (child.getType() === DocumentApp.ElementType.LIST_ITEM)
          text = child.asListItem().getText();
        const bm = DATE_RE.exec(text);
        if (bm) {
          const cleaned = bm[1].replace(/(\d+)(st|nd|rd|th)/gi, '$1');
          const parsed  = new Date(cleaned);
          if (!isNaN(parsed.getTime())) { dateKey = dateToKey(parsed); break; }
        }
      }
      if (dateKey) console.log(`Chip heading: resolved via body scan → ${dateKey}`);
    }

    // Strategy 2.5: LFX summary URL contains an embedded Unix timestamp in ms
    // e.g. /meeting/99965231171-1773154800000/ → dateToKey(new Date(1773154800000))
    if (!dateKey) {
      for (let i = start + 1; i <= end && i < body.getNumChildren(); i++) {
        const child = body.getChild(i);
        let el = null;
        if (child.getType() === DocumentApp.ElementType.PARAGRAPH)  el = child.asParagraph();
        else if (child.getType() === DocumentApp.ElementType.LIST_ITEM) el = child.asListItem();
        if (!el) continue;
        const url = extractFirstLink(el);
        if (!url) continue;
        const tm = url.match(/\/meeting\/\d+-(\d+)\//);
        if (tm) {
          const d = new Date(parseInt(tm[1]));
          if (!isNaN(d.getTime())) { dateKey = dateToKey(d); break; }
        }
      }
      if (dateKey) console.log(`Chip heading: resolved via LFX URL timestamp → ${dateKey}`);
    }

    // Strategy 3: YouTube API
    if (!dateKey && headingText.startsWith('📅')) {
      const ytUrl   = extractFirstYouTubeUrl(body, start, end);
      const videoId = parseYouTubeVideoId(ytUrl);
      if (videoId) {
        dateKey = youTubeDateKey(videoId, apiKey);
        if (dateKey) console.log(`Chip heading: resolved via YouTube → ${dateKey}`);
      }
    }

    return { start, end, headingText, dateKey };
  });

  // ── Pass 2: positional interpolation for null-dated runs ─────────────────
  // Doc is reverse-chronological (newest block first). For each consecutive run of
  // undated blocks, compute expected biweekly dates from the dated anchors on each side.
  let i = 0;
  while (i < blockData.length) {
    if (blockData[i].dateKey !== null) { i++; continue; }
    let j = i;
    while (j + 1 < blockData.length && blockData[j + 1].dateKey === null) j++;
    const newerKey = i > 0                    ? blockData[i - 1].dateKey : null;
    const olderKey = j + 1 < blockData.length ? blockData[j + 1].dateKey : null;
    if (newerKey && olderKey) {
      const expected = biweeklyDatesInRange(olderKey, newerKey); // oldest-first
      const runLen   = j - i + 1;
      if (expected.length === runLen) {
        for (let k = 0; k < runLen; k++) {
          blockData[i + k].dateKey = expected[runLen - 1 - k]; // reverse: doc is newest-first
          console.log(`Interpolated: block[${i + k}] "${blockData[i + k].headingText}" → ${blockData[i + k].dateKey}`);
        }
      } else {
        console.log(`Interpolation ambiguous: ${runLen} block(s), ${expected.length} expected dates between ${olderKey} and ${newerKey}`);
      }
    }
    i = j + 1;
  }

  // ── Final step: extract + render + upsert all dated blocks ───────────────
  let pushed = 0, skipped = 0;
  for (const { start, end, headingText, dateKey } of blockData) {
    if (!dateKey) {
      console.log(`Skipping undateable block: "${headingText}"`);
      skipped++;
      continue;
    }
    const content  = extractDocBlockContent(body, start, end, headingText);
    const markdown = docBlockToMarkdown(content, dateKey);
    upsertGitHubFile({
      owner, repo, headers,
      path:    `${base}/${dateKey}.md`,
      content: markdown,
      message: `Meeting notes: export ${dateKey} from Google Doc`,
    });
    pushed++;
    console.log(`Pushed ${dateKey}`);
    Utilities.sleep(300);
  }

  doc.saveAndClose();
  console.log(`exportMeetingNotesFromDoc done. pushed: ${pushed}, skipped: ${skipped}`);
}

// ── For each meeting block whose H2 title has no topic suffix (just "📅 Date"),
// logs the date heading + up to 400 chars of discussion content.
// Run this, capture the output, then use it to draft topic titles.
function dumpUntitledMeetingContent() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  const DATE_RE = /([A-Z][a-z]+ \d{1,2},\s*\d{4})/;
  const n = body.getNumChildren();

  // Collect block boundaries (same logic as migrateOldMeetingBlocks Phase 3)
  const blocks = [];
  let blockStart = -1;
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText();
    if (!text.startsWith('📅') && !DATE_RE.test(text)) continue;
    if (blockStart >= 0) blocks.push({ start: blockStart, end: i - 1 });
    blockStart = i;
  }
  if (blockStart >= 0) blocks.push({ start: blockStart, end: n - 1 });

  let count = 0;
  const results = [];
  for (const { start, end } of blocks) {
    const heading = body.getChild(start).asParagraph().getText().trim();
    // Skip if title already has a topic (has text beyond the date)
    const m = DATE_RE.exec(heading);
    if (m && heading.substring(m.index + m[0].length).replace(/^\s*[:\-–—]\s*/, '').trim().length > 0) continue;
    if (!m && heading.length > '📅 '.length + 3) continue; // chip heading with suffix

    // Collect non-blank, non-label content within the block
    const snippets = [];
    let chars = 0;
    for (let i = start + 1; i <= end && chars < 400; i++) {
      const child = body.getChild(i);
      let text = '';
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH) text = child.asParagraph().getText();
      else if (child.getType() === DocumentApp.ElementType.LIST_ITEM) text = child.asListItem().getText();
      text = text.trim();
      if (!text) continue;
      // Skip pure emoji-label lines
      if (/^[📅📋🎬👥📝➡️🤖📽️]/.test(text) && text.length < 40) continue;
      snippets.push(text);
      chars += text.length;
    }
    results.push(`=== ${heading} ===\n${snippets.join('\n').substring(0, 400)}`);
    count++;
  }
  doc.saveAndClose();
  return results.join('\n\n');
}

// Wrapper so clasp run can capture the return value (logs aren't accessible via CLI).
function dumpUntitledMeetingContentReturn() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  const DATE_RE = /([A-Z][a-z]+ \d{1,2},\s*\d{4})/;
  const n = body.getNumChildren();
  const blocks = [];
  let blockStart = -1;
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    if (para.getHeading() !== DocumentApp.ParagraphHeading.HEADING2) continue;
    const text = para.getText();
    if (!text.startsWith('📅') && !DATE_RE.test(text)) continue;
    if (blockStart >= 0) blocks.push({ start: blockStart, end: i - 1 });
    blockStart = i;
  }
  if (blockStart >= 0) blocks.push({ start: blockStart, end: n - 1 });

  const results = [];
  for (const { start, end } of blocks) {
    const heading = body.getChild(start).asParagraph().getText().trim();
    const m = DATE_RE.exec(heading);
    if (m && heading.substring(m.index + m[0].length).replace(/^\s*[:\-–—]\s*/, '').trim().length > 0) continue;
    const snippets = [];
    let chars = 0;
    for (let i = start + 1; i <= end && chars < 500; i++) {
      const child = body.getChild(i);
      let text = '';
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH) text = child.asParagraph().getText();
      else if (child.getType() === DocumentApp.ElementType.LIST_ITEM) text = child.asListItem().getText();
      text = text.trim();
      if (!text) continue;
      if (/^[📅📋🎬👥📝➡️🤖📽️]/.test(text) && text.length < 40) continue;
      snippets.push(text);
      chars += text.length;
    }
    results.push({ heading, content: snippets.join(' | ').substring(0, 500) });
  }
  doc.saveAndClose();
  return results;
}

// Logs element types for the first ~40 elements of a given date block.
// Run from Apps Script editor to diagnose blank-removal issues.
function debugBlockElements() {
  const targetDate = '📅 Nov 18, 2025'; // ← change this
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  const anchor = body.findText(escapeRegex(targetDate));
  if (!anchor) { console.log('Block not found for: ' + targetDate); return; }
  const startIdx = body.getChildIndex(anchor.getElement().getParent());
  for (let i = startIdx; i < Math.min(startIdx + 40, body.getNumChildren()); i++) {
    const child = body.getChild(i);
    const type  = child.getType().toString();
    let text = '';
    if (type === 'PARAGRAPH')  text = child.asParagraph().getText().substring(0, 60);
    if (type === 'LIST_ITEM')  text = '[LI] ' + child.asListItem().getText().substring(0, 55);
    console.log(`[${i}] ${type}: "${text}"`);
    if (i > startIdx && type === 'PARAGRAPH' && child.asParagraph().getText().startsWith('📅')) break;
  }
  doc.saveAndClose();
}

// Logs all playlist videos and shows which pending meetings they match (or don't).
// Run this from the Apps Script editor to diagnose YouTube matching issues.
function debugYouTubeMatching() {
  const pending   = getPendingMeetings();
  const unmatched = Object.keys(pending).filter(k => !pending[k].youtubeVideoId);
  console.log('Meetings without YouTube video: ' + JSON.stringify(unmatched));

  const videos = getRecentPlaylistVideos();
  console.log(`Found ${videos.length} video(s) in playlist:`);
  videos.forEach(v => console.log(`  ${v.publishedAt}  ${v.videoId}  "${v.title}"`));

  console.log('--- Match results ---');
  for (const dateKey of unmatched) {
    const match = videos.find(v => videoMatchesMeeting(v.title, v.publishedAt, dateKey));
    console.log(`${dateKey}: ${match ? 'MATCHED → "' + match.title + '"' : 'no match'}`);
  }
}
