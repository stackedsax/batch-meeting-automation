// Watches a Gmail label for LFX AI Meeting Summary emails.
// Set up a Gmail filter to apply the label (default: "LFX-Batch-Summary")
// to emails matching: from:meetings@lfx.dev subject:"AI Meeting Summary Completed: Batch Subproject"

const LFX_SUBJECT_MARKER = 'AI Meeting Summary Completed: Batch Subproject';
const PROCESSED_LABEL_SUFFIX = '/processed';

function processLFXSummaryEmails() {
  const labelName = getConfig(CONFIG_KEYS.GMAIL_LABEL);
  const pendingLabel = GmailApp.getUserLabelByName(labelName);

  if (!pendingLabel) {
    Logger.log(`Gmail label "${labelName}" not found. Create it and set up a filter.`);
    return;
  }

  const processedLabel = GmailApp.getUserLabelByName(labelName + PROCESSED_LABEL_SUFFIX)
    || GmailApp.createLabel(labelName + PROCESSED_LABEL_SUFFIX);

  const threads = pendingLabel.getThreads(0, 20);

  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      const subject = message.getSubject();
      if (!subject.includes(LFX_SUBJECT_MARKER)) continue;

      const dateKey = parseDateFromEmailSubject(subject);
      if (!dateKey) {
        Logger.log(`Could not parse date from: "${subject}"`);
        continue;
      }

      const existing = getMeetingState(dateKey);
      if (existing && existing.summaryProcessed) {
        Logger.log(`Already processed summary for ${dateKey}`);
        continue;
      }

      Logger.log(`Processing LFX summary email for ${dateKey}`);

      const summaryLink = extractSummaryLink(message.getBody());
      const summaryContent = summaryLink ? fetchSummaryContent(summaryLink) : null;

      setMeetingState(dateKey, {
        summaryProcessed: true,
        summaryLink,
        summaryContent,
        emailProcessedAt: new Date().toISOString(),
      });

      createOrUpdateGitHubEntry(dateKey);
      upsertMeetingInGoogleDoc(dateKey);

      thread.removeLabel(pendingLabel);
      thread.addLabel(processedLabel);
      Logger.log(`Done processing ${dateKey}`);
    }
  }
}

// Pull the LFX summary URL out of the email HTML body.
function extractSummaryLink(htmlBody) {
  const match = htmlBody.match(
    /https:\/\/zoom-lfx\.platform\.linuxfoundation\.org\/meeting\/[^\s"'<>]*summaries[^\s"'<>]*/
  );
  return match ? match[0] : null;
}

// Fetch summary text from LFX. Tries without the password param first.
// Note: the LFX summary page is a JavaScript SPA — UrlFetchApp only gets
// the raw HTML shell. We detect this and fall back to linking only.
function fetchSummaryContent(summaryLink) {
  const urls = [
    summaryLink.split('?')[0],  // without password
    summaryLink,                 // with password as fallback
  ];

  for (const url of urls) {
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() === 200) {
        const raw = response.getContentText();
        // Detect JS SPA shell — contains CSS but no real text content
        if (raw.includes('@font-face') || raw.includes('text/javascript')) {
          Logger.log(`LFX page at ${url} is a JS SPA — cannot extract content, will link only`);
          return null;
        }
        const text = parseSummaryFromHtml(raw);
        if (text && text.length > 100) {
          Logger.log(`Fetched summary content (${text.length} chars) from ${url}`);
          return text;
        }
      }
    } catch (e) {
      Logger.log(`Error fetching ${url}: ${e}`);
    }
  }

  Logger.log('Could not fetch summary content — will link only');
  return null;
}

// Best-effort extraction of the summary body text from the LFX HTML page.
// May need tuning once we see the actual page structure.
function parseSummaryFromHtml(html) {
  // Try common summary container patterns
  const patterns = [
    /<div[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{3,}/g, '\n\n')
        .trim();
    }
  }

  // Fallback: strip all tags and truncate
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .substring(0, 8000);
}
