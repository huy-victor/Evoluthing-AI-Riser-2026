# Evoluthing — Design Direction

## The guiding principle
Evoluthing must feel like a **real physical notebook**, not an app. Every UI decision is judged against one question: *"Would this exist on a real notebook?"* Anything that reads as an app control (arrow buttons, helper text, straight ruled lines) is either removed or replaced with a physical-world affordance.

## Core design decisions (and the reasoning behind each)

### 1. Page navigation — flip, don't click buttons
- **No arrow buttons.** A real notebook has no `<` `>` buttons.
- Hovering the outer edge **lifts only that leaf 3deg** (fingertip on paper) with soft shadowing — left edge lifts left leaf, right edge lifts right leaf, no jitter (origin fixed per leaf).
- Clicking the edge **flips only that leaf** (`179deg` in `.5s`, double-sided blank) fully across the gutter to the other side, bringing **2 blank pages**, then the next spread **fades in together `.5s`** on both leaves. The old content on the flipping leaf is blank from the start of the sweep (white-on-white) so no mirrored text is seen.
- Arrow keys are kept as a **silent backup only** — never shown in the UI.

### 2. Cover — invite by feel, not by text
- **No "open me" / "click to open" labels.** A real notebook doesn't have instructions.
- The **clasp on the right edge pulses** (a soft glow that swells and fades) as the only invitation to open.
- The whole cover is clickable; clicking swings the cover open.

### 3. Paper — grid, not lines
- Pages use a **light grid**, not horizontal ruled lines.
- Reason: hand-written text (real or AI-generated) follows ruled lines, but AI/HTML text does not align to them — ruled lines would make the text look "off the line". A grid avoids that mismatch.
- Grid opacity is intentionally subtle so text stays readable.

### 4. Typography — handwriting that survives Vietnamese
- Body/notes use a **handwriting font** for the notebook feel.
- Chosen: **Dancing Script** — the only handwriting font tested that carries full Vietnamese diacritics (`U+1EA0-1EF9`). Caveat, Patrick Hand, and other western handwriting fonts **lack Vietnamese diacritics** and must not be used for user content.
- Cover title uses a serif (Playfair Display); UI chrome uses Inter.

### 5. The prompt page — one hand-drawn gesture, now a spread
- The prompt is a **spread**: **left = hand-written usage guide** ("HƯỚNG DẪN DÙNG SỔ EVOLUTHING!" + 4 numbered steps, styled as the notebook owner's notes — no app-style micro-helper text), **right =** input + underline + Khám phá + suggestions. No left outer spine when open, no pageno/topic bar, gutter stays. This keeps the overhang visible and matches the milestone spread rhythm. Guide content/config lives in `guide-preview.html` (defaults synced to production).
- The input underline is a **hand-drawn brush stroke** (a PNG asset), not a CSS border: mass + pressure variation + tapering tip + shallow curve.
- The Khám phá button frame is a **static hand-drawn oval** (`Circle.png`, natural ink, no hover animation): box **223×91**, oval shifted **-5px** up so the label sits centered. Tweak values via `circle-preview.html`, then bake them into `index.html`.
- **No helper text** under the input and **no date**.
- **Photos are zoomable**: clicking any polaroid photo (milestone page or hook page) opens it full-screen over a dimmed backdrop; clicking anywhere outside the photo (or Esc) closes it.

### 6. Milestone page — a taped-in photograph
- The image is a **polaroid**: a white frame (thicker at the top), the photo inside with a **1px black border** (so a white photo doesn't sink into the white frame), and a caption under the photo.
- Photo ratio **4:3**, width **65% of the page width** (tall enough to fill the vertical page, wide enough to avoid cropping long photos).
- A **single short opaque tape** (`#dbcaa2`) with **torn serrated ends** holds the photo, overlapping the white frame — so it reads as physically stuck to the page, not pasted behind it.
- Notes below: name, year, What, Why — in handwriting.

### 7. Page number — where a notebook puts it
- Page number sits at the **bottom-right corner** (e.g. "3 / 7"), like a hand-written page count in a real notebook.

### 8. Disambiguation — a handwritten question, not chips
- Disambiguation appears **only when needed** — when the typed topic is ambiguous (e.g. "Apple" → the fruit vs the company). Most topics skip this step entirely.
- It must **not** use app-style controls (chips, dropdowns, radio buttons). A real notebook has none of those.
- Instead, the AI **writes the clarifying question by hand** on the page, and the user picks between two **handwritten lines** (the options written as notes on the paper) rather than tapping buttons.

### 9. Open notebook — two-page spread (implemented)
Each milestone is a **two-page spread** like a real notebook lying open: the left page holds the taped-in photograph, the right page holds the handwritten notes.

- **Layout (desktop)**: left = photo (polaroid), right = name/year/What/Why + Wikipedia source, split **50/50** meeting at the center binding that runs **full height** (top to bottom). Photo orientation auto-detected: **portrait** upright filling height (`min(52vh,430px)`), **landscape** horizontal (`aspect 4/3`). Polaroid frame follows orientation. Book is `640×820` closed, `1160×820` open (same height, ~1.8× wider), always `min(..., 100vw-48px, (100vh-48px)*ratio)` so 24px margin to viewport remains.
- **Layout (mobile)**: leaves stack **top/bottom**, no side squeeze; `binding` hidden.
- **Prompt spread**: "Hôm nay, mình muốn tìm hiểu..." is also a spread — **left = hand-written usage guide** (see section 5), **right = prompt** (input + hand-drawn underline + Khám phá + suggestions). No left outer spine when open, no `pageno`/`milestoneTopic`, gutter stays as milestone.
- The **hook/sapo intro page** is a separate feature and is NOT part of this two-page milestone layout.

### 10. Cover overhang — text block smaller than cover
A real notebook's **cover extends beyond the pages**. The book (`640/1160×820`) is the **cover** (leather, `8px 14px` radius). The paper block is inset `12px 16px` inside, so a **16px** leather border shows on 3 sides when open. This also solves the previous viewport overflow (book is `min(... 100vw-48px ...)` so overhang never touches the browser edge).

### 11. Page flip — per-leaf 3D, full cover, blank then fade
- Each half is a **leaf** (`width:50%`) with `transform-origin` at the gutter (`right` for left leaf, `left` for right leaf) and `preserve-3d`. Hover lifts only that leaf **3deg** (was 4deg) with no jitter (origin fixed per leaf).
- Click flips **only that leaf**: `right` flips with `rotateY(-179deg)`, `left` with `+179deg`, `.5s ease`, `z-index:25` over the gutter. The flipping leaf is a **double-sided clone** (`front` old content or blank, `back` blank paper) so it stays solid (white) past 90deg instead of disappearing, sweeping fully across to the other side bringing **2 blank pages**.
- Underneath, both leaves are blanked at 90deg. After the sweep (`520ms`), the clone is removed revealing **2 blanks side by side**, then the next milestone's left/right content **fades in together `opacity .5s`** (topic + pageno fade with it). Prompt → first milestone also uses a right-flip.

## Visual references (palette & materials)
- **Cover**: warm leather brown; title in muted gold.
- **Paper**: warm cream with a faint grid.
- **Backdrop**: dark warm wood-grain table, so the notebook stands out as a physical object.
- **Bilingual (planned)**: language switch re-colors the cover + title per flag — Vietnamese → red cover / yellow title; English → its own palette.

## Anti-patterns (do not reintroduce)
- Arrow/nav buttons for page turning.
- "open me", "press Enter", or any instructional helper text.
- Ruled horizontal lines on paper (use grid).
- Straight/CSS-border underlines (use the hand-drawn stroke).
- Western-only handwriting fonts that drop Vietnamese diacritics.
- AI-generated object images (use Wikipedia photos taped as polaroids).
- Disambiguation chips / dropdowns / option buttons (write the question by hand instead).
