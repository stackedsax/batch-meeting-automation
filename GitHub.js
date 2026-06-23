// Creates and updates meeting files in the cncf/toc repo via the GitHub API.
// Requires a GitHub PAT with contents:write on the repo.

function createOrUpdateGitHubEntry(dateKey) {
  const state = getMeetingState(dateKey);
  if (!state) return;

  const owner    = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo     = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const basePath = getConfig(CONFIG_KEYS.GITHUB_MEETINGS_PATH);
  const headers  = githubHeaders();
  const branch   = meetingBranch(dateKey);

  ensureMeetingBranch(owner, repo, headers, branch);

  upsertGitHubFile({
    owner, repo, headers,
    branch,
    path:    `${basePath}/${dateKey}.md`,
    content: buildMeetingNotesMarkdown(dateKey, state),
    message: `Meeting notes: ${dateKey}`,
  });
}

// Opens a PR for the meeting if one hasn't been opened yet.
// Called once the meeting is fully processed (summary + video both ready).
function openMeetingNotesPR(dateKey) {
  const state = getMeetingState(dateKey);
  if (!state || state.prOpened) return;

  const owner   = getConfig(CONFIG_KEYS.GITHUB_REPO_OWNER);
  const repo    = getConfig(CONFIG_KEYS.GITHUB_REPO_NAME);
  const headers = githubHeaders();
  const branch  = meetingBranch(dateKey);
  const display = keyToDisplayDate(dateKey);

  // Extract a topic from the state if available (first line of summaryContent)
  let topic = '';
  if (state.summaryContent) {
    const firstLine = state.summaryContent.split('\n')[0].replace(/^[#*\->\s]+/, '').trim();
    if (firstLine.length > 0 && firstLine.length < 80) topic = ` — ${firstLine}`;
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const body = {
    title: `Meeting notes: ${display}${topic}`,
    head:  `${owner}:${branch}`,
    base:  'main',
    body:  `Meeting notes for the ${display} Batch Subproject meeting.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  };

  const response = UrlFetchApp.fetch(apiUrl, {
    method: 'POST',
    headers,
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code === 201) {
    const pr = JSON.parse(response.getContentText());
    console.log(`GitHub: opened PR #${pr.number} for ${dateKey}: ${pr.html_url}`);
    setMeetingState(dateKey, { prOpened: true, prUrl: pr.html_url });
  } else {
    console.log(`GitHub: PR creation failed (${code}) for ${dateKey}: ${response.getContentText()}`);
  }
}

// Returns the per-meeting branch name for a given dateKey.
function meetingBranch(dateKey) {
  return `batch-meeting-notes-${dateKey}`;
}

// Creates a branch from the default branch (main) if it doesn't already exist.
function ensureMeetingBranch(owner, repo, headers, branch) {
  const refsUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branch}`;
  const check = UrlFetchApp.fetch(refsUrl, { headers, muteHttpExceptions: true });
  if (check.getResponseCode() === 200) return; // already exists

  // Get SHA of main
  const mainUrl = `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/main`;
  const mainResp = UrlFetchApp.fetch(mainUrl, { headers, muteHttpExceptions: true });
  if (mainResp.getResponseCode() !== 200) {
    console.log(`GitHub: could not get main SHA: ${mainResp.getContentText()}`);
    return;
  }
  const sha = JSON.parse(mainResp.getContentText()).object.sha;

  const createResp = UrlFetchApp.fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    {
      method: 'POST',
      headers,
      payload: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      muteHttpExceptions: true,
    }
  );
  const code = createResp.getResponseCode();
  if (code === 201) {
    console.log(`GitHub: created branch ${branch}`);
  } else {
    console.log(`GitHub: branch creation failed (${code}): ${createResp.getContentText()}`);
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

function upsertGitHubFile({ owner, repo, headers, path, content, message, branch }) {
  if (!branch) branch = getConfig(CONFIG_KEYS.GITHUB_BRANCH);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Get existing file SHA if it exists (needed for updates)
  let sha = null;
  try {
    const existing = UrlFetchApp.fetch(apiUrl + `?ref=${branch}`, { headers, muteHttpExceptions: true });
    if (existing.getResponseCode() === 200) {
      sha = JSON.parse(existing.getContentText()).sha;
    }
  } catch (e) { /* file doesn't exist yet */ }

  const body = {
    message,
    content: Utilities.base64Encode(Utilities.newBlob(content).getBytes()),
    branch,
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
    console.log(`GitHub: upserted ${path}`);
  } else {
    console.log(`GitHub error ${code} for ${path}: ${response.getContentText()}`);
  }
}

function buildMeetingNotesMarkdown(dateKey, state) {
  const displayDate = keyToDisplayDate(dateKey);
  const videoSection = state.youtubeUrl
    ? `📽️ [Recording](${state.youtubeUrl})`
    : '📽️ Recording: _(uploading — check back soon)_';
  const summaryRef = state.summaryLink
    ? `🤖 [AI Summary](${state.summaryLink})`
    : '🤖 AI Summary: _(processing)_';

  const overview = state.summaryContent
    ? state.summaryContent
    : '_(AI summary will appear here once processed)_';

  const nextStepsSection = (state.summaryNextSteps && state.summaryNextSteps.length > 0)
    ? `\n## ➡️ Next Steps\n\n${state.summaryNextSteps.map(s => `- ${s}`).join('\n')}`
    : '';

  const detailsSection = (state.summaryDetails && state.summaryDetails.length > 0)
    ? `\n## 📋 Summary\n\n${state.summaryDetails.map(s =>
        `### ${s.label || 'Notes'}\n\n${s.summary || ''}`
      ).join('\n\n')}`
    : '';

  return `# Meeting Notes — ${displayDate}

${videoSection}
${summaryRef}

## 👥 Attendees
_(see Google Doc for attendees list)_

## 📝 Quick Recap

${overview}
${nextStepsSection}
${detailsSection}
`;
}
