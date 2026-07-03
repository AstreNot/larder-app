# Larder

Snap a photo of your fridge or pantry, get a smart inventory, a 7-day meal plan, and a shopping list — all powered by Claude.

## Local development

```bash
npm install
npm run dev
```

The app calls `/api/scan` and `/api/plan`, which are Vercel serverless functions. To run those locally with the Vercel CLI instead of a plain Vite dev server:

```bash
npm install -g vercel
vercel dev
```

Either way, you need an Anthropic API key set as an environment variable before the API routes will work — see below.

## Environment variables

Copy `.env.example` to `.env` and add your key:

```
GEMINI_API_KEY=AIza...
```

Get a free key from Google AI Studio: aistudio.google.com/apikey (click "Get API key" once signed in with a Google account). I can't confirm the exact current signup flow, free-tier limits, or rate limits from here — Google changes these periodically — so check the page directly and skim any free-tier terms before your demo.

## Deploying to Vercel

1. Push this project to a GitHub repo.
2. Go to vercel.com, "Add New Project", and import the repo.
3. In the project's Settings → Environment Variables, add `GEMINI_API_KEY` with your key. Do this for all environments you plan to use (Production, Preview, Development).
4. Deploy. Vercel will detect the Vite frontend and the `api/` folder automatically — no extra config needed for this project layout.

## Notes and things worth checking before your demo

- **Image size**: photos are resized to a max 1024px dimension and compressed to JPEG client-side before upload, to stay comfortably under serverless request size limits. If you still hit payload errors, lower `maxDimension` or `quality` in the `resizeImage` function in `src/App.jsx`.
- **Function timeouts**: Vercel's Hobby plan has a default serverless function execution limit — I'd recommend checking Vercel's current docs for the exact number before your demo, since these limits do change and I can't guarantee the figure I have in mind is current. If scan or plan calls are timing out, that's the first thing to check.
- **Model name**: both API routes use `gemini-2.0-flash` via Google's Generative Language API. Verify this model name and the API endpoint version (`v1beta` in the URL) are still current at ai.google.dev before you deploy — Google renames and deprecates Gemini versions periodically, and I can't confirm from here whether this is still accurate.
- **Free tier limits**: Gemini's free tier is typically rate-limited (requests per minute, not just a spend cap), which is usually fine for a live demo but could bite you during heavy testing the night before. If you hit a 429 error, that's a rate limit — wait a bit or check your quota in AI Studio.
- **Weekly plan reliability**: the meal plan is generated in a single API call across all 7 days, which is fast but means the model does its own "what's left after Monday's meal" bookkeeping. If you see it double-using ingredients across days during testing, that's a known tradeoff — a more reliable (but slower) fix is generating one day at a time and subtracting used ingredients from the inventory yourself between calls.
