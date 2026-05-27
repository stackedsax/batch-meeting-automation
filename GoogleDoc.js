// Google Doc automation — matches the existing meeting block format.
//
// A meeting block looks like:
//
//   📅 October 7, 2025
//   📋 Agenda:
//     • 👋 Welcome & Introductions ("Hello, why are you here?")
//     • 📦 Updates
//     • 💬 **Discussion Topics**
//   🎬 Meeting Artifacts:
//     • 📽️: Recording       ← hyperlink
//     • 📜: Transcript       ← hyperlink
//     • 🤖: AI Summary       ← partial hyperlink on "AI Summary"
//   👥 Attendees (✋Please add yourself ✋)
//     • Name (Org)
//   📝 Quick Recap:
//       [indented overview text]
//
//       ➡️ Next Steps:
//       • step 1
//   ────── [native horizontal rule] ──────
//

const MEETINGS_SECTION_HEADING = 'Meeting Agendas, Recordings and Notes';

// Label constants — used both when inserting and when detecting elements to update.
const VIDEO_LABEL      = '📽️: Recording';
const AI_SUMMARY_LABEL = '🤖: AI Summary';

// Returns the paragraph index immediately after the meetings section heading,
// so new blocks are inserted at the top of that section (reverse chron order).
function findMeetingsSectionInsertIndex(body) {
  const found = body.findText(escapeRegex(MEETINGS_SECTION_HEADING));
  if (!found) {
    console.log(`Warning: could not find "${MEETINGS_SECTION_HEADING}" heading — inserting at top`);
    return 0;
  }
  return body.getChildIndex(found.getElement().getParent()) + 1;
}

// Returns the text of a body child regardless of whether it's a Paragraph or ListItem.
function getChildText(child) {
  const type = child.getType();
  if (type === DocumentApp.ElementType.PARAGRAPH)  return child.asParagraph().getText();
  if (type === DocumentApp.ElementType.LIST_ITEM)  return child.asListItem().getText();
  return '';
}

// Returns true if the body child is a divider — native horizontal rule
// or old text-based divider (backward compat during cleanup).
function isDivider(child) {
  if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) return false;
  const para = child.asParagraph();
  if (para.getNumChildren() > 0 &&
      para.getChild(0).getType() === DocumentApp.ElementType.HORIZONTAL_RULE) return true;
  if (para.getText().startsWith('──')) return true;
  return false;
}

// Best-effort extraction of attendees from AI summary text.
// Returns an array of name strings, or null if not found.
function extractAttendeesFromSummary(summaryContent) {
  if (!summaryContent) return null;
  const match = summaryContent.match(
    /(?:attendees?|participants?)[:\s]*\n([\s\S]*?)(?:\n\n|$)/i
  );
  if (!match) return null;
  const names = match[1]
    .split('\n')
    .map(l => l.replace(/^[-•*\d.]\s*/, '').trim())
    .filter(l => l.length > 2 && l.length < 100);
  return names.length > 0 ? names : null;
}

// Sets a hyperlink on a substring of a Paragraph or ListItem.
// linkText must appear somewhere in label.
function setPartialLink(el, label, linkText, url) {
  el.setText(label);
  const start = label.indexOf(linkText);
  el.editAsText().setLinkUrl(start, start + linkText.length - 1, url);
}

// Returns the index of the last element in the meeting block starting at anchorIdx.
// A block ends just before the next 📅 H2 heading or horizontal rule.
function findBlockEnd(body, anchorIdx) {
  let blockEnd = body.getNumChildren() - 1;
  for (let i = anchorIdx + 1; i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.HORIZONTAL_RULE) { blockEnd = i - 1; break; }
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const para = child.asParagraph();
      if (para.getHeading() === DocumentApp.ParagraphHeading.HEADING2 && para.getText().startsWith('📅')) {
        blockEnd = i - 1; break;
      }
    }
  }
  return blockEnd;
}

// Injects missing Quick Recap / Next Steps / Summary sections into an existing
// meeting block. Safe to call multiple times — skips sections already present.
function injectSummaryIntoBlock(body, anchorIdx, blockEnd, state) {
  if (!state.summaryContent &&
      !(state.summaryNextSteps && state.summaryNextSteps.length) &&
      !(state.summaryDetails   && state.summaryDetails.length)) return;

  const RECAP_PLACEHOLDER = '_(summary will appear here once the meeting recording is processed)_';
  let hasRecap = false, hasNextSteps = false, hasSummary = false;
  for (let i = anchorIdx + 1; i <= blockEnd && i < body.getNumChildren(); i++) {
    const child = body.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const para = child.asParagraph();
    const text = para.getText().trim();
    if (text.startsWith('📝'))        hasRecap     = true;
    if (text.startsWith('➡️'))        hasNextSteps = true;
    if (text.startsWith('📋 Summary')) hasSummary   = true;
    // Replace placeholder recap body with real content
    if (text === RECAP_PLACEHOLDER && state.summaryContent) para.setText(state.summaryContent);
  }

  if (hasRecap && hasNextSteps && hasSummary) return;

  // Build insert list in display order; insert in reverse so index stays stable.
  const insertAt = blockEnd + 1;
  const toInsert = [];

  if (!hasRecap && state.summaryContent) {
    toInsert.push({ type: 'para', text: '📝 Quick Recap:' });
    toInsert.push({ type: 'para', text: state.summaryContent });
    toInsert.push({ type: 'para', text: '' });
  }
  if (!hasNextSteps && state.summaryNextSteps && state.summaryNextSteps.length) {
    toInsert.push({ type: 'para', text: '➡️ Next Steps:' });
    for (const step of state.summaryNextSteps)
      toInsert.push({ type: 'list', text: step });
    toInsert.push({ type: 'para', text: '' });
  }
  if (!hasSummary && state.summaryDetails && state.summaryDetails.length) {
    toInsert.push({ type: 'para', text: '📋 Summary:' });
    for (const detail of state.summaryDetails) {
      if (detail.label)   toInsert.push({ type: 'para', text: detail.label, bold: true });
      if (detail.summary) toInsert.push({ type: 'para', text: detail.summary });
      toInsert.push({ type: 'para', text: '' });
    }
  }

  for (let k = toInsert.length - 1; k >= 0; k--) {
    const item = toInsert[k];
    if (item.type === 'list') {
      body.insertListItem(insertAt, item.text).setGlyphType(DocumentApp.GlyphType.BULLET);
    } else {
      const para = body.insertParagraph(insertAt, item.text);
      if (item.bold && item.text.length > 0)
        para.editAsText().setBold(0, item.text.length - 1, true);
    }
  }
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
    console.log(`Google Doc block already exists for ${dateKey} — updating`);
    const anchorPara = existing.getElement().getParent().asParagraph();
    const anchorIdx  = body.getChildIndex(anchorPara);
    // Strip [UPCOMING] suffix if still present
    const headingText = anchorPara.getText();
    if (headingText.includes('[UPCOMING]'))
      anchorPara.setText(headingText.replace(/\s*\[UPCOMING\]/, ''));
    injectSummaryIntoBlock(body, anchorIdx, findBlockEnd(body, anchorIdx), state);
    doc.saveAndClose();
    updateGoogleDocVideoLinks(dateKey);
    return;
  }

  console.log(`Inserting Google Doc block for ${dateKey}`);

  // Remove the [UPCOMING] placeholder if it was pre-populated
  removeUpcomingPlaceholder(body, dateKey);

  let i = findMeetingsSectionInsertIndex(body);

  // Date heading
  body.insertParagraph(i++, `📅 ${keyToDisplayDate(dateKey)}`).setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // Agenda
  body.insertParagraph(i++, '📋 Agenda:');
  body.insertListItem(i++, '👋 Welcome & Introductions ("Hello, why are you here?")').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, '📦 Updates').setGlyphType(DocumentApp.GlyphType.BULLET);
  const discussionItem = body.insertListItem(i++, '💬 Discussion Topics').setGlyphType(DocumentApp.GlyphType.BULLET);
  const discLabel = '💬 Discussion Topics';
  const discBoldStart = discLabel.indexOf('Discussion Topics');
  discussionItem.editAsText().setBold(discBoldStart, discBoldStart + 'Discussion Topics'.length - 1, true);
  body.insertParagraph(i++, '').editAsText().setBold(false); // break bold inheritance

  // Meeting Artifacts (recording, transcript, AI summary)
  body.insertParagraph(i++, '🎬 Meeting Artifacts:');
  if (state.youtubeUrl) {
    setPartialLink(
      body.insertListItem(i++, VIDEO_LABEL).setGlyphType(DocumentApp.GlyphType.BULLET),
      VIDEO_LABEL, 'Recording', state.youtubeUrl
    );
  } else {
    body.insertListItem(i++, '📽️: _(uploading — will update automatically)_').setGlyphType(DocumentApp.GlyphType.BULLET);
  }
  if (state.summaryLink) {
    setPartialLink(
      body.insertListItem(i++, AI_SUMMARY_LABEL).setGlyphType(DocumentApp.GlyphType.BULLET),
      AI_SUMMARY_LABEL, 'AI Summary', state.summaryLink
    );
  } else {
    body.insertListItem(i++, '🤖: AI Summary _(processing)_').setGlyphType(DocumentApp.GlyphType.BULLET);
  }
  body.insertParagraph(i++, '');

  // Attendees — try to extract from AI summary, fall back to hardcoded hosts
  body.insertParagraph(i++, '👥 Attendees (✋Please add yourself ✋)');
  const attendees = extractAttendeesFromSummary(state.summaryContent) || [
    'Alex Scammon (G-Research) [host]',
    'Abhishek Malvankar (Red Hat) [host]',
    'Marlow Warnicke (NVIDIA) [host]',
  ];
  for (const name of attendees) {
    body.insertListItem(i++, name).setGlyphType(DocumentApp.GlyphType.BULLET);
  }
  body.insertParagraph(i++, '');

  // Quick Recap — overview paragraph
  body.insertParagraph(i++, '📝 Quick Recap:');
  body.insertParagraph(i++, ''); // extra space before body
  if (state.summaryContent) {
    body.insertParagraph(i++, state.summaryContent);
  } else {
    body.insertParagraph(i++, '_(summary will appear here once the meeting recording is processed)_');
  }
  body.insertParagraph(i++, '');

  // Next Steps
  if (state.summaryNextSteps && state.summaryNextSteps.length > 0) {
    body.insertParagraph(i++, '➡️ Next Steps:');
    for (const step of state.summaryNextSteps) {
      body.insertListItem(i++, step).setGlyphType(DocumentApp.GlyphType.BULLET);
    }
    body.insertParagraph(i++, '');
  }

  // Discussion Summary — labeled sections from summary_details
  if (state.summaryDetails && state.summaryDetails.length > 0) {
    body.insertParagraph(i++, '📋 Summary:');
    body.insertParagraph(i++, ''); // extra space before first section
    for (const section of state.summaryDetails) {
      if (section.label) {
        body.insertParagraph(i++, section.label).editAsText().setBold(true);
        body.insertParagraph(i++, '').editAsText().setBold(false); // break bold bleed
      }
      if (section.summary) {
        body.insertParagraph(i++, section.summary);
      }
      body.insertParagraph(i++, '');
    }
  }

  // Native horizontal rule divider
  body.insertHorizontalRule(i++);
  body.insertParagraph(i++, '');

  doc.saveAndClose();
  console.log(`Google Doc updated for ${dateKey}`);
}

// Updates the video/transcript/summary links inside an existing meeting block.
// All links are rendered as labeled hyperlinks (no raw URLs in text).
function updateGoogleDocVideoLinks(dateKey) {
  const state = getMeetingState(dateKey);
  if (!state || (!state.youtubeUrl && !state.transcript && !state.summaryLink)) return;

  const doc    = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body   = doc.getBody();
  const marker = escapeRegex(`📅 ${keyToDisplayDate(dateKey)}`);
  const anchor = body.findText(marker);

  if (!anchor) {
    console.log(`Could not find Google Doc block for ${dateKey}`);
    doc.saveAndClose();
    return;
  }

  const anchorIdx = body.getChildIndex(anchor.getElement().getParent());

  // Scan the next 25 elements: update existing placeholders and track attendees index.
  let videoFound = false, summaryFound = false, attendeesIdx = -1;
  for (let i = anchorIdx + 1; i < Math.min(anchorIdx + 25, body.getNumChildren()); i++) {
    const child = body.getChild(i);
    if (isDivider(child)) break;

    const type = child.getType();
    let el;
    if (type === DocumentApp.ElementType.PARAGRAPH)  el = child.asParagraph();
    else if (type === DocumentApp.ElementType.LIST_ITEM) el = child.asListItem();
    else continue;

    const text = el.getText();

    if (text.startsWith('👥') && attendeesIdx === -1) attendeesIdx = i;

    // Track presence regardless of whether update is needed (prevents duplicate insertion)
    if (text.startsWith('📽️:')) videoFound = true;
    if (text.startsWith('🤖:')) summaryFound = true;

    // Video: placeholder → hyperlink
    if (text.startsWith('📽️:') && state.youtubeUrl && text !== VIDEO_LABEL)
      setPartialLink(el, VIDEO_LABEL, 'Recording', state.youtubeUrl);
    // AI Summary: placeholder → hyperlink
    else if (text.startsWith('🤖:') && state.summaryLink && text !== AI_SUMMARY_LABEL)
      setPartialLink(el, AI_SUMMARY_LABEL, 'AI Summary', state.summaryLink);
  }

  // Pre-populated blocks have no 📽️/🤖 lines at all — insert the full artifacts
  // section before the 👥 Attendees line if neither is present.
  if (!videoFound && !summaryFound && attendeesIdx > -1) {
    const ins = attendeesIdx;
    // Insert in reverse display order so first element ends up at ins
    body.insertParagraph(ins, '');
    if (state.summaryLink) {
      setPartialLink(
        body.insertListItem(ins, AI_SUMMARY_LABEL).setGlyphType(DocumentApp.GlyphType.BULLET),
        AI_SUMMARY_LABEL, 'AI Summary', state.summaryLink
      );
    } else {
      body.insertListItem(ins, '🤖: AI Summary _(processing)_').setGlyphType(DocumentApp.GlyphType.BULLET);
    }
    if (state.youtubeUrl) {
      setPartialLink(
        body.insertListItem(ins, VIDEO_LABEL).setGlyphType(DocumentApp.GlyphType.BULLET),
        VIDEO_LABEL, 'Recording', state.youtubeUrl
      );
    } else {
      body.insertListItem(ins, '📽️: _(uploading — will update automatically)_').setGlyphType(DocumentApp.GlyphType.BULLET);
    }
    body.insertParagraph(ins, '🎬 Meeting Artifacts:');
  }

  doc.saveAndClose();
  console.log(`Google Doc links updated for ${dateKey}`);
}

// Pre-populates an upcoming meeting block 7 days before the meeting.
// Inserts at the top with an [UPCOMING] marker so it can be found and replaced later.
function prepopulateUpcomingMeeting() {
  const nextMeeting = getNextMeetingDate();
  const daysUntil   = (nextMeeting.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

  if (daysUntil < 10 || daysUntil > 12) return;

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

  console.log(`Pre-populating Google Doc for upcoming meeting ${dateKey}`);
  let i = findMeetingsSectionInsertIndex(body);

  body.insertParagraph(i++, `📅 ${displayDate} [UPCOMING]`).setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.insertParagraph(i++, '📋 Agenda:');
  body.insertListItem(i++, '👋 Welcome & Introductions ("Hello, why are you here?")').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, '📦 Updates').setGlyphType(DocumentApp.GlyphType.BULLET);
  const discUpcomingLabel = '💬 Discussion Topics — add yours below:';
  const discItem = body.insertListItem(i++, discUpcomingLabel).setGlyphType(DocumentApp.GlyphType.BULLET);
  const discUpcomingStart = discUpcomingLabel.indexOf('Discussion Topics');
  discItem.editAsText().setBold(discUpcomingStart, discUpcomingStart + 'Discussion Topics'.length - 1, true);
  body.insertParagraph(i++, '').editAsText().setBold(false); // break bold inheritance

  body.insertParagraph(i++, '👥 Attendees (✋Please add yourself ✋)');
  body.insertListItem(i++, 'Alex Scammon (G-Research) [host]').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, 'Abhishek Malvankar (Red Hat) [host]').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, 'Marlow Warnicke (NVIDIA) [host]').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, '').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertListItem(i++, '').setGlyphType(DocumentApp.GlyphType.BULLET);
  body.insertParagraph(i++, '');

  body.insertHorizontalRule(i++);
  body.insertParagraph(i++, '');

  doc.saveAndClose();
  setMeetingState(dateKey, { prepopulated: true });
  console.log(`Pre-populated Google Doc for ${dateKey}`);
}

// Removes the [UPCOMING] heading placeholder when replacing with a real block.
function removeUpcomingPlaceholder(body, dateKey) {
  const marker = escapeRegex(`📅 ${keyToDisplayDate(dateKey)} [UPCOMING]`);
  let found = body.findText(marker);
  while (found) {
    const para = found.getElement().getParent();
    const idx  = body.getChildIndex(para);
    let j = idx;
    while (j < body.getNumChildren()) {
      const child = body.getChild(j);
      if (j > idx && isDivider(child)) {
        body.getChild(j).removeFromParent(); // remove divider too
        break;
      }
      body.getChild(j).removeFromParent();
      // Don't increment j — after removal getChild(j) is the next element
    }
    found = body.findText(marker);
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One-time cleanup: remove all 📜: transcript lines from existing meeting blocks.
function removeTranscriptLinesFromDoc() {
  const doc  = DocumentApp.openById(getConfig(CONFIG_KEYS.GOOGLE_DOC_ID));
  const body = doc.getBody();
  let removed = 0;

  // Walk backwards so removal doesn't shift indices
  for (let i = body.getNumChildren() - 1; i >= 0; i--) {
    const child = body.getChild(i);
    const text = getChildText(child);
    if (text.startsWith('📜:')) {
      child.removeFromParent();
      removed++;
    }
  }

  doc.saveAndClose();
  console.log(`Removed ${removed} transcript line(s) from Google Doc`);
}
