// Watches a Gmail label for LFX AI Meeting Summary emails.
// Set up a Gmail filter to apply the label (default: "LFX-Batch-Summary")
// to emails matching: from:meetings@lfx.dev subject:"AI Meeting Summary Completed: Batch Subproject"

const LFX_SUBJECT_MARKER = 'AI Meeting Summary Completed: Batch Subproject';
const PROCESSED_LABEL_SUFFIX = '/processed';

function processLFXSummaryEmails() {
  const labelName = getConfig(CONFIG_KEYS.GMAIL_LABEL);
  const pendingLabel = GmailApp.getUserLabelByName(labelName);

  if (!pendingLabel) {
    console.log(`Gmail label "${labelName}" not found. Create it and set up a filter.`);
    return;
  }

  const processedLabel = GmailApp.getUserLabelByName(labelName + PROCESSED_LABEL_SUFFIX)
    || GmailApp.createLabel(labelName + PROCESSED_LABEL_SUFFIX);

  // Reverse so oldest threads are processed first — each new block is inserted
  // at the top of the section, so oldest ends up at the bottom (newest at top).
  const threads = pendingLabel.getThreads(0, 20).reverse();

  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      const subject = message.getSubject();
      if (!subject.includes(LFX_SUBJECT_MARKER)) continue;

      const dateKey = parseDateFromEmailSubject(subject);
      if (!dateKey) {
        console.log(`Could not parse date from: "${subject}"`);
        continue;
      }

      const existing = getMeetingState(dateKey);
      if (existing && existing.summaryProcessed) {
        console.log(`Already processed summary for ${dateKey}`);
        continue;
      }

      console.log(`Processing LFX summary email for ${dateKey}`);

      const summaryLink   = extractSummaryLink(message.getBody());
      const summaryParsed = summaryLink ? fetchSummaryContent(summaryLink) : null;

      setMeetingState(dateKey, {
        summaryProcessed: true,
        summaryLink,
        summaryContent:   summaryParsed ? summaryParsed.content   : null,
        summaryDetails:   summaryParsed ? summaryParsed.details   : null,
        summaryNextSteps: summaryParsed ? summaryParsed.nextSteps : null,
        emailProcessedAt: new Date().toISOString(),
      });

      createOrUpdateGitHubEntry(dateKey);
      upsertMeetingInGoogleDoc(dateKey);

      thread.removeLabel(pendingLabel);
      thread.addLabel(processedLabel);
      console.log(`Done processing ${dateKey}`);
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

// Convert an LFX summary page URL to the PCC BFF API endpoint.
// https://zoom-lfx.platform.linuxfoundation.org/meeting/{id}/summaries?password=X
//   → https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/past_meetings/{id}/summaries?password=X
function lfxUrlToApiUrl(summaryLink) {
  const match = summaryLink.match(/\/meeting\/([^/]+)\/summaries(.*)/);
  if (!match) return null;
  return `https://pcc-bff.platform.linuxfoundation.org/production/api/v2/itx-services/public/past_meetings/${match[1]}/summaries${match[2]}`;
}

// Parse the summary out of the PCC BFF JSON response.
// Returns { content: string|null, nextSteps: string[] }, or null on failure.
// The API returns an array of objects with these fields:
//   summary_overview / edited_summary_overview  — high-level summary
//   summary_details  / edited_summary_details   — longer breakdown (may be null/object)
//   next_steps                                  — array of action item strings
// Corrects known AI transcription mis-hearings in summary text.
function correctMishearings(text) {
  if (!text) return text;
  return text
    .replace(/\bQ\b(?![&\d])/g, 'Kueue')   // "Q" alone → "Kueue" (except Q&A, Q1, etc.)
    .replace(/\bTALK members\b/gi, 'TOC members');
}

function parseSummaryFromJson(json) {
  try {
    const data = JSON.parse(json);
    const item = Array.isArray(data) ? data[0] : data;
    if (!item) return null;

    const str = v => (typeof v === 'string' ? v.trim() : '');

    const overview = correctMishearings(str(item.edited_summary_overview) || str(item.summary_overview));

    // summary_details is an array of {label, summary} objects
    const rawDetails = item.edited_summary_details || item.summary_details;
    let details = [];
    if (Array.isArray(rawDetails)) {
      details = rawDetails.map(d => ({
        label:   correctMishearings(str(d.label   || d.topic || '')),
        summary: correctMishearings(str(d.summary || '')),
      })).filter(d => d.label || d.summary);
    } else if (str(rawDetails)) {
      details = [{ label: null, summary: correctMishearings(str(rawDetails)) }];
    }

    // Strip any leading bullet characters the API includes
    const rawSteps = item.edited_next_steps || item.next_steps;
    const nextSteps = Array.isArray(rawSteps)
      ? rawSteps.map(s => correctMishearings(String(s).replace(/^[•\-*]\s*/, '').trim())).filter(Boolean)
      : [];

    if (!overview && details.length === 0 && nextSteps.length === 0) {
      console.log('Unknown API response shape. Keys: ' + Object.keys(item).join(', '));
      return null;
    }

    return { content: overview, details, nextSteps };
  } catch (e) {
    console.log('JSON parse error: ' + e);
    return null;
  }
}

// Fetch summary from the LFX PCC BFF API.
// Returns { content: string|null, nextSteps: string[] }, or null if unavailable.
function fetchSummaryContent(summaryLink) {
  const apiUrl = lfxUrlToApiUrl(summaryLink);
  if (!apiUrl) {
    console.log('Could not construct API URL from: ' + summaryLink);
    return null;
  }

  const headers = {
    'accept': 'application/json',
    'origin': 'https://zoom-lfx.platform.linuxfoundation.org',
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, { headers, muteHttpExceptions: true });
    const code = response.getResponseCode();
    console.log(`LFX API ${apiUrl} → ${code}`);

    if (code === 200) {
      const parsed = parseSummaryFromJson(response.getContentText());
      if (parsed && (parsed.content || parsed.nextSteps.length > 0)) {
        console.log(`Got summary: ${(parsed.content || '').length} chars, ${parsed.nextSteps.length} next steps`);
        return parsed;
      }
      console.log('Raw API response (first 500 chars): ' + response.getContentText().substring(0, 500));
    }
  } catch (e) {
    console.log('Error fetching LFX API: ' + e);
  }

  console.log('Could not fetch summary content — will link only');
  return null;
}

// Legacy HTML parser kept for reference but no longer used.
function fetchSummaryContent_html_fallback(summaryLink) {
  const urls = [summaryLink];
  for (const url of urls) {
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() === 200) {
        const raw = response.getContentText();
        if (raw.includes('@font-face') || raw.includes('text/javascript')) {
          return null;
        }
        const text = parseSummaryFromHtml(raw);
        if (text && text.length > 100) {
          return text;
        }
      }
    } catch (e) {
      console.log(`Error fetching ${url}: ${e}`);
    }
  }

  console.log('Could not fetch summary content — will link only');
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
