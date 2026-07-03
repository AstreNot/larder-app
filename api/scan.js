// This route no longer calls a vision LLM. It proxies the photo to your
// self-hosted YOLO server (see /yolo-server) running on your VM, which does
// detection locally and returns the same {items: [...]} shape the frontend
// already expects. This is what eliminates the image-token rate limit issue.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { image, mediaType } = req.body || {};
  if (!image || !mediaType) {
    return res.status(400).json({ error: "Missing image or mediaType in request body" });
  }

  if (!process.env.YOLO_SERVER_URL) {
    return res.status(500).json({ error: "Server is missing YOLO_SERVER_URL. Set it in your Vercel project's environment variables to your VM's tunnel URL, e.g. https://xxxx.trycloudflare.com/detect" });
  }
  if (!process.env.YOLO_SHARED_SECRET) {
    return res.status(500).json({ error: "Server is missing YOLO_SHARED_SECRET. Set it to match the SHARED_SECRET env var on your VM." });
  }

  try {
    const response = await fetch(process.env.YOLO_SERVER_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shared-secret": process.env.YOLO_SHARED_SECRET,
      },
      body: JSON.stringify({ image_base64: image, media_type: mediaType }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data?.detail || "Vision server error" });
    }

    // The VM already returns items in the shape the frontend expects
    // ({ items: [{ name, quantity_estimate, category, confidence, expires_in_days, note }] }).
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({ error: "Couldn't reach the vision server. Is the VM running and the tunnel URL correct? " + err.message });
  }
}
