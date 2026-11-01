# Evoluthing — Product Concept

## One-liner
Type any object or thing; AI generates a visual timeline of how it evolved, presented as a personal notebook you flip through — with Wikipedia photos taped in as polaroids and hand-written notes.

## Core experience
1. A closed notebook with a leather cover, a clasp, and the title "Evoluthing / How things evolution?".
2. Click the clasp → the cover opens to the first page: "Today, I want to learn about the evolution of:" with a hand-drawn ink underline where the user types a topic (e.g. "Computer", "áo dài", "mì gói").
3. Press Enter → a short "Đang suy nghĩ…" (thinking) page → the notebook opens to milestone pages.
4. Each milestone page = one era: a Wikipedia photo taped in as a polaroid (single short opaque tape over a white border), a caption, and hand-written notes (name, year, What, Why).
5. User flips pages (edge-lift hover + click, or arrow keys as backup) from the past to the present.

## Layout & visual style
The notebook reads as a physical object: leather cover with a pulsing clasp, grid-paper pages, page numbers bottom-right, and a hand-drawn underline under the topic input. The full visual specification — including the guiding question *"would this exist on a real notebook?"*, polaroid/tape details, fonts, and the anti-patterns that must never be reintroduced — lives in `evoluthing-design-direction.md`.

## Images & sources (Wikipedia-grounded)
- Images come from **Wikipedia**, not AI generation. Fetched via the Wikipedia REST summary API (thumbnail + extract).
- Risk mitigation: this kills the "AI hallucinating facts/years" and "AI image style inconsistency" risks entirely, and provides a real source link per milestone.
- License note: Wikipedia/Commons images are mostly CC BY-SA or public domain — must credit author + license, especially for a public competition deployment.

## Bilingual (planned feature)
- A language-switch button styled like the notebook clasp.
- Switching changes the cover color + title per language: Vietnamese → red cover / yellow title (flag colors); English → its own palette.
- Generated content follows the chosen language. Need a fitting Vietnamese name for "Evoluthing" (to be decided).

## Planned features (not yet built)
- **Open book spread**: show a full two-page spread — left and right pages visible side by side, meeting at the center binding.
- **Export**: an open mailbox + open envelope beside the book; user selects evolution pages to export, they fly into the envelope, the envelope closes, lands in the mailbox, and downloads to the user's device.

## MVP scope
- Cover → prompt → loading → milestone pages (Wikipedia polaroid + notes) → flip navigation
- Wikipedia-grounded content + source links
- Prototype lives at `E:\Code\ai-riser\evoluthing-notebook.html` (served locally via `python -m http.server`).

## Out of scope (later)
- Clay/3D-style AI-generated objects (rejected — replaced by Wikipedia photos).
- 360° rotatable 3D object.
- AI image generation entirely (Wikipedia photos instead).

## Risks & mitigations
- **Topic without good Wikipedia images** (e.g. niche Vietnamese topics) → fallback placeholder (emoji) + still show notes; improve image matching over time.
- **Wikipedia 404 / wrong "lead image"** (e.g. Macintosh returned a logo) → pick the best available image, allow manual override in data.
- **License/attribution** → include credit + license per image when deployed publicly.
