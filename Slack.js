// Posts meeting notes summary to Slack via an incoming webhook.
// Requires SLACK_WEBHOOK_URL to be set in Script Properties.
// Request a webhook for #batch-wg from CNCF Slack admins (#cncf-staff).

function postToSlack(dateKey) {
  const webhookUrl = getConfig(CONFIG_KEYS.SLACK_WEBHOOK_URL);
  if (!webhookUrl) {
    Logger.log('SLACK_WEBHOOK_URL not configured — skipping Slack notification');
    return;
  }

  const state       = getMeetingState(dateKey);
  const displayDate = keyToDisplayDate(dateKey);
  const docUrl      = `https://docs.google.com/document/d/${getConfig(CONFIG_KEYS.GOOGLE_DOC_ID)}/edit`;
  const owner       = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo        = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const basePath    = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const ghUrl       = `https://github.com/${owner}/${repo}/tree/main/${basePath}/${dateKey}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📅 Batch Subproject Meeting Notes — ${displayDate}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        state.youtubeUrl
          ? { type: 'mrkdwn', text: `📽️ *Recording:*\n<${state.youtubeUrl}|Watch on YouTube>` }
          : { type: 'mrkdwn', text: '📽️ *Recording:*\n_(uploading soon)_' },
        state.summaryLink
          ? { type: 'mrkdwn', text: `🤖 *AI Summary:*\n<${state.summaryLink}|View on LFX>` }
          : { type: 'mrkdwn', text: '🤖 *AI Summary:*\n_(processing)_' },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `📝 *Full Notes:*\n<${docUrl}|Google Doc>` },
        { type: 'mrkdwn', text: `📂 *Transcript & Files:*\n<${ghUrl}|GitHub>` },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Next meeting: biweekly Tuesdays at 8am PDT · <https://zoom-lfx.platform.linuxfoundation.org/meeting/99965231171?password=2a169dd5-e375-4b5a-9b40-b2b5db5bfe91|Join Zoom>' }],
    },
  ];

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify({ blocks }),
    muteHttpExceptions: true,
  });

  Logger.log(`Slack response: ${response.getResponseCode()}`);
}
