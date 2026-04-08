// Configuration constants and PropertiesService helpers.
// Run setInitialConfig() once after deploying to set up secrets.

const CONFIG_KEYS = {
  GITHUB_TOKEN:          'GITHUB_TOKEN',
  SLACK_WEBHOOK_URL:     'SLACK_WEBHOOK_URL',
  YOUTUBE_PLAYLIST_ID:   'YOUTUBE_PLAYLIST_ID',
  YOUTUBE_API_KEY:       'YOUTUBE_API_KEY',
  GOOGLE_DOC_ID:         'GOOGLE_DOC_ID',
  MAILING_LIST_EMAIL:    'MAILING_LIST_EMAIL',
  GMAIL_LABEL:           'GMAIL_LABEL',
  GITHUB_REPO_OWNER:     'GITHUB_REPO_OWNER',
  GITHUB_REPO_NAME:      'GITHUB_REPO_NAME',
  GITHUB_MEETINGS_PATH:  'GITHUB_MEETINGS_PATH',
  PENDING_MEETINGS:      'PENDING_MEETINGS',
};

const DEFAULTS = {
  YOUTUBE_PLAYLIST_ID:  'PLlo2EEMTvVU-jMMA208R-cSEcVkmPYjxZ',
  GOOGLE_DOC_ID:        '1GuZGyBkRGG0lEeiPA8q0PfvFlwUlwa5k-ZfXafCTdBY',
  MAILING_LIST_EMAIL:   'cncf-tag-workloads-foundation@lists.cncf.io',
  GMAIL_LABEL:          'LFX-Batch-Summary',
  GITHUB_REPO_OWNER:    'stackedsax',
  GITHUB_REPO_NAME:     'toc',
  GITHUB_MEETINGS_PATH: 'tags/tag-workloads-foundation/subprojects/batch/meetings',
};

function getConfig(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || DEFAULTS[key] || null;
}

function setConfig(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

// Run this once manually after first deploy to set secrets.
// Fill in your values before running.
function setInitialConfig() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    [CONFIG_KEYS.GITHUB_TOKEN]:        'YOUR_GITHUB_PAT',
    [CONFIG_KEYS.SLACK_WEBHOOK_URL]:   'YOUR_SLACK_WEBHOOK_URL',
    [CONFIG_KEYS.YOUTUBE_API_KEY]:     'YOUR_YOUTUBE_API_KEY',
  });
  Logger.log('Config set. Delete secrets from this function before pushing to git.');
}
