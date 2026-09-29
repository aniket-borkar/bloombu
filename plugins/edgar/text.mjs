// Filing text for the AI analyst: HTML to plain text, "Item" sections, and paragraph diffs.

const ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  mdash: "\u2014",
  ndash: "\u2013",
  bull: "\u2022",
  hellip: "\u2026",
  reg: "\u00ae",
  trade: "\u2122",
  copy: "\u00a9",
};

const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Readable text from filing HTML (including inline XBRL): one block per line, table cells separated by spaces. */
export function htmlToText(html) {
  return decode(
    String(html)
      .replace(/<(head|script|style|ix:header)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6]|table|title)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const ITEM_RE = /^item\s+(\d{1,2}[a-d]?(?:\.\d{2})?)\s*[.:\u2013\u2014-]?\s*(.{0,150})$/i;
const PART_RE = /^part\s+(iv|i{1,3})\b/i;

/**
 * "Item" sections of a 10-K, 10-Q, 20-F or 8-K, keyed "1A", "7", "2.02", or
 * "II-1A" once a "Part" heading has been seen. A table of contents repeats
 * every heading, so the longest text under each key wins.
 */
export function splitSections(text) {
  const marks = [];
  let part = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const p = PART_RE.exec(line);
    const m = p ? null : ITEM_RE.exec(line);
    if (p) part = p[1].toUpperCase();
    else if (m) marks.push({ item: m[1].toUpperCase(), part, title: m[2].replace(/\s+\d{1,3}$/, "").trim(), at });
    at += line.length + 1;
  }
  const sections = new Map();
  marks.forEach((mk, i) => {
    const body = text.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : text.length).trim();
    const key = mk.part ? `${mk.part}-${mk.item}` : mk.item;
    const prev = sections.get(key);
    if (!prev || body.length > prev.text.length) sections.set(key, { key, item: mk.item, part: mk.part, title: mk.title || prev?.title || "", text: body });
  });
  return sections;
}

const ALIASES = {
  "10-K": {
    business: "1",
    risk: "1A",
    "risk factors": "1A",
    cybersecurity: "1C",
    legal: "3",
    "legal proceedings": "3",
    mda: "7",
    "md&a": "7",
    "management's discussion": "7",
    "market risk": "7A",
    financials: "8",
    "financial statements": "8",
    controls: "9A",
  },
  "10-Q": {
    financials: "I-1",
    "financial statements": "I-1",
    mda: "I-2",
    "md&a": "I-2",
    "management's discussion": "I-2",
    "market risk": "I-3",
    controls: "I-4",
    legal: "II-1",
    "legal proceedings": "II-1",
    risk: "II-1A",
    "risk factors": "II-1A",
  },
  "20-F": { risk: "3", "risk factors": "3", business: "4", mda: "5", "operating and financial review": "5" },
  "8-K": { results: "2.02", earnings: "2.02", "results of operations": "2.02" },
};

export const SECTION_NAMES = Object.fromEntries(Object.entries(ALIASES).map(([form, a]) => [form, [...new Set(Object.keys(a))]]));

/**
 * A section by item number ("1A", "2.02"), part and item ("II-1") or name
 * ("risk factors", "mda") for the given form. Without a part, the longest
 * section with that item number wins, which skips table-of-contents entries.
 */
export function findSection(sections, form, wanted) {
  const w = String(wanted ?? "")
    .trim()
    .toLowerCase()
    .replace(/^item\s+/, "")
    .replace(/[\u2018\u2019]/g, "'");
  const key = (ALIASES[String(form).replace(/\/A$/, "")]?.[w] ?? w).toUpperCase();
  const part = /^(IV|I{1,3})-/.exec(key)?.[1];
  const item = key.replace(/^(IV|I{1,3})-/, "");
  const candidates = [...sections.values()].filter((s) => s.item === item);
  const inPart = candidates.filter((s) => s.part === part);
  return [...(part && inPart.length ? inPart : candidates)].sort((a, b) => b.text.length - a.text.length)[0] ?? null;
}

/** "Item 1A", or "Part II Item 1" when the part matters (10-Q items repeat across parts). */
export function sectionLabel(section, form) {
  return section.part && /^10-Q/.test(form) ? `Part ${section.part} Item ${section.item}` : `Item ${section.item}`;
}

/** Substantive paragraphs: lines long enough to be prose rather than headings or page numbers. */
export function paragraphs(text) {
  return String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 40 && !/^table of contents$/i.test(l));
}

const norm = (p) => p.toLowerCase().replace(/\s+/g, " ").trim();
const words = (p) => new Set(norm(p).split(/[^a-z0-9%$]+/).filter((w) => w.length > 2));
const jaccard = (a, b) => {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return both / (a.size + b.size - both || 1);
};

/**
 * Paragraph-level changes between two versions of a section: paragraphs that
 * are new, gone, or reworded (matched to their closest old version by shared words).
 */
export function diffParagraphs(oldText, newText) {
  const before = paragraphs(oldText);
  const after = paragraphs(newText);
  const oldNorms = new Set(before.map(norm));
  const newNorms = new Set(after.map(norm));
  const pool = before.filter((p) => !newNorms.has(norm(p))).map((p) => ({ p, w: words(p), used: false }));
  const added = [];
  const changed = [];
  for (const p of after.filter((x) => !oldNorms.has(norm(x)))) {
    const w = words(p);
    let best = null;
    let score = 0;
    for (const c of pool) {
      if (c.used) continue;
      const s = jaccard(w, c.w);
      if (s > score) [best, score] = [c, s];
    }
    if (best && score >= 0.5) {
      best.used = true;
      changed.push({
        before: best.p,
        after: p,
        newTerms: [...w].filter((x) => !best.w.has(x)).slice(0, 12),
        droppedTerms: [...best.w].filter((x) => !w.has(x)).slice(0, 12),
      });
    } else added.push(p);
  }
  return {
    added,
    removed: pool.filter((c) => !c.used).map((c) => c.p),
    changed,
    unchanged: after.filter((p) => oldNorms.has(norm(p))).length,
  };
}

/** A page of `text` starting at `offset` that fits `chars`, ending at a line break when one is near. */
export function page(text, offset, chars) {
  const start = Math.min(Math.max(0, Math.trunc(Number(offset) || 0)), text.length);
  let end = Math.min(text.length, start + chars);
  if (end < text.length) {
    const cut = text.lastIndexOf("\n", end);
    if (cut > start + chars * 0.6) end = cut;
  }
  return { offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length, text: text.slice(start, end) };
}
