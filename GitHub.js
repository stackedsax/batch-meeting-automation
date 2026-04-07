// Creates and updates meeting files in the cncf/toc repo via the GitHub API.
// Requires a GitHub PAT with contents:write on the repo.

function createOrUpdateGitHubEntry(dateKey) {
  const state = getMeetingState(dateKey);
  if (!state) return;

  const owner    = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo     = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const basePath = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const headers  = githubHeaders();

  upsertGitHubFile({
    owner, repo, headers,
    path:    `${basePath}/${dateKey}/notes.md`,
    content: buildMeetingNotesMarkdown(dateKey, state),
    message: `Meeting notes: ${dateKey}`,
  });

  if (state.transcript) {
    upsertGitHubFile({
      owner, repo, headers,
      path:    `${basePath}/${dateKey}/transcript.vtt`,
      content: state.transcript,
      message: `Transcript: ${dateKey}`,
    });
  }
}

function githubHeaders() {
  return {
    'Authorization':        `Bearer ${getConfig(CONFIG_KEYS.GITHUB_TOKEN)}`,
    'Accept':               'application/vnd.github.v3+json',
    'Content-Type':         'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function upsertGitHubFile({ owner, repo, headers, path, content, message }) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Get existing file SHA if it exists (needed for updates)
  let sha = null;
  try {
    const existing = UrlFetchApp.fetch(apiUrl, { headers, muteHttpExceptions: true });
    if (existing.getResponseCode() === 200) {
      sha = JSON.parse(existing.getContentText()).sha;
    }
  } catch (e) { /* file doesn't exist yet */ }

  const body = {
    message,
    content: Utilities.base64Encode(Utilities.newBlob(content).getBytes()),
    branch: 'main',
  };
  if (sha) body.sha = sha;

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code === 200 || code === 201) {
    Logger.log(`GitHub: upserted ${path}`);
  } else {
    Logger.log(`GitHub error ${code} for ${path}: ${response.getContentText()}`);
  }
}

function buildMeetingNotesMarkdown(dateKey, state) {
  const displayDate   = keyToDisplayDate(dateKey);
  const videoSection  = state.youtubeUrl
    ? `📽️ [Recording](${state.youtubeUrl})`
    : '📽️ Recording: _(uploading — check back soon)_';
  const transcriptRef = state.transcript
    ? '📜 [Transcript](./transcript.vtt)'
    : '📜 Transcript: _(will be added once recording is processed)_';
  const summaryRef    = state.summaryLink
    ? `🤖 [AI Summary](${state.summaryLink})`
    : '🤖 AI Summary: _(processing)_';
  const summaryBody   = state.summaryContent
    ? state.summaryContent
    : '_(AI summary will appear here once processed)_';

  return `# Meeting Notes — ${displayDate}

${videoSection}
${transcriptRef}
${summaryRef}

## 👥 Attendees
_(see Google Doc for attendees list)_

## 🤖 AI Meeting Summary

${summaryBody}
`;
}
