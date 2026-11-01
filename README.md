# Evoluthing 📖

**Evoluthing** is a notebook-style web app where you type any object or thing,
and an AI builds a visual timeline of how it evolved — Wikipedia photos taped
in as polaroids, hand-written notes on each page, and pages you flip through
to travel across eras.

An entry for **#AIRiser Vietnam 2026** (#BuildwithGoogleAI), built with
Google AI Studio (Gemini) and deployed to Google Cloud Run.

## How it works

1. A closed notebook sits on a dark table — leather cover with a sticker sheet,
   language ribbons (🇻🇳/🇬🇧) and a clasp. Click the cover → it swings open.
2. **Left page** — a 5-step usage guide plus an optional field to paste your own
   Gemini API key (BYOK). **Right page** — type your topic (max 20 chars),
   tap a suggestion chip, or press Enter.
3. While generating, the right page shows a pencil animation and a rotating
   did-you-know fact (7s each, 20 facts, shuffled every run).
4. The result opens as a **hook spread**: a winding dotted river of photo
   polaroids with year labels on the left, the hook text on the right.
5. Flip through **milestone spreads**: left = Wikipedia photo taped as a
   polaroid with title/year/source link, right = the story in hand-written
   prose. Portrait vs landscape photos are detected and framed accordingly.
6. Flip by tapping the page edges (or arrow keys). Tap any photo for a
   fullscreen lightbox. The ↺ button on the top bar starts a new topic, and
   the left edge of the guide page returns to the cover (to switch language).

Everything is **Wikipedia-grounded**: photos and facts come from Wikipedia
(REST summary API), not AI image generation — every milestone carries a real
source link, localized to the current language (vi.wikipedia preferred).

## Quick start

```bash
npm install
cp .env.example .env    # then set GEMINI_API_KEY (required)
npm start               # → http://localhost:3100
```

- `GEMINI_API_KEY` — required (server-side Gemini API)
- `GROQ_API_KEY`, `OPENROUTER_API_KEY` — optional extra fallback tiers
- Readers can also paste their own Gemini key on the guide page (step 5);
  it is stored only in their browser and sent per request.

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The whole app — one page, no build step |
| `server.js` | Express server: `/api/evolution` (model fallback chain: Gemini → Gemma → Groq → OpenRouter), Wikipedia photo lookup, BYOK support |
| `metadata.json` | Google AI Studio app metadata |
| `assets/` | Runtime images — underlines, explore circle, and the cover sticker sheet in `assets/doodles/` |
| `sounds/` | Page-flip sound effect |
| `previews/` | Standalone design & QA tools — `loading-preview.html` (loading scene tuner), `resolution-test.html` (multi-resolution viewer), `guide-preview.html`, `cover-preview.html`, … |
| `docs/` | Competition info (`AIRiserInfo.md`), product concept, design direction |
| `experiments/` | Dead ends and dev media kept for reference (early prototypes, comparison pages, test renders) |

## Features

- Bilingual 🇻🇳/🇬🇧 — ribbon switch on the cover, per-language palette, content
  generated in the chosen language, Wikipedia source follows the language
- Cover scales as a perfect miniature at any window size (container query units)
- Responsive down to small laptops (1366×640 effective viewports)
- Page-flip sound effect; loading scene with fun facts (no layout shift)
- Model fallback chain keeps generation alive if a tier fails
- Vietnamese answers are guaranteed fully diacritized

## Competition

- **#AIRiser Vietnam 2026** — theme: Education
- Timeline: Aug 1–30, 2026 (Completion Form deadline Aug 30, 23:59)
- Submission: AI Studio share link + public YouTube demo (≤ 2 min) + LinkedIn
  post; optional live Cloud Run link (+10 pts deployment)

## Deploy

Target is Google Cloud Run (web). The app is a single Express service —
no build step; deploy the repo as-is and provide the env vars above.
