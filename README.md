# Batch Meeting Automation

Google Apps Script automation that handles post-meeting admin for the CNCF Batch Subproject:

1. Catches the LFX AI Meeting Summary email and extracts the summary content
2. Creates a meeting notes file in the [cncf/toc GitHub repo](https://github.com/cncf/toc/tree/main/tags/tag-workloads-foundation/subprojects/batch/meeting-notes)
3. Updates the [Google Doc](https://docs.google.com/document/d/1GuZGyBkRGG0lEeiPA8q0PfvFlwUlwa5k-ZfXafCTdBY/edit) with the AI summary and links
4. Waits for the YouTube recording to appear, then fetches the transcript
5. Posts a summary to Slack (#batch-wg) and the mailing list

**It runs automatically.** Under normal circumstances you don't need to touch it after a meeting.

---

## After a meeting: what to expect

| Timeframe | What happens |
|-----------|-------------|
| Within 5 min of LFX email | Summary parsed, GitHub file created/updated, Google Doc updated |
| Within 1–2 days | YouTube recording detected, transcript fetched, Slack + mailing list notification sent |
| ~11 days before next meeting | Google Doc pre-populated with an upcoming block (agenda placeholder, attendee list) |

---

## If something goes wrong

All manual helpers are run from the **Apps Script editor**. Open it with:

```bash
npx clasp open
```

Then find the function in the editor and click **Run**.

| Problem | Function to run |
|---------|----------------|
| Summary email arrived but Google Doc wasn't updated | `processSummaryEmails()` |
| YouTube recording is up but no notification sent | `checkYouTube()` |
| Want to see what the system knows about pending meetings | `logPendingMeetingDates()` |
| Summary emails need to be re-processed from scratch | `reprocessAllSummaryEmails()` |
| Google Doc blocks are missing the AI summary content | `backfillSummaryInGoogleDoc()` |
| Need to manually run everything for a specific date | Edit `dateKey` in `manualRunForDate()` and run it |
| Want to export all meeting notes from the Google Doc to GitHub | `exportMeetingNotesFromDoc()` |

---

## Taking over (full setup on a new Google account)

If you need to redeploy this to your own Google account:

### Prerequisites

You'll need:
- A Google account (the script runs under this account — it needs access to the Gmail inbox with the LFX emails)
- [Node.js](https://nodejs.org/) installed
- A GitHub [fine-grained PAT](https://github.com/settings/personal-access-tokens) with `contents:write` on your fork of `cncf/toc`
- A YouTube Data API v3 key ([Google Cloud Console](https://console.cloud.google.com/) → APIs & Services)
- A Slack incoming webhook for `#batch-wg` (ask in `#cncf-staff` on the CNCF Slack)

### Steps

```bash
# 1. Clone and install
git clone https://github.com/stackedsax/batch-meeting-automation.git
cd batch-meeting-automation
npm install

# 2. Log in to clasp with your Google account
npx clasp login

# 3. Create a new Apps Script project
npx clasp create --title "Batch Meeting Automation" --type standalone

# 4. Push the code
npx clasp push

# 5. Open the editor
npx clasp open
```

In the Apps Script editor:

**Set secrets:** Edit `setInitialConfig()` in `Config.js` with your values and run it once. Then **delete the values** from the function and push again (`npx clasp push`).

| Secret | Where to get it |
|--------|----------------|
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Fine-grained PAT, `contents:write` on your fork |
| `SLACK_WEBHOOK_URL` | Ask CNCF staff for an incoming webhook for `#batch-wg` |
| `YOUTUBE_API_KEY` | Google Cloud Console → YouTube Data API v3 |

**Set up Gmail filter:** In the Gmail account the script runs under, create a filter:
- From: `meetings@lfx.dev`
- Subject contains: `AI Meeting Summary Completed: Batch Subproject`
- Action: Apply label `LFX-Batch-Summary`

**Install triggers:** Run `createTriggers()` once from the editor. This sets up the three recurring jobs (5-min email check, hourly YouTube check, daily maintenance).

**Update config if needed:** If you're using your own fork, run these in the editor:
```
setConfig('GITHUB_REPO_OWNER', 'your-github-username')
setConfig('GITHUB_BRANCH', 'your-branch-name')
```

---

## How it works (for the curious)

```
Every 5 min:  Gmail watcher
  LFX summary email found
    → parse summary content
    → create/update GitHub meeting file
    → update Google Doc block with summary + links

Every hour:   YouTube watcher
  New video found matching a pending meeting date
    → fetch auto-generated transcript
    → update GitHub file + Google Doc links
    → post to Slack + mailing list  ← only fires once both pieces are ready

Daily 9am:    Maintenance
  Meeting in ~11 days?
    → pre-populate Google Doc with upcoming meeting block
```

State (which meetings are pending, which have been processed) is stored in Apps Script's `PropertiesService` — it persists between runs without needing a database.

---

## Configuration defaults

Most settings are baked in and don't need changing. These are the values in use:

| Setting | Value |
|---------|-------|
| `YOUTUBE_PLAYLIST_ID` | `PLlo2EEMTvVU-jMMA208R-cSEcVkmPYjxZ` |
| `GOOGLE_DOC_ID` | `1GuZGyBkRGG0lEeiPA8q0PfvFlwUlwa5k-ZfXafCTdBY` |
| `MAILING_LIST_EMAIL` | `cncf-tag-workloads-foundation-b3h@lists.cncf.io` |
| `GMAIL_LABEL` | `LFX-Batch-Summary` |
| `GITHUB_REPO_OWNER` | `stackedsax` |
| `GITHUB_REPO_NAME` | `toc` |
| `GITHUB_MEETINGS_PATH` | `tags/tag-workloads-foundation/subprojects/batch/meeting-notes` |
| `GITHUB_BRANCH` | `add-batch-meeting-notes` |
