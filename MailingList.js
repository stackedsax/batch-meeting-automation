// Sends meeting notes to the CNCF batch mailing list via GmailApp.

function sendToMailingList(dateKey) {
  const mailingList = getConfig(CONFIG_KEYS.MAILING_LIST_EMAIL);
  if (!mailingList) {
    Logger.log('MAILING_LIST_EMAIL not configured — skipping');
    return;
  }

  const state       = getMeetingState(dateKey);
  const displayDate = keyToDisplayDate(dateKey);
  const docUrl      = `https://docs.google.com/document/d/${getConfig(CONFIG_KEYS.GOOGLE_DOC_ID)}/edit`;
  const owner       = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo        = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const basePath    = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const ghUrl       = `https://github.com/${owner}/${repo}/tree/main/${basePath}/${dateKey}`;
  const nextMeeting = keyToDisplayDate(dateToKey(getNextMeetingDate()));
  const zoomUrl     = 'https://zoom-lfx.platform.linuxfoundation.org/meeting/99965231171?password=2a169dd5-e375-4b5a-9b40-b2b5db5bfe91';

  const lines = [
    `Hi all,`,
    ``,
    `Meeting notes from the CNCF Batch Subproject meeting on ${displayDate} are now available.`,
    ``,
    `── Resources ──────────────────────────────────────`,
    state.youtubeUrl  ? `📽️  Recording:   ${state.youtubeUrl}`  : '📽️  Recording:   uploading soon',
    state.summaryLink ? `🤖  AI Summary:  ${state.summaryLink}` : '',
    `📝  Full Notes:  ${docUrl}`,
    `📂  Transcript:  ${ghUrl}`,
    `────────────────────────────────────────────────────`,
    ``,
  ];

  if (state.summaryContent) {
    lines.push(`── AI Meeting Summary ──────────────────────────────`);
    lines.push('');
    lines.push(state.summaryContent);
    lines.push('');
    lines.push(`────────────────────────────────────────────────────`);
    lines.push('');
  }

  lines.push(`── Next Meeting ────────────────────────────────────`);
  lines.push(`📅  ${nextMeeting} at 8am PDT`);
  lines.push(`🔗  ${zoomUrl}`);
  lines.push(`────────────────────────────────────────────────────`);
  lines.push('');
  lines.push('— CNCF Batch Subproject');

  GmailApp.sendEmail(
    mailingList,
    `[Batch Subproject] Meeting Notes — ${displayDate}`,
    lines.filter(l => l !== null).join('\n')
  );

  Logger.log(`Mailing list email sent to ${mailingList}`);
}
