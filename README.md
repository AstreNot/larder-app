# Larder

Snap a photo of your fridge or pantry, get a smart inventory, a 7-day meal plan, and a shopping list.

## Architecture (updated)

To avoid the vision-LLM rate limits and token costs hit during testing, this version splits the work differently from earlier prototypes:

- **Photo scanning** is done by a YOLOv8 model running on your own VM (see `/yolo-server`), not a hosted LLM API. Zero per-request API cost, no rate limits — but limited to the ~11 food classes YOLOv8's pretrained COCO weights actually recognize (see `/yolo-server/README.md` for the full list and honest caveats).
- **Weekly planning** is done entirely locally with a greedy optimization algorithm (`/lib/matchRecipes.js`) against a small curated recipe dataset (`/data/recipes.json`). No external API call at all for this step — it's instant and free.

This means, as currently built, the app makes **zero calls to any paid LLM API**. If you want richer recipe generation later (beyond the curated dataset) you could reintroduce a small text-only LLM call for that step specifically — text-only calls are far cheaper than the image-heavy ones that caused the original rate-limit problem.

## Local development

```bash
npm install
npm run dev
```

The frontend calls `/api/scan` and `/api/plan`, which are Vercel serverless functions. To run those locally instead of a plain Vite dev server:

```bash
npm install -g vercel
vercel dev
```

## Setting up the vision server (VM side)

See `/yolo-server/README.md` for full setup instructions, including exposing it to the internet via a tunnel. You'll need this running and reachable before photo scanning will work.

## Environment variables (Vercel side)

- `YOLO_SERVER_URL` — your VM's public tunnel URL with `/detect` appended, e.g. `https://xxxx.trycloudflare.com/detect`
- `YOLO_SHARED_SECRET` — a secret string matching the `SHARED_SECRET` you set on the VM (protects your tunnel from random public use)

No LLM API key is required for the current version.

## Deploying to Vercel

1. Push this project to a GitHub repo.
2. Go to vercel.com, "Add New Project", and import the repo.
3. In Settings → Environment Variables, add `YOLO_SERVER_URL` and `YOLO_SHARED_SECRET`.
4. Deploy. Vercel will detect the Vite frontend and the `api/` folder automatically.

## Notes and things worth checking before your demo

- **Image size**: photos are resized to a max 1024px dimension and compressed to JPEG client-side before upload. If you hit payload errors, lower `maxDimension` or `quality` in `resizeImage` in `src/App.jsx`.
- **VM must be running and tunneled during your demo** — if the VM sleeps, reboots, or the tunnel drops, scanning will fail with a "couldn't reach the vision server" error. Keep the terminal running the tunnel visible so you can restart it quickly if needed.
- **Detection scope**: only banana, apple, orange, broccoli, carrot, hot dog, pizza, donut, cake, sandwich, and bottle are detectable. Plan your demo photo around items from this list, or budget time to explore a fine-tuned grocery model on Roboflow Universe (unverified by me — check yourself).
- **Recipe matching depletion is simplified**: each matched ingredient is treated as fully used after one recipe, regardless of quantity on hand. Fine for a demo, not quantity-accurate.
- **Function timeouts**: Vercel's Hobby plan has a default serverless function execution limit. Check Vercel's current docs for the exact number — I can't confirm it's unchanged from what I recall.
