import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3100;

app.use(express.json());
app.use(express.static(__dirname));

let aiClient = null;
function getAI(key) {
  // key: per-request BYOK key from the user — never cached; omit to use the server key (cached)
  if (key) {
    return new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('[Evoluthing] GEMINI_API_KEY is not set. Skipping Google fallback tier.');
      return null;
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

const FALLBACK_GOOGLE = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];

const FALLBACK_GROQ = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];

const FALLBACK_OPENROUTER = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

const MODEL_TIMEOUT_MS = 40000; // 40s per model — story 900 chars needs more time; avoid cutting off thinking
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}
async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

const WIKI_UA = 'EvoluthingApp/1.0 (https://evoluthing.app; contact@evoluthing.app)';
const VI_RE = /[àáạảãâấầẩẫậăắằẳẵặèéẹẻẽêếềểễệìíịỉĩòóọỏõôốồổỗộơớờởỡợùúụủũưứừửữựỳýỵỷỹđ]/i;

// Find the equivalent article on another Wikipedia language edition via langlinks
async function wikiLangLinkUrl(enTitle, targetLang) {
  try {
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(enTitle)}&prop=langlinks&lllang=${targetLang}&redirects=1&format=json&origin=*`,
      { headers: { 'User-Agent': WIKI_UA } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const page = data.query?.pages && Object.values(data.query.pages)[0];
    const link = page?.langlinks?.[0];
    if (link && link['*']) {
      return `https://${targetLang}.wikipedia.org/wiki/${encodeURIComponent(link['*'].replace(/\s+/g, '_'))}`;
    }
  } catch (_) {}
  return null;
}

// Fetch real Wikipedia thumbnail image & link — visualSubject-aware + context selection
async function fetchWikipediaInfo({ visualSubject, title, story, lang = 'en' }) {
  const query = (visualSubject || title || '').trim();
  if (!query) return { img: null, wikiUrl: null, wikipediaTitle: null };
  const ua = WIKI_UA;
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const contextText = norm(`${title || ''} ${story || ''} ${visualSubject || ''}`);

  // Score a candidate title against context: exact > contains visualSubject > word overlap
  function scoreCandidate(candidateTitle) {
    const c = norm(candidateTitle);
    const v = norm(visualSubject || '');
    if (c === v) return 100;
    if (v && c.includes(v)) return 80;
    // KHÔNG cộng điểm khi tên ứng viên nằm TRONG truy vấn (ví dụ "Watch" ⊂ "Pendant watch") —
    // chính rule cũ này kéo bài cha chung chung lên top và dẫn ảnh đại diện hiện đại vào mốc cổ
    // word overlap with context
    const cWords = new Set(c.split(/\W+/).filter(Boolean));
    const ctxWords = new Set(contextText.split(/\W+/).filter(Boolean));
    let overlap = 0;
    for (const w of cWords) if (ctxWords.has(w) && w.length > 2) overlap++;
    return overlap * 10;
  }

  try {
    const cleaned = query.replace(/\s+/g, '_');
    // Step 1 — exact article
    try {
      const summaryRes = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleaned)}`,
        { headers: { 'User-Agent': ua } }
      );
      if (summaryRes.ok) {
        const data = await summaryRes.json();
        // Only accept if type is not disambiguation and has image or is exact
        const isDisambig = data.type === 'disambiguation' || (data.extract || '').toLowerCase().includes('may refer to:');
        if (!isDisambig && (data.thumbnail?.source || data.originalimage?.source)) {
          let wikiUrl = data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(cleaned)}`;
          if (lang === 'vi' && data.title) {
            wikiUrl = await wikiLangLinkUrl(data.title, 'vi') || wikiUrl;
          }
          return {
            img: data.thumbnail?.source || data.originalimage?.source,
            wikiUrl,
            wikipediaTitle: data.title || query,
          };
        }
        // If exact article exists but has no image, we still keep it as candidate for search ranking
        if (!isDisambig && data.title) {
          // fall through to search but remember exact title exists
        }
      }
    } catch (_) {}

    // Step 2 — search for candidates on enwiki
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=5&prop=pageimages|info&inprop=url&pithumbsize=500&format=json&origin=*`,
      { headers: { 'User-Agent': ua } }
    );
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const pages = searchData.query?.pages;
      if (pages) {
        const candidates = Object.values(pages);
        candidates.sort((a, b) => scoreCandidate(b.title) - scoreCandidate(a.title));
        const best = candidates[0];
        const bestScore = scoreCandidate(best.title);
        const hasImage = !!best?.thumbnail?.source;
        // cổng nghiêm: phải có trùng từ ngữ thật sự — "có ảnh" một mình không đủ qua cổng
        // (trước đây hasImage tự thông hành -> bài lạc đề kiểu "Bắc Ninh province" từng được nhận)
        const isReasonable = bestScore >= 10;
        if (hasImage && isReasonable) {
          let wikiUrl = best?.fullurl || (best?.title ? `https://en.wikipedia.org/wiki/${encodeURIComponent(best.title.replace(/\s+/g, '_'))}` : null);
          if (lang === 'vi' && best?.title) {
            wikiUrl = await wikiLangLinkUrl(best.title, 'vi') || wikiUrl;
          }
          return {
            img: best?.thumbnail?.source || null,
            wikiUrl,
            wikipediaTitle: best?.title || null,
          };
        }
        // không đạt cổng (kể cả có ảnh nhưng lạc đề) -> cứ thử tiếp viwiki trước khi bỏ cuộc
      }
    }

    // Step 3 — viwiki fallback for Vietnamese queries (generic topic like "cà phê")
    const isVietnameseQuery = /[àáạảãâấầẩẫậăắằẳẵặèéẹẻẽêếềểễệìíịỉĩòóọỏõôốồổỗộơớờởỡợùúụủũưứừửữựỳýỵỷỹđ]/i.test(query);
    if (isVietnameseQuery) {
      try {
        const viSummaryRes = await fetch(
          `https://vi.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`,
          { headers: { 'User-Agent': ua } }
        );
        if (viSummaryRes.ok) {
          const viData = await viSummaryRes.json();
          if (viData && (viData.thumbnail?.source || viData.originalimage?.source)) {
            return {
              img: viData.thumbnail?.source || viData.originalimage?.source,
              wikiUrl: viData.content_urls?.desktop?.page || `https://vi.wikipedia.org/wiki/${encodeURIComponent(query.replace(/\s+/g, '_'))}`,
              wikipediaTitle: viData.title || query,
            };
          }
        }
        const viSearchRes = await fetch(
          `https://vi.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=3&prop=pageimages|info&inprop=url&pithumbsize=500&format=json&origin=*`,
          { headers: { 'User-Agent': ua } }
        );
        if (viSearchRes.ok) {
          const viData = await viSearchRes.json();
          const viPages = viData.query?.pages;
          if (viPages) {
            const viBest = Object.values(viPages).sort((a,b) => scoreCandidate(b.title)-scoreCandidate(a.title))[0];
            if (viBest?.thumbnail?.source && scoreCandidate(viBest.title) >= 10) {
              return {
                img: viBest.thumbnail.source,
                wikiUrl: viBest.fullurl || `https://vi.wikipedia.org/wiki/${encodeURIComponent(viBest.title.replace(/\s+/g,'_'))}`,
                wikipediaTitle: viBest.title,
              };
            }
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn(`[Evoluthing] Wikipedia fetch warning for '${query}':`, err.message);
  }
  return { img: null, wikiUrl: null, wikipediaTitle: null };
}

// Gom ứng viên ảnh (bài + mô tả + ảnh đại diện) từ enwiki/viwiki — đầu vào cho AI chọn theo thời đại
async function wikiImageCandidates(enQuery, viQuery) {
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const qWords = new Set(norm(`${enQuery || ''} ${viQuery || ''}`).split(/\W+/).filter(w => w.length > 2));
  const out = [];
  const seen = new Set();
  const search = async (host, q, limit) => {
    if (!q) return [];
    try {
      const res = await fetch(
        `https://${host}/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=${limit}&prop=pageimages|info|description&inprop=url&pithumbsize=500&format=json&origin=*`,
        { headers: { 'User-Agent': WIKI_UA } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Object.values(data.query?.pages || {});
    } catch (_) { return []; }
  };
  const push = (p) => {
    const title = p.title, thumb = p.thumbnail?.source;
    if (!title || !thumb) return;
    const key = norm(title);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ title, desc: p.description || '', thumb, url: p.fullurl || null });
  };
  (await search('en.wikipedia.org', enQuery, 5)).forEach(push);
  if (viQuery) (await search('vi.wikipedia.org', viQuery, 3)).forEach(push);
  // không AI vẫn tử tế: ứng viên trùng từ khóa nhiều nhất đứng trước
  out.sort((a, b) => {
    const sc = p => norm(p.title).split(/\W+/).filter(Boolean).reduce((a2, w) => a2 + (qWords.has(w) ? 1 : 0), 0);
    return sc(b) - sc(a);
  });
  return out.slice(0, 8);
}

// B+ lớp 1 — AI xếp hạng ứng viên ảnh theo thời đại: 1 call cho cả hành trình; trả null nếu lỗi/không có AI
async function aiPickMilestoneImages(ai, msTargets, candLists, wantsVi) {
  if (!ai || !msTargets.length) return null;
  const payload = msTargets.map((t, i) => ({
    milestone: i,
    period: t.period,
    title: t.title,
    visualSubject: t.visual,
    candidates: (candLists[i] || []).map((c, ix) => ({ index: ix, article: c.title, description: c.desc || '' })),
  }));
  const instruction = `You are the photo editor of a history-timeline notebook app. For each milestone, rank its Wikipedia-article photo candidates so the FIRST one is the image that best depicts the milestone FOR ITS ERA: an object, artifact, person or event that plausibly existed or happened in that period. Strongly demote modern products, modern devices or modern-day photos for historical eras, and demote unrelated articles even if their titles share a word. ${wantsVi ? 'Milestone titles are Vietnamese; judge by era and meaning, article language does not matter.' : ''} Return "picks": one array of ranked candidate indices per milestone (best first). Empty array if no candidate fits.`;
  const schema = {
    type: Type.OBJECT,
    properties: { picks: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.INTEGER } } } },
    required: ['picks'],
  };
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
    try {
      const response = await withTimeout(ai.models.generateContent({
        model,
        contents: instruction + '\n\n' + JSON.stringify(payload),
        config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 },
      }), 25000, `image-pick ${model}`);
      const parsed = JSON.parse(response.text);
      if (Array.isArray(parsed?.picks)) {
        console.log(`[Wiki] AI xếp hạng ảnh cho ${parsed.picks.length} mốc (${model})`);
        return parsed.picks;
      }
    } catch (err) {
      console.warn(`[Wiki] image-pick ${model} failed: ${String(err?.message || err).slice(0, 150)}`);
    }
  }
  return null;
}

// B+ lớp 2 — chốt thời đại bằng mắt AI: 1 call vision duy nhất cho tất cả ảnh đã chọn trong lượt
async function aiVisionGate(ai, enrichedMilestones, wantsVi) {
  if (!ai) return;
  const photos = [];
  for (const m of enrichedMilestones) {
    if (!m.img) continue;
    try {
      const res = await fetchWithTimeout(m.img, { headers: { 'User-Agent': WIKI_UA } }, 15000);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 3000000) continue;
      photos.push({ m, mime: res.headers.get('content-type') || 'image/jpeg', b64: buf.toString('base64') });
    } catch (_) {}
  }
  if (!photos.length) return;
  const parts = [];
  photos.forEach((p, k) => {
    parts.push({ text: `Ảnh ${k + 1} — mốc "${p.m.title}" (${p.m.period}).` });
    parts.push({ inlineData: { mimeType: p.mime, data: p.b64 } });
  });
  parts.push({
    text: `Bạn là soát viên thời đại cho một quyển sổ tay lịch sử. ${wantsVi ? 'Tiêu đề mốc bằng tiếng Việt.' : 'Milestone titles are in English.'} Hãy nhìn ${photos.length} ảnh theo thứ tự trên và gắn cờ những ảnh KHÔNG thể hiện một cách đáng tin cậy đồ vật/sự kiện của đúng thời đại đã nêu (ví dụ: sản phẩm điện tử hiện đại cho mốc thế kỷ XVI, món đồ ra đời sau năm của mốc). Chỉ gắn cờ khi chắc chắn lệch thời đại hoặc sai đối tượng. Trả về JSON: mảng số thứ tự các ảnh bị gắn cờ, rỗng nếu tất cả ổn.`,
  });
  const schema = {
    type: Type.OBJECT,
    properties: { flagged: { type: Type.ARRAY, items: { type: Type.INTEGER } } },
    required: ['flagged'],
  };
  for (const model of ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']) {
    try {
      const response = await withTimeout(ai.models.generateContent({
        model,
        contents: parts,
        config: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0 },
      }), 30000, `vision-gate ${model}`);
      const parsed = JSON.parse(response.text);
      const flagged = (Array.isArray(parsed?.flagged) ? parsed.flagged : [])
        .map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 1 && n <= photos.length);
      if (!flagged.length) {
        console.log(`[Wiki] Vision gate: ${photos.length} ảnh — tất cả đạt (${model})`);
        return;
      }
      console.log(`[Wiki] Vision gate gắn cờ ảnh số: ${flagged.join(', ')} (${model})`);
      for (const k of flagged) {
        const m = photos[k - 1].m;
        const altIx = (m.ranked || []).find(ix => ix !== m._pickIx && m.candidates[ix]);
        if (altIx !== undefined) {
          const alt = m.candidates[altIx];
          m._pickIx = altIx;
          m.img = alt.thumb;
          m.wikipediaTitle = alt.title;
          m.wikiUrl = alt.url || m.wikiUrl;
          m.isGeneric = false;
          if (wantsVi && alt.title) m.wikiUrl = await wikiLangLinkUrl(alt.title, 'vi') || m.wikiUrl;
          console.log(`[Wiki] Vision đổi ảnh mốc "${m.title}" -> "${alt.title}"`);
        } else if (m._generic?.img) {
          m.img = m._generic.img;
          m.wikipediaTitle = `${m._generic.wikipediaTitle} (minh họa cho "${m.title}")`;
          m.wikiUrl = m._generic.wikiUrl;
          m.isGeneric = true;
          console.log(`[Wiki] Vision đổi ảnh mốc "${m.title}" -> ảnh chủ đề (GENERIC)`);
        } else {
          m.img = null;
          m.wikipediaTitle = null;
          m.wikiUrl = null;
          m.isGeneric = false;
          console.log(`[Wiki] Vision gỡ ảnh mốc "${m.title}" -> không còn ứng viên thay thế`);
        }
      }
      return;
    } catch (err) {
      console.warn(`[Wiki] vision-gate ${model} failed: ${String(err?.message || err).slice(0, 150)}`);
    }
  }
}

// API endpoint for generating timeline evolution
// TEMP dev-only: model selection via dropdown (remove before submission, keep auto fallback)
app.post('/api/evolution', async (req, res) => {
  const { topic, lang: langRaw, userKey: userKeyRaw } = req.body;
  const wantsVi = (langRaw === 'vi' || langRaw === 'en') ? langRaw === 'vi' : VI_RE.test(topic || '');
  const errTopicRequired = wantsVi ? 'Vui lòng cung cấp chủ đề cần tìm hiểu.' : 'Please provide a topic to explore.';
  const errTryLater = wantsVi ? 'Vui lòng thử lại sau.' : 'Please try again later.';
  const keyInvalidMsg = wantsVi
    ? 'API key có vẻ chưa đúng. Key Google AI thường bắt đầu bằng "AIza" và dài khoảng 39 ký tự.'
    : 'That API key doesn\u2019t look right. Google AI keys usually start with "AIza" and are about 39 characters long.';
  const keyFailedMsg = wantsVi
    ? 'API key của bạn không dùng được — có thể key sai hoặc đã hết hạn mức. Hãy kiểm tra lại, hoặc xoá key trong phần 🔑 để dùng key mặc định của sổ.'
    : 'Your API key isn\u2019t working — it may be invalid or out of quota. Double-check it, or remove it in the 🔑 section to use the notebook\u2019s default key.';
  if (!topic || typeof topic !== 'string' || !topic.trim()) {
    return res.status(400).json({ error: errTopicRequired });
  }

  // BYOK: optional user-provided Google AI key — replaces the server key for the Google tier only.
  // The raw key must never be logged or echoed back.
  const userKey = typeof userKeyRaw === 'string' ? userKeyRaw.trim().slice(0, 200) : '';
  if (userKey && !/^[A-Za-z0-9_-]{20,}$/.test(userKey)) {
    return res.status(400).json({ error: keyInvalidMsg, keyError: true });
  }
  const usingUserKey = Boolean(userKey);
  const scrub = msg => (usingUserKey && typeof msg === 'string') ? msg.split(userKey).join('***') : msg;
  if (usingUserKey) {
    console.log(`[Evoluthing] BYOK: using user-provided Google AI key (length ${userKey.length})`);
  }
  let cleanTopic = topic.trim().slice(0,20);
  if (topic.trim().length > 20) {
    console.log(`[Evoluthing] Topic trimmed from ${topic.trim().length} to 20 chars`);
  }
  if (!cleanTopic) {
    return res.status(400).json({ error: errTopicRequired });
  }
  const ai = usingUserKey ? getAI(userKey) : getAI();

  try {
    let resultData = null;
    let modelUsed = null;

    const isVietnamese = wantsVi;

    const systemVN = `Bạn là một chuyên gia lịch sử, tư duy hệ thống và kể chuyện cuốn hút.

Nhiệm vụ của bạn là tái dựng quá trình một chủ đề đã phát triển và biến đổi như thế nào để trở thành hình thái của nó ngày nay.

Hãy ưu tiên:
- mối quan hệ nhân quả thay vì chỉ đơn thuần sắp xếp theo trình tự thời gian
- những bước ngoặt có ý nghĩa thay vì các sự kiện nhỏ lẻ
- mối liên kết rõ ràng giữa các giai đoạn tiến hóa
- những mối liên hệ bất ngờ, sự tương phản và những khoảnh khắc khiến người đọc "ồ, hóa ra là vậy"
- những thất bại, đánh đổi, bước lùi và hướng phát triển bị bỏ lại phía sau khi chúng thực sự góp phần định hình kết quả cuối cùng

Đừng chỉ nhìn sự tiến hóa dưới góc độ công nghệ. Hãy xem xét cách nhu cầu, hành vi, văn hóa, kinh tế, động lực lợi ích và những thay đổi trong xã hội có thể định hình quá trình tiến hóa.

Hãy viết bằng giọng kể tự nhiên, gần gũi và dễ tiếp cận.

Sử dụng ngôn ngữ đơn giản đến mức một bạn nhỏ 10–12 tuổi tò mò có thể hiểu được, nhưng vẫn đủ thú vị đối với người lớn. Tránh những thuật ngữ chuyên môn không cần thiết; với những thuật ngữ quan trọng, hãy giải thích bằng ngôn ngữ dễ hiểu trước khi sử dụng tên gọi của chúng.

Không viết như một bài bách khoa, sách giáo khoa hay bài nghiên cứu học thuật. Hãy dẫn dắt người đọc đi qua một quá trình khám phá.

Mục tiêu không chỉ là giải thích chuyện gì đã xảy ra, mà còn giúp người đọc hiểu vì sao chủ đề đó lại trở thành hình dạng như ngày nay.`;

    const systemEN = `You are an expert historian, systems thinker, and engaging storyteller.

Your task is to reconstruct how a given topic became what it is today.

Prioritize:
- causal relationships over simple chronology
- meaningful turning points over minor events
- clear connections between each stage of evolution
- surprising connections, contrasts, and "aha" moments
- failures, trade-offs, reversals, and abandoned paths when they meaningfully shaped the outcome

Think beyond technology. Consider how human needs, behavior, culture, economics, incentives, and social change can shape evolution.

Write in a natural, conversational, and accessible storytelling voice.

Use simple language that a curious 10–12-year-old can understand while remaining interesting to an adult. Avoid unnecessary jargon; explain important technical terms in plain language before using them.

Do not write like an encyclopedia, textbook, or academic paper. Guide the reader through a discovery.

The goal is not only to explain what happened, but to help the reader understand why the topic became what it is today.`;

    const userVN = `Khám phá quá trình tiến hóa của "${cleanTopic}".

Trước tiên, hãy viết một **hook** để mở đầu hành trình khám phá. Hook là trang đầu tiên người đọc nhìn thấy, có nhiệm vụ tạo sự tò mò và khiến họ muốn tiếp tục khám phá các mốc tiến hóa phía sau.

Hook phải:
- ngắn gọn và cuốn hút
- gợi ra một điều bất ngờ, nghịch lý hoặc thay đổi thú vị trong lịch sử của "${cleanTopic}"
- cho người đọc cảm nhận được hành trình tiến hóa tổng thể mà không kể hết nội dung của timeline
- được viết bằng giọng kể tự nhiên, gần gũi và trực tiếp với người đọc
- không sử dụng các câu mở đầu sáo rỗng hoặc mang tính công thức

Sau đó, xác định **5–7 bước ngoặt có ý nghĩa nhất** để giải thích vì sao "${cleanTopic}" đã trở thành hình thái như ngày nay.

Với mỗi bước ngoặt, hãy cung cấp:
- **title** — một tiêu đề ngắn gọn, rõ ràng, gọi tên trực tiếp mốc lịch sử
- **period** — năm hoặc giai đoạn lịch sử xảy ra. Sử dụng mốc thời gian chính xác nhất có thể xác định một cách đáng tin cậy: ưu tiên năm cụ thể khi đã được xác lập rõ; nếu không, sử dụng khoảng năm, thập niên, thế kỷ hoặc một giai đoạn rộng hơn. Không được tạo ra độ chính xác giả.
- **story** — văn xuôi tự nhiên chia thành **2–3 đoạn ngắn, các đoạn ngăn cách bằng một dòng trống**, giải thích điều gì đã thay đổi, vì sao nó thay đổi, thay đổi đó đã biến đổi "${cleanTopic}" như thế nào và nó dẫn đến giai đoạn tiếp theo ra sao. Tối đa 900 kí tự.
- **visualSubject** — người, đồ vật, sản phẩm, địa điểm, sự kiện hoặc hiện vật cụ thể đại diện trực quan rõ nhất cho mốc lịch sử này. Ưu tiên một đối tượng cụ thể, dễ xác định thay vì một khái niệm hoặc danh mục quá rộng. Visual subject phải khớp trực tiếp với tiêu đề và nội dung của mốc. Tránh sử dụng các đối tượng chung chung khi đã có một đối tượng cụ thể hơn phù hợp. Visual subject viết bằng tiếng Anh, là tên bài Wikipedia tiếng Anh có thể tồn tại.

Tiêu đề phải giúp người đọc ngay lập tức hiểu mốc đó là gì. Ưu tiên một sự kiện lịch sử, phát minh, bước phát triển hoặc sự chuyển đổi cụ thể thay vì một ẩn dụ mơ hồ.

Phần nội dung phải được viết bằng văn xuôi tự nhiên, chia thành 2–3 đoạn ngắn; mỗi đoạn cách nhau bởi đúng một dòng trống. Hãy xuống đoạn khi câu chuyện chuyển sang một ý chính, diễn biến, hệ quả hoặc giai đoạn mới.

Không sử dụng nhãn, tiêu đề phụ, gạch đầu dòng, chú thích, các từ ghép có dấu gạch ngang không cần thiết, tính từ cường điệu hoặc những cách đánh dấu mang tính công thức trong phần nội dung.

Hãy lồng ghép quá trình suy luận một cách tự nhiên vào câu chuyện. Để người đọc tự nhận ra những insight quan trọng thay vì gọi tên hoặc giải thích chúng bằng các nhãn riêng.

Hãy viết các mốc như một câu chuyện tiến hóa có sự kết nối với nhau, thay vì một danh sách các sự kiện lịch sử rời rạc.

Ngôn ngữ phản hồi: tiếng Việt. Bắt buộc viết tiếng Việt có đầy đủ dấu, tuyệt đối không dùng tiếng Việt không dấu (ví dụ phải viết "máy tính" chứ không phải "may tinh").`;

    const userEN = `Explore the evolution of "${cleanTopic}".

First, write a **hook** to open the exploration journey. The hook is the first page the reader sees. Its purpose is to spark curiosity and make the reader want to continue exploring the evolution milestones that follow.

The hook should:
- be concise and engaging
- reveal an unexpected fact, paradox, or interesting transformation in the history of "${cleanTopic}"
- give the reader a sense of the overall evolutionary journey without revealing the full timeline
- use a natural, conversational voice that speaks directly and warmly to the reader
- avoid generic, clichéd, or formulaic openings

After that, identify the 5–7 most meaningful turning points that explain how "${cleanTopic}" became what it is today.

For each turning point, provide:
- title — a short, clear title that names the historical milestone
- period — the year or historical period when it occurred. Use the most precise historically defensible date available: a specific year when well established, otherwise a year range, decade, century, or broader period. Never invent precision.
- story — a natural prose narrative divided into 2–3 short paragraphs separated by a blank line, explaining what changed, why it happened, how it transformed "${cleanTopic}", and how it led toward the next stage. Maximum length: 900 characters.
- visualSubject — the specific person, object, product, place, event, or artifact that best represents this milestone visually. Prefer a concrete, specific subject over a broad category. The visual subject must directly match the milestone's title and story. Avoid broad or generic subjects when a more specific subject exists. Write visualSubject in English as an English Wikipedia article title.

The title should make the milestone immediately understandable. Prefer a concrete historical event, invention, development, or transformation over a vague metaphor.

The story must be written as natural, flowing prose and divided into 2–3 short paragraphs separated by a blank line. Start a new paragraph when the narrative shifts to a new idea, development, consequence, or stage of the story.

Do not use labels, subheadings, bullet points, annotations, hyphenated compounds, exaggerated adjectives or formulaic markers inside the story.

The reasoning should be embedded naturally in the narrative. Let the reader discover the important insight through the story rather than explicitly labeling it.

Write the milestones as a connected evolutionary story rather than a simple list of unrelated historical events.

Response in language: English`;

    const prompt = isVietnamese ? `${systemVN}\n\n${userVN}` : `${systemEN}\n\n${userEN}`;

    const storyTitle = isVietnamese
      ? `Sự tiến hóa của ${cleanTopic}`
      : `The Evolution of ${cleanTopic.charAt(0).toUpperCase() + cleanTopic.slice(1)}`;

    const googleSchema = {
      type: Type.OBJECT,
      properties: {
        hook: { type: Type.STRING, description: "A warm 2-3 sentence opening paragraph (sapo) in the notebook's handwritten voice, same language as the user, inviting the reader to explore the journey" },
        milestones: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Short clear milestone title" },
              period: { type: Type.STRING, description: "Year or period (specific year or range/decade/century, never invent precision)" },
              story: { type: Type.STRING, description: "Natural prose in 2-3 short paragraphs separated by a blank line, max 900 characters, explaining what changed, why, how it transformed the topic and led to next stage" },
              visualSubject: { type: Type.STRING, description: "Specific person/object/artifact/event/place that best represents this milestone visually, in English Wikipedia title form" },
            },
            required: ['title', 'period', 'story', 'visualSubject'],
          },
        },
      },
      required: ['hook', 'milestones'],
    };

    {
      // Auto fallback chain (Google 4 -> Groq 2 -> OpenRouter 2)
      if (ai) {
        for (const model of FALLBACK_GOOGLE) {
          try {
            console.log(`[Evoluthing] Trying Google ${model} for "${cleanTopic}"...`);
            const response = await withTimeout(
              ai.models.generateContent({
                model,
                contents: prompt,
                config: { responseMimeType: 'application/json', responseSchema: googleSchema },
              }),
              MODEL_TIMEOUT_MS,
              `Google ${model}`
            );
            if (response.text) {
              const parsed = JSON.parse(response.text);
              if (parsed?.milestones?.length) {
                resultData = parsed;
                modelUsed = model;
                console.log(`[Evoluthing] Google ${model} succeeded (${parsed.milestones.length} milestones)`);
                break;
              }
            }
            console.warn(`[Evoluthing] Google ${model} returned empty, trying next...`);
          } catch (err) {
            console.warn(`[Evoluthing] Google ${model} failed: ${scrub(err.message)} -> fallback`);
          }
        }
      } else {
        console.warn('[Evoluthing] Skipping Google tier (no GEMINI_API_KEY)');
      }

      // BYOK: with a user key the Google tier is the only tier — never fall through to server-key tiers
      if (!resultData?.milestones?.length && usingUserKey) {
        console.warn('[Evoluthing] BYOK: all Google models failed with user key -> keyError');
        return res.status(403).json({ error: keyFailedMsg, keyError: true });
      }

      if (!resultData?.milestones?.length) {
        const groqKey = process.env.GROQ_API_KEY;
        if (groqKey) {
          // GPT OSS ignores Vietnamese prompt and answers in English → exclude from Vietnamese fallback
          const groqCandidates = isVietnamese ? FALLBACK_GROQ.filter(m => !m.startsWith('openai/gpt-oss')) : FALLBACK_GROQ;
          if (isVietnamese && groqCandidates.length !== FALLBACK_GROQ.length) {
            console.log(`[Evoluthing] Vietnamese topic — skipping GPT OSS in Groq fallback (${FALLBACK_GROQ.length - groqCandidates.length} model(s) excluded)`);
          }
          for (const model of groqCandidates) {
            try {
              console.log(`[Evoluthing] Trying Groq ${model} for "${cleanTopic}"...`);
              const groqRes = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  model,
                  messages: [
                    { role: 'system', content: 'You are Evoluthing AI, an expert historian and educational storyteller for an interactive vintage notebook. Respond with valid JSON only, no markdown fences.' },
                    { role: 'user', content: prompt + '\n\nRespond with JSON matching schema: { "hook": string, "milestones": [{ "title": string, "period": string, "story": string, "visualSubject": string }] }' },
                  ],
                  temperature: 0.7,
                  max_tokens: 4096,
                  response_format: { type: 'json_object' },
                }),
              }, MODEL_TIMEOUT_MS);
              if (!groqRes.ok) {
                const errText = await groqRes.text().catch(() => '');
                throw new Error(`HTTP ${groqRes.status} ${errText.slice(0,200)}`);
              }
              const groqData = await groqRes.json();
              const content = groqData?.choices?.[0]?.message?.content;
              if (!content) throw new Error('Empty content from Groq');
              const parsed = JSON.parse(content);
              if (parsed?.milestones?.length) {
                resultData = parsed;
                modelUsed = model;
                console.log(`[Evoluthing] Groq ${model} succeeded (${parsed.milestones.length} milestones)`);
                break;
              }
              console.warn(`[Evoluthing] Groq ${model} returned empty, trying next...`);
            } catch (err) {
              console.warn(`[Evoluthing] Groq ${model} failed: ${err.message} -> fallback`);
            }
          }
        } else {
          console.warn('[Evoluthing] GROQ_API_KEY not set, skipping Groq tier');
        }
      }

      if (!resultData?.milestones?.length) {
        const openrouterKey = process.env.OPENROUTER_API_KEY;
        if (openrouterKey) {
          for (const model of FALLBACK_OPENROUTER) {
            try {
              console.log(`[Evoluthing] Trying OpenRouter ${model} for "${cleanTopic}"...`);
              const openRes = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${openrouterKey}`,
                  'Content-Type': 'application/json',
                  'HTTP-Referer': 'https://evoluthing.app',
                  'X-Title': 'Evoluthing',
                },
                body: JSON.stringify({
                  model,
                  messages: [
                    { role: 'system', content: 'You are Evoluthing AI, an expert historian and educational storyteller for an interactive vintage notebook. Respond with valid JSON only, no markdown fences.' },
                    { role: 'user', content: prompt + '\n\nRespond with JSON matching schema: { "hook": string, "milestones": [{ "title": string, "period": string, "story": string, "visualSubject": string }] }' },
                  ],
                  temperature: 0.7,
                  max_tokens: 4096,
                  response_format: { type: 'json_object' },
                }),
              }, MODEL_TIMEOUT_MS);
              if (!openRes.ok) {
                const errText = await openRes.text().catch(() => '');
                throw new Error(`HTTP ${openRes.status} ${errText.slice(0,200)}`);
              }
              const openData = await openRes.json();
              const content = openData?.choices?.[0]?.message?.content;
              if (!content) throw new Error('Empty content from OpenRouter');
              const parsed = JSON.parse(content);
              if (parsed?.milestones?.length) {
                resultData = parsed;
                modelUsed = model;
                console.log(`[Evoluthing] OpenRouter ${model} succeeded (${parsed.milestones.length} milestones)`);
                break;
              }
              console.warn(`[Evoluthing] OpenRouter ${model} returned empty, trying next...`);
            } catch (err) {
              console.warn(`[Evoluthing] OpenRouter ${model} failed: ${err.message} -> fallback`);
            }
          }
        } else {
          console.warn('[Evoluthing] OPENROUTER_API_KEY not set, skipping OpenRouter tier');
        }
      }

      if (!resultData?.milestones?.length) {
        console.error(`[Evoluthing] All 12 models failed for "${cleanTopic}" (auto)`);
        return res.status(503).json({
          error: 'Vui lòng thử lại sau.',
          details: 'All AI models failed or returned empty',
        });
      }
    }

    // Generic illustrative fallback for the whole topic (1 fetch, reused for any milestone without specific image)
    let genericInfo = null;
    try {
      genericInfo = await fetchWikipediaInfo({ visualSubject: cleanTopic, title: cleanTopic, story: '' });
      if (genericInfo?.img) console.log(`[Wiki] Generic topic "${cleanTopic}" -> ${genericInfo.wikipediaTitle} | img OK`);
      else console.log(`[Wiki] Generic topic "${cleanTopic}" -> no image`);
    } catch (_) {}

    // Gom ứng viên ảnh cho từng mốc (song song) — đầu vào cho AI chọn theo thời đại
    const msTargets = resultData.milestones.map(m => {
      const titleVal = m.title || m.name || '';
      const periodVal = m.period || m.year || '';
      const storyVal = m.story || (m.what ? `${m.what} ${m.why||''}`.trim() : '');
      const visualVal = m.visualSubject || m.wikipediaQuery || titleVal;
      const storyCapped = storyVal.length > 900 ? storyVal.slice(0, 897) + '...' : storyVal;
      return { title: titleVal, period: periodVal, storyCapped, visual: visualVal };
    });
    const candLists = await Promise.all(msTargets.map(t =>
      wikiImageCandidates(t.visual, wantsVi ? cleanTopic : null)
    ));

    // B+ lớp 1: AI xếp hạng ứng viên theo thời đại (1 call) — null -> dùng thứ tự điểm trùng từ khóa
    const picks = await aiPickMilestoneImages(ai, msTargets, candLists, wantsVi);

    const enrichedMilestones = await Promise.all(msTargets.map(async (t, i) => {
      const cands = candLists[i] || [];
      const seenIx = new Set();
      const ranked = ((picks && picks[i]) || []).map(n => Number(n))
        .filter(n => Number.isInteger(n) && n >= 0 && n < cands.length)
        .filter(ix => (seenIx.has(ix) ? false : (seenIx.add(ix), true)));
      const pickIx = ranked.length ? ranked[0] : (cands.length ? 0 : -1);
      let chosen = pickIx >= 0 ? cands[pickIx] : null;
      let isGeneric = false;
      if (!chosen && genericInfo?.img) {
        chosen = { title: genericInfo.wikipediaTitle, thumb: genericInfo.img, url: genericInfo.wikiUrl, desc: '' };
        isGeneric = true;
      }
      let wikipediaTitle = chosen ? chosen.title : null;
      let wikiUrl = chosen ? (chosen.url || null) : null;
      if (isGeneric) {
        wikipediaTitle = `${genericInfo.wikipediaTitle} (minh họa cho "${t.title}")`;
        wikiUrl = genericInfo.wikiUrl;
      } else if (chosen && wantsVi && chosen.title) {
        wikiUrl = await wikiLangLinkUrl(chosen.title, 'vi') || wikiUrl;
      }
      console.log(`[Wiki] "${t.title}" (${t.period}) | visual="${t.visual}" | cands=${cands.length} | pick=${chosen ? chosen.title : 'null'}${isGeneric ? ' (GENERIC)' : ''}`);
      return {
        title: t.title,
        period: t.period,
        story: t.storyCapped,
        visualSubject: t.visual,
        wikipediaTitle,
        img: chosen ? chosen.thumb : null,
        wikiUrl,
        isGeneric,
        _pickIx: pickIx,
        _generic: genericInfo,
        ranked,
        candidates: cands,
      };
    }));

    // B+ lớp 2: chốt thời đại bằng mắt AI (1 call cho cả lượt) — đổi ảnh bị gắn cờ sang ứng viên kế tiếp
    await aiVisionGate(ai, enrichedMilestones, wantsVi);

    // dọn trường nội bộ trước khi trả về client
    for (const m of enrichedMilestones) {
      delete m._pickIx; delete m._generic; delete m.ranked; delete m.candidates;
    }

    res.json({
      success: true,
      topic: cleanTopic,
      title: storyTitle,
      hook: resultData.hook || '',
      milestones: enrichedMilestones,
      modelUsed: modelUsed || 'auto',
      lang: isVietnamese ? 'vi' : 'en',
    });
  } catch (error) {
    console.error('[Evoluthing] Generation error:', scrub(String(error?.message || error)));
    res.status(500).json({
      error: 'Vui lòng thử lại sau.',
      details: scrub(String(error?.message || '')),
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});

