# iMessage "locked in" marketing video

A 9:16 vertical video of a fake iMessage thread: one friend asks "miss you bro, you
been so locked in, what have you been working on?", the other replies with a photo of
the AR Forge (a real three.ws/ar screenshot with a TRELLIS-generated house plant),
then the conversation lands the OpenAI partnership beat and the unicorn line, and
closes on a callback ("miss you too bro"). Built for X/TikTok/Reels distribution in
the deadpan-undersell voice.

## Files

- `imessage-locked-in.mp4` - the rendered conversation video (1080x1920, typed
  letter by letter on an iOS keyboard, send/receive blips in the audio track).
- `forge-plant-bubble.png` - the photo-bubble image: a real screenshot of
  [three.ws/ar](https://three.ws/ar) with the generated plant model in the stage.
- `render-imessage-video.mjs` - renders the video via postmock.com (anonymous
  in-browser render; the script pulls the MP4 blob straight from the session).
  Edit the `SCRIPT` array to change the dialogue, then re-run.
- `capture-forge-bubble.mjs` - regenerates the photo-bubble screenshot from the
  live AR Forge page. Pass a prompt to change the model:
  `node marketing/imessage-video/capture-forge-bubble.mjs "a crystal chess knight"`

## Re-render

```bash
node marketing/imessage-video/capture-forge-bubble.mjs   # optional: new bubble image
node marketing/imessage-video/render-imessage-video.mjs  # writes imessage-locked-in.mp4
```

Both scripts use the repo's Playwright install; no extra setup. Rendering takes a few
minutes because the video plays out in real time in the headless browser.

