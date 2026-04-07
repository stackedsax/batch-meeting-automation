// YouTube playlist monitoring and auto-caption transcript fetching.
// Requires a YouTube Data API v3 key stored in YOUTUBE_API_KEY.

function checkYouTubeForPendingMeetings() {
  const pending = getPendingMeetings();
  const unmatched = Object.keys(pending).filter(k => !pending[k].youtubeVideoId);

  if (unmatched.length === 0) {
    Logger.log('No meetings waiting for a YouTube video');
    return;
  }

  const videos = getRecentPlaylistVideos();
  if (!videos.length) return;

  for (const dateKey of unmatched) {
    const video = videos.find(v => videoMatchesMeeting(v.title, v.publishedAt, dateKey));
    if (!video) {
      Logger.log(`No YouTube video found yet for ${dateKey}`);
      continue;
    }

    Logger.log(`Matched video "${video.title}" to meeting ${dateKey}`);

    const transcript = fetchYouTubeTranscript(video.videoId);

    setMeetingState(dateKey, {
      youtubeVideoId: video.videoId,
      youtubeUrl:     `https://www.youtube.com/watch?v=${video.videoId}`,
      transcript,
      videoFoundAt: new Date().toISOString(),
    });

    // Update GitHub and Google Doc now that we have the video
    createOrUpdateGitHubEntry(dateKey);
    updateGoogleDocVideoLinks(dateKey);

    // Send notifications only once both summary and video are ready
    const updated = getMeetingState(dateKey);
    if (updated.summaryProcessed && !updated.notificationsSent) {
      sendNotifications(dateKey);
      setMeetingState(dateKey, { notificationsSent: true });
    }
  }
}

function getRecentPlaylistVideos() {
  const playlistId = getConfig(CONFIG_KEYS.YOUTUBE_PLAYLIST_ID);
  const apiKey     = getConfig(CONFIG_KEYS.YOUTUBE_API_KEY);

  const url = `https://www.googleapis.com/youtube/v3/playlistItems`
    + `?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=15`
    + (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('YouTube API error: ' + response.getContentText());
      return [];
    }
    const data = JSON.parse(response.getContentText());
    return (data.items || []).map(item => ({
      videoId:     item.snippet.resourceId.videoId,
      title:       item.snippet.title,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (e) {
    Logger.log('Error fetching playlist: ' + e);
    return [];
  }
}

// Fetch auto-generated captions via YouTube's timedtext endpoint.
// Returns VTT string or null.
function fetchYouTubeTranscript(videoId) {
  const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=vtt`;

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const content  = response.getContentText();

    if (response.getResponseCode() === 200 && content.startsWith('WEBVTT')) {
      Logger.log(`Fetched transcript for ${videoId} (${content.length} chars)`);
      return content;
    }

    Logger.log(`Timedtext returned ${response.getResponseCode()} for ${videoId} — captions may not be ready yet`);
  } catch (e) {
    Logger.log('Transcript fetch error: ' + e);
  }

  return null;
}
