// Google Doc automation — matches the existing meeting block format.
//
// A meeting block looks like:
//
//   📅 October 7, 2025
//   Agenda: ...
//   Recording and Transcript: ...
//   👥 Attendees (✋Please add yourself ✋)
//   ...
//   Discussion Notes:
//   ...
//   ───────────────────────────────
//

const DOC_DIVIDER = '───────────────────────────────────────────────';
// The exact heading text of the section where meeting blocks live.
const MEETINGS_SECTION_HEADING = 'Meeting Agendas, Recordings and Notes';

// Returns the paragraph index immediately after the meetings section heading,
// so new blocks are inserted at the top of that section (reverse chron order).
function findMeetingsSectionInsertIndex(body) {
  const found = body.findText(escapeRegex(MEETINGS_SECTION_HEADING));
  if (!found) {
    Logger.log(`Warning: could not find "${MEETINGS_SECTION_HEADING}" heading — inserting at top`);
    return 0;
  }
  return body.getChildIndex(found.getElement().getParent()) + 1;
}

// Called when the LFX email arrives. Inserts a new meeting block at the top
// of the "Meeting Agendas, Recordings and Notes" section (newest first).
// If the block for this date already exists, updates it in place.
function upsertMeetingInGoogleDoc(dateKey) {
  const state = getMeetingState(dateKey) || {};
  const doc   = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body  = doc.getBody();

  // Check if this date already has a block (avoid duplicates on re-run)
  const marker = `📅 ${keyToDisplayDate(dateKey)}`;
  const existing = body.findText(escapeRegex(marker));

  if (existing) {
    Logger.log(`Google Doc block already exists for ${dateKey} — updating links only`);
    updateGoogleDocVideoLinks(dateKey);
    doc.saveAndClose();
    return;
  }

  Logger.log(`Inserting Google Doc block for ${dateKey}`);

  // Remove the [UPCOMING] placeholder if it was pre-populated
  removeUpcomingPlaceholder(body, dateKey);

  // Date heading
  const heading = body.insertParagraph(i++, `📅 ${keyToDisplayDate(dateKey)}`);
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // Agenda
  body.insertParagraph(i++, 'Agenda:').setHeading(DocumentApp.ParagraphHeading.NORMAL);
  body.insertParagraph(i++, '👋 Welcome & Introductions ("Hello, why are you here?")');
  body.insertParagraph(i++, '📦 Updates');
  body.insertParagraph(i++, '💬 Discussion Topics');
  body.insertParagraph(i++, '');

  // Recording links
  body.insertParagraph(i++, 'Recording and Transcript:');
  body.insertParagraph(i++, state.youtubeUrl
    ? `📽️: ${state.youtubeUrl}`
    : '📽️: _(uploading — will update automatically)_');
  body.insertParagraph(i++, '📜: _(will update automatically)_');
  body.insertParagraph(i++, state.summaryLink
    ? `🤖 AI Summary: ${state.summaryLink}`
    : '🤖 AI Summary: _(processing)_');
  body.insertParagraph(i++, '');

  // Attendees
  body.insertParagraph(i++, '👥 Attendees (✋Please add yourself ✋)');
  body.insertParagraph(i++, 'Alex Scammon (G-Research) [host]');
  body.insertParagraph(i++, 'Abhishek Malvankar (Red Hat) [host]');
  body.insertParagraph(i++, 'Marlow Warnicke (NVIDIA) [host]');
  body.insertParagraph(i++, '');

  // Discussion Notes
  body.insertParagraph(i++, 'Discussion Notes:');
  body.insertParagraph(i++, state.summaryContent
    || '_(AI summary will appear here once the meeting recording is processed)_');
  body.insertParagraph(i++, '');

  // Divider
  body.insertParagraph(i++, DOC_DIVIDER);
  body.insertParagraph(i++, '');

  doc.saveAndClose();
  Logger.log(`Google Doc updated for ${dateKey}`);
}

// Updates the video/transcript/summary links inside an existing meeting block.
function updateGoogleDocVideoLinks(dateKey) {
  const state = getMeetingState(dateKey);
  if (!state || !state.youtubeUrl) return;

  const doc    = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body   = doc.getBody();
  const marker = escapeRegex(`📅 ${keyToDisplayDate(dateKey)}`);
  const anchor = body.findText(marker);

  if (!anchor) {
    Logger.log(`Could not find Google Doc block for ${dateKey}`);
    doc.saveAndClose();
    return;
  }

  const anchorIdx = body.getChildIndex(anchor.getElement().getParent());

  // Scan the next 20 paragraphs for placeholders to replace
  for (let i = anchorIdx + 1; i < Math.min(anchorIdx + 20, body.getNumChildren()); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;

    const para = child.asParagraph();
    const text = para.getText();

    if (text.startsWith('📽️:') && !text.includes('http')) {
      para.setText(`📽️: ${state.youtubeUrl}`);
    } else if (text.startsWith('📜:') && state.transcript) {
      const owner    = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
      const repo     = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
      const basePath = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
      para.setText(`📜: https://github.com/${owner}/${repo}/blob/main/${basePath}/${dateKey}/transcript.vtt`);
    } else if (text.startsWith('🤖 AI Summary:') && state.summaryLink && !text.includes('http')) {
      para.setText(`🤖 AI Summary: ${state.summaryLink}`);
    }

    // Stop at the divider
    if (text.startsWith('──')) break;
  }

  doc.saveAndClose();
  Logger.log(`Google Doc video links updated for ${dateKey}`);
}

// Pre-populates an upcoming meeting block 7 days before the meeting.
// Inserts at the top with an [UPCOMING] marker so it can be found and replaced later.
function prepopulateUpcomingMeeting() {
  const nextMeeting = getNextMeetingDate();
  const daysUntil   = (nextMeeting.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntil < 6 || daysUntil > 8) return;

  const dateKey = dateToKey(nextMeeting);
  const state   = getMeetingState(dateKey);
  if (state && state.prepopulated) return;

  const displayDate = keyToDisplayDate(dateKey);
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();

  // Don't insert if already there
  if (body.findText(escapeRegex(`📅 ${displayDate}`))) {
    doc.saveAndClose();
    return;
  }

  Logger.log(`Pre-populating Google Doc for upcoming meeting ${dateKey}`);
  let i = findMeetingsSectionInsertIndex(body);

  const heading = body.insertParagraph(i++, `📅 ${displayDate} [UPCOMING]`);
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING2);

  body.insertParagraph(i++, 'Agenda:');
  body.insertParagraph(i++, '👋 Welcome & Introductions ("Hello, why are you here?")');
  body.insertParagraph(i++, '📦 Updates');
  body.insertParagraph(i++, '💬 Discussion Topics — add yours below:');
  body.insertParagraph(i++, '\t•');
  body.insertParagraph(i++, '');

  body.insertParagraph(i++, '👥 Attendees (✋Please add yourself ✋)');
  body.insertParagraph(i++, 'Alex Scammon (G-Research) [host]');
  body.insertParagraph(i++, 'Abhishek Malvankar (Red Hat) [host]');
  body.insertParagraph(i++, 'Marlow Warnicke (NVIDIA) [host]');
  body.insertParagraph(i++, '');

  body.insertParagraph(i++, DOC_DIVIDER);
  body.insertParagraph(i++, '');

  doc.saveAndClose();
  setMeetingState(dateKey, { prepopulated: true });
  Logger.log(`Pre-populated Google Doc for ${dateKey}`);
}

// Removes the [UPCOMING] heading placeholder when replacing with a real block.
function removeUpcomingPlaceholder(body, dateKey) {
  const marker = escapeRegex(`📅 ${keyToDisplayDate(dateKey)} [UPCOMING]`);
  let found = body.findText(marker);
  while (found) {
    const para = found.getElement().getParent();
    const idx  = body.getChildIndex(para);
    // Remove the upcoming block: heading + agenda lines until the divider
    let j = idx;
    while (j < body.getNumChildren()) {
      const child = body.getChild(j);
      const text  = child.getType() === DocumentApp.ElementType.PARAGRAPH
        ? child.asParagraph().getText()
        : '';
      if (j > idx && text.startsWith('──')) {
        body.getChild(j).removeFromParent(); // remove divider too
        break;
      }
      body.getChild(j).removeFromParent();
    }
    found = body.findText(marker);
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
