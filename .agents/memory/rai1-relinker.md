---
name: RAI live relinker geography
description: Non-obvious behavior of the official RAI 1 relinker when called from Replit versus an Italian client.
---

The official RAI 1 relinker is sensitive to the geographic origin of the request. A request made directly from an Italian client returns a short-lived signed HLS playlist, while the same server-side request from the Replit deployment returns a `video_no_available.mp4` placeholder.

**Why:** RAIPlay can play RAI 1 in Italy, but the current player proxy runs the relinker request from Replit before the browser ever receives the HLS URL.

**How to apply:** Keep the HLS segments client-side; run only the relinker request through an authorized Italian egress endpoint or use an official embed. Do not persist signed playlist URLs because they expire.