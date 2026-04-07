# Batch Meeting Automation

Google Apps Script automation (managed with [clasp](https://github.com/google/clasp)) that:

1. Watches Gmail for LFX AI Meeting Summary emails
2. Fetches the summary content and creates a meeting notes file in GitHub
3. Watches the YouTube playlist for the meeting recording; fetches the auto-generated transcript
4. Updates the Google Doc with all links and the AI summary
5. Posts a summary to Slack (#batch-wg) and the mailing list

---

## How it works

```
Every 5 min:  Gmail watcher
  LFX summary email found
    → parse summary content
    → create/update GitHub meeting file
    → insert meeting block in Google Doc

Every hour:   YouTube watcher
  New video found matching a pending meeting date
    → fetch auto-generated transcript
    → update GitHub file + Google Doc links
    → post to Slack + mailing list  ← only fires once both pieces are ready

Daily 9am:    Maintenance
  Meeting in ~7 days?
    → pre-populate Google Doc with upcoming meeting block
       (agenda, attendee list placeholder, topics space)
```

---

## Setup

### 1. Install and deploy

```bash
npm install
npx clasp login
npx clasp create --title "Batch Meeting Automation" --type standalone
npx clasp push
```

### 2. Set secrets

Open the script in the Apps Script editor (`npx clasp open`), edit `setInitialConfig()` in `Config.js` with your values, and run it once. Then **remove the values** from the function and push again.

Secrets to set:

| Key | Where to get it |
|-----|----------------|
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Fine-grained PAT with `contents:write` on `cncf/toc` |
| `SLACK_WEBHOOK_URL` | Ask CNCF staff to create an incoming webhook for `#batch-wg` |
| `YOUTUBE_API_KEY` | Google Cloud Console → APIs & Services → YouTube Data API v3 |

### 3. Set up Gmail filter

In Gmail, create a filter:
- **From:** `no-reply@zoom.us`
- **Subject:** `AI Meeting Summary Completed: Batch Subproject`
- **Action:** Apply label `LFX-Batch-Summary`

### 4. Install triggers

Run `createTriggers()` once from the Apps Script editor. This installs the three time-based triggers.

---

## Slack

The CNCF Slack workspace requires an admin to install an incoming webhook. Post in `#cncf-staff` and request a webhook for `#batch-wg` for the Batch Subproject meeting notes bot.

---

## YouTube transcripts

Auto-generated captions are fetched via YouTube's timedtext endpoint (`kind=asr`). YouTube is gradually rolling out `pot` (proof-of-origin) token requirements; if transcripts stop working this will need updating.

---

## Configuration defaults

| Setting | Default value |
|---------|--------------|
| `YOUTUBE_PLAYLIST_ID` | `PLlo2EEMTvVU-jMMA208R-cSEcVkmPYjxZ` |
| `GOOGLE_DOC_ID` | `1GuZGyBkRGG0lEeiPA8q0PfvFlwUlwa5k-ZfXafCTdBY` |
| `MAILING_LIST_EMAIL` | `cncf-tag-workloads-foundation@lists.cncf.io` |
| `GMAIL_LABEL` | `LFX-Batch-Summary` |
| `GITHUB_REPO_OWNER` | `cncf` |
| `GITHUB_REPO_NAME` | `toc` |
| `GITHUB_MEETINGS_PATH` | `tags/tag-workloads-foundation/subprojects/batch/meetings` |
