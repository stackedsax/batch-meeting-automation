// YouTube playlist monitoring.
// Requires a YouTube Data API v3 key stored in YOUTUBE_API_KEY.

function checkYouTubeForPendingMeetings() {
  const pending  = getPendingMeetings();
  const unmatched = Object.keys(pending).filter(k => !pending[k].youtubeVideoId);

  if (unmatched.length === 0) {
    console.log('No meetings waiting for a YouTube video');
    return;
  }

  const videos = getRecentPlaylistVideos();
  if (!videos.length) return;

  for (const dateKey of unmatched) {
    const video = videos.find(v => videoMatchesMeeting(v.title, v.publishedAt, dateKey));
    if (!video) {
      console.log(`No YouTube video found yet for ${dateKey}`);
      continue;
    }

    console.log(`Matched video "${video.title}" to meeting ${dateKey}`);

    setMeetingState(dateKey, {
      youtubeVideoId: video.videoId,
      youtubeUrl:     `https://www.youtube.com/watch?v=${video.videoId}`,
      videoFoundAt:   new Date().toISOString(),
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
    + `?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50`
    + (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      console.log('YouTube API error: ' + response.getContentText());
      return [];
    }
    const data = JSON.parse(response.getContentText());
    return (data.items || []).map(item => ({
      videoId:     item.snippet.resourceId.videoId,
      title:       item.snippet.title,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (e) {
    console.log('Error fetching playlist: ' + e);
    return [];
  }
}
