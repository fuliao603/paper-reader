const PAPER_MAJOR_HEADING_PATTERN =
  /^(?:abstract|summary|keywords?|introduction|background|related work|literature review|materials(?: and methods)?|methods?|methodology|experimental setup|experiments?|results?|discussion|conclusions?|concluding remarks|acknowledg(?:e)?ments?|references|bibliography|appendix|supplementary materials?)\b/i
const ENGLISH_CHAPTER_PATTERN = /^(?:chapter|part)\s+(?:\d+|[ivxlcdm]+)\b/i
const ENGLISH_SECTION_PATTERN = /^section\s+\d+(?:\.\d+){1,3}\b/i
const CHINESE_CHAPTER_PATTERN = /^第[一二三四五六七八九十百零〇两\d]+[章篇部卷]\s*/
const CHINESE_SECTION_PATTERN = /^第[一二三四五六七八九十百零〇两\d]+(?:节|小节)\s*/
const NUMBERED_HEADING_PATTERN = /^(\d+(?:\.\d+){0,3})(?:[\s.)、：:-]+)(.+)/
const CHINESE_NUMBERED_PATTERN = /^[一二三四五六七八九十百零〇两]+[、.．]\s*/
const FIGURE_TABLE_PATTERN =
  /^(?:fig(?:ure)?\.?|table|scheme|equation|eq\.?|algorithm|图|表|算法)\s*[\d一二三四五六七八九十]*/i
const REFERENCE_ENTRY_PATTERN =
  /^(?:\[\d+\]|\(\d{4}[a-z]?\)|\d+\.\s+[A-Z][a-z]+,\s+[A-Z]\.|[A-Z][a-z-]+,\s+[A-Z]\.)/
const TECHNICAL_NOISE_PATTERN =
  /(?:doi:|https?:\/\/|www\.|@[\w.-]+\.\w+|copyright|all rights reserved|accepted manuscript|preprint|journal|volume|vol\.|issue|issn|isbn|publisher|press\b)/i
const CONTENTS_HEADING_PATTERN = /^(?:table of contents|contents|目录|目\s*录)$/i
const TOC_DOTTED_LINE_PATTERN =
  /^(.{2,180}?)(?:\.{2,}|…{2,}|·{3,}|\s{3,})\s*([ivxlcdm]+|\d{1,4})$/i
const TOC_TRAILING_PAGE_PATTERN = /^(.{2,180}?)\s+([ivxlcdm]+|\d{1,4})$/i
const MAX_TOC_ITEMS = 180
const MAX_TOC_ITEMS_PER_PAGE = 8
const MIN_TOC_CANDIDATES = 2

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function cleanTocTitle(value) {
  return normalizeText(value)
    .replace(/(?:\.{2,}|…{2,}|·{3,})\s*(?:[ivxlcdm]+|\d{1,4})\s*$/i, '')
    .trim()
    .slice(0, 180)
}

function normalizeHeadingKey(value) {
  return cleanTocTitle(value)
    .replace(/^[\s"'“”‘’()[\]{}]+|[\s"'“”‘’()[\]{}:：.;。]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function stripHeadingNumber(value) {
  return normalizeHeadingKey(value)
    .replace(NUMBERED_HEADING_PATTERN, '$2')
    .replace(/^[A-Z][.)、]\s+/, '')
}

function romanToNumber(value) {
  const roman = String(value || '').toUpperCase()
  if (!roman || !/^[IVXLCDM]+$/.test(roman)) return null
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  let total = 0
  for (let index = 0; index < roman.length; index += 1) {
    const current = values[roman[index]]
    const next = values[roman[index + 1]] || 0
    total += current < next ? -current : current
  }
  return total > 0 ? total : null
}

function parsePrintedPage(value) {
  const text = String(value || '').trim()
  if (/^\d{1,4}$/.test(text)) {
    return { number: Number(text), label: text, roman: false }
  }
  const roman = romanToNumber(text)
  return roman ? { number: roman, label: text, roman: true } : null
}

function getNumberedLevel(title) {
  const match = cleanTocTitle(title).match(NUMBERED_HEADING_PATTERN)
  if (!match) return null
  const firstNumber = Number(match[1].split('.')[0])
  if (!Number.isFinite(firstNumber) || firstNumber < 1 || firstNumber > 300) return null
  return clamp(match[1].split('.').length, 1, 3)
}

function getExplicitHeadingLevel(title) {
  const cleanTitle = cleanTocTitle(title)
  if (CHINESE_CHAPTER_PATTERN.test(cleanTitle) || ENGLISH_CHAPTER_PATTERN.test(cleanTitle)) return 1
  if (CHINESE_SECTION_PATTERN.test(cleanTitle) || ENGLISH_SECTION_PATTERN.test(cleanTitle)) return 2

  const numberedLevel = getNumberedLevel(cleanTitle)
  if (numberedLevel) return numberedLevel
  if (PAPER_MAJOR_HEADING_PATTERN.test(stripHeadingNumber(cleanTitle))) return 1
  if (CHINESE_NUMBERED_PATTERN.test(cleanTitle)) return 1
  return null
}

function isSentenceLike(title) {
  const cleanTitle = cleanTocTitle(title)
  if (cleanTitle.length > 150) return true
  if (/[,;，；。！？?]\s*$/.test(cleanTitle)) return true
  return cleanTitle.split(/\s+/).filter(Boolean).length > 18
}

function isNoiseTitle(title) {
  const cleanTitle = cleanTocTitle(title)
  if (!cleanTitle || cleanTitle.length < 2) return true
  if (/^\d{1,4}$/.test(cleanTitle)) return true
  if (CONTENTS_HEADING_PATTERN.test(cleanTitle)) return true
  if (FIGURE_TABLE_PATTERN.test(cleanTitle)) return true
  if (REFERENCE_ENTRY_PATTERN.test(cleanTitle)) return true
  if (TECHNICAL_NOISE_PATTERN.test(cleanTitle)) return true
  if (/^[.\-–—•·\s]+$/.test(cleanTitle)) return true
  return false
}

function isEnglishTitleLike(title) {
  if (PAPER_MAJOR_HEADING_PATTERN.test(stripHeadingNumber(title))) return true
  if (ENGLISH_CHAPTER_PATTERN.test(title) || ENGLISH_SECTION_PATTERN.test(title)) return true

  const words = title.match(/[A-Za-z][A-Za-z'-]*/g) || []
  if (!words.length) return false
  const meaningful = words.filter((word) => word.length > 2)
  if (!meaningful.length) return true
  const titleCase = meaningful.filter((word) => /^[A-Z]/.test(word))
  const allCaps = title === title.toUpperCase() && /[A-Z]/.test(title)
  return allCaps || titleCase.length / meaningful.length >= 0.5
}

function isTitleLike(title) {
  return /[\u4e00-\u9fff]/.test(title) || isEnglishTitleLike(title)
}

function getDominantFontSize(lines) {
  const buckets = new Map()
  lines.forEach((line) => {
    const fontSize = Number(line?.fontSize)
    if (!Number.isFinite(fontSize) || fontSize <= 0) return
    const bucket = Math.round(fontSize * 2) / 2
    const weight = Math.max(1, cleanTocTitle(line.text).length)
    buckets.set(bucket, (buckets.get(bucket) || 0) + weight)
  })
  return Array.from(buckets.entries())
    .sort((first, second) => second[1] - first[1] || first[0] - second[0])[0]?.[0] || 0
}

function getAllPageLines(pages) {
  return (Array.isArray(pages) ? pages : []).flatMap((page) => (
    Array.isArray(page?.lines)
      ? page.lines.map((line, lineIndex) => ({
          ...line,
          pageNumber: Number(page.pageNumber) || 1,
          pageIndex: Math.max(0, (Number(page.pageNumber) || 1) - 1),
          pageWidth: Number(page.pageWidth) || 0,
          pageHeight: Number(page.pageHeight) || 0,
          lineIndex,
        }))
      : []
  ))
}

function getRepeatedMarginKeys(pages) {
  const occurrences = new Map()
  const pageCount = Math.max(1, pages.length)

  getAllPageLines(pages).forEach((line) => {
    const pageHeight = Number(line.pageHeight) || 0
    const y = Number(line.y)
    if (!pageHeight || !Number.isFinite(y)) return
    const isMargin = y >= pageHeight * 0.86 || y <= pageHeight * 0.1
    if (!isMargin) return
    const key = normalizeHeadingKey(line.text)
    if (!key || key.length < 3) return
    if (!occurrences.has(key)) occurrences.set(key, new Set())
    occurrences.get(key).add(line.pageIndex)
  })

  return new Set(
    Array.from(occurrences.entries())
      .filter(([, pageIndexes]) => pageIndexes.size >= Math.max(3, Math.ceil(pageCount * 0.18)))
      .map(([key]) => key),
  )
}

function countMatches(text, pattern) {
  return (String(text || '').match(pattern) || []).length
}

export function classifyDocumentType(pages, totalPages = pages?.length || 0) {
  const firstPagesText = (Array.isArray(pages) ? pages.slice(0, 20) : [])
    .map((page) => page?.text || '')
    .join('\n')
  const normalized = firstPagesText.toLowerCase()
  const paperSignals = [
    /\babstract\b/i,
    /\bkeywords?\b/i,
    /\bintroduction\b/i,
    /\b(?:methods?|methodology|materials and methods)\b/i,
    /\bresults?\b/i,
    /\breferences\b/i,
  ].filter((pattern) => pattern.test(normalized)).length
  const bookSignals =
    countMatches(firstPagesText, /\bchapter\s+(?:\d+|[ivxlcdm]+)\b/gi) +
    countMatches(firstPagesText, /\bpart\s+(?:\d+|[ivxlcdm]+)\b/gi) +
    countMatches(firstPagesText, /第[一二三四五六七八九十百零〇两\d]+章/g) +
    (CONTENTS_HEADING_PATTERN.test(normalizeText(firstPagesText.split(/\r?\n/)[0])) ? 2 : 0)

  let documentType = 'unknown'
  let confidence = 0.5
  if (bookSignals >= 3 || (Number(totalPages) >= 100 && bookSignals >= 1)) {
    documentType = 'book'
    confidence = clamp(0.58 + bookSignals * 0.07 + (Number(totalPages) >= 100 ? 0.1 : 0), 0, 0.98)
  } else if (paperSignals >= 3 || (Number(totalPages) <= 80 && paperSignals >= 2)) {
    documentType = 'paper'
    confidence = clamp(0.58 + paperSignals * 0.065 + (Number(totalPages) <= 80 ? 0.08 : 0), 0, 0.98)
  }

  return {
    documentType,
    confidence,
    signals: { paper: paperSignals, book: bookSignals, totalPages: Number(totalPages) || 0 },
  }
}

function scoreHeadingLine(line, context) {
  const title = cleanTocTitle(line.text)
  const reasons = []
  const penalties = []
  if (isNoiseTitle(title)) return { rejected: true, title, reasons, penalties: ['noise-pattern'] }

  const explicitLevel = getExplicitHeadingLevel(title)
  const fontSize = Number(line.fontSize) || 0
  const fontRatio = context.bodyFontSize > 0 && fontSize > 0 ? fontSize / context.bodyFontSize : 1
  const y = Number(line.y)
  const pageHeight = Number(line.pageHeight) || 0
  const nearTop = pageHeight > 0 && Number.isFinite(y) && y >= pageHeight * 0.68
  const repeatedMargin = context.repeatedMarginKeys.has(normalizeHeadingKey(title))
  let score = 0

  if (explicitLevel) {
    score += explicitLevel === 1 ? 7 : 6
    reasons.push(`explicit-level-${explicitLevel}`)
  }
  if (PAPER_MAJOR_HEADING_PATTERN.test(stripHeadingNumber(title))) {
    score += context.documentType === 'paper' ? 7 : 5
    reasons.push('paper-major-heading')
  }
  if (ENGLISH_CHAPTER_PATTERN.test(title) || CHINESE_CHAPTER_PATTERN.test(title)) {
    score += context.documentType === 'book' ? 8 : 6
    reasons.push('chapter-pattern')
  }
  if (ENGLISH_SECTION_PATTERN.test(title) || CHINESE_SECTION_PATTERN.test(title)) {
    score += context.documentType === 'book' ? 7 : 5
    reasons.push('section-pattern')
  }
  if (fontRatio >= 1.34) {
    score += 4
    reasons.push('large-font')
  } else if (fontRatio >= 1.18) {
    score += 2
    reasons.push('medium-font')
  }
  if (line.bold) {
    score += 2
    reasons.push('bold')
  }
  if (title.length >= 3 && title.length <= 90) {
    score += 1
    reasons.push('title-length')
  }
  if (nearTop) {
    score += 1
    reasons.push('page-top')
  }
  if (Number(line.spaceBefore) >= Math.max(8, fontSize * 0.8)) {
    score += 1
    reasons.push('space-before')
  }
  if (Number(line.spaceAfter) >= Math.max(8, fontSize * 0.8)) {
    score += 1
    reasons.push('space-after')
  }
  if (!isTitleLike(title) && !explicitLevel) {
    score -= 3
    penalties.push('not-title-case')
  }
  if (isSentenceLike(title)) {
    score -= title.length > 150 ? 7 : 4
    penalties.push('sentence-like')
  }
  if (!explicitLevel && fontRatio < 1.12 && !line.bold) {
    score -= 3
    penalties.push('body-like-style')
  }
  if (repeatedMargin) {
    score -= 12
    penalties.push('repeated-header-footer')
  }

  const threshold = context.documentType === 'book' ? 6 : context.documentType === 'paper' ? 7 : 7.5
  return {
    rejected: score < threshold,
    title,
    level: explicitLevel || (fontRatio >= 1.34 ? 1 : 2),
    score,
    confidence: clamp(0.45 + score * 0.045, 0.35, 0.97),
    reasons,
    penalties,
  }
}

export function extractHeadingCandidates(pages, options = {}) {
  const safePages = Array.isArray(pages) ? pages : []
  const allLines = getAllPageLines(safePages)
  const bodyFontSize = getDominantFontSize(allLines)
  const repeatedMarginKeys = getRepeatedMarginKeys(safePages)
  const documentType = options.documentType || classifyDocumentType(safePages, options.totalPages).documentType
  const candidates = []
  const diagnostics = []
  const perPageCount = new Map()

  allLines.forEach((line, index) => {
    const result = scoreHeadingLine(line, {
      bodyFontSize,
      documentType,
      repeatedMarginKeys,
    })
    diagnostics.push({
      title: result.title,
      pageNumber: line.pageNumber,
      score: Number(result.score) || 0,
      reasons: result.reasons || [],
      penalties: result.penalties || [],
      rejected: Boolean(result.rejected),
    })
    if (result.rejected) return

    const pageCount = perPageCount.get(line.pageIndex) || 0
    if (pageCount >= MAX_TOC_ITEMS_PER_PAGE) return
    perPageCount.set(line.pageIndex, pageCount + 1)
    candidates.push({
      id: `body-${line.pageIndex}-${index}`,
      title: result.title,
      level: result.level,
      pageIndex: line.pageIndex,
      pageNumber: line.pageIndex + 1,
      fontSize: Number(line.fontSize) || 0,
      score: result.score,
      confidence: result.confidence,
      reasons: result.reasons,
      penalties: result.penalties,
      source: 'body',
      order: index,
    })
  })

  return { candidates: candidates.slice(0, MAX_TOC_ITEMS), diagnostics, bodyFontSize }
}

function buildVisualRows(page) {
  const lines = Array.isArray(page?.lines) ? page.lines : []
  const rows = []

  lines.forEach((line, lineIndex) => {
    const y = Number(line.y)
    if (!Number.isFinite(y)) {
      rows.push({ lines: [{ ...line, lineIndex }], y: null })
      return
    }
    const tolerance = Math.max(2, (Number(line.fontSize) || 10) * 0.25)
    let row = rows.find((candidate) => Number.isFinite(candidate.y) && Math.abs(candidate.y - y) <= tolerance)
    if (!row) {
      row = { lines: [], y }
      rows.push(row)
    }
    row.lines.push({ ...line, lineIndex })
  })

  return rows
    .sort((first, second) => {
      if (!Number.isFinite(first.y) || !Number.isFinite(second.y)) return 0
      return second.y - first.y
    })
    .map((row) => ({
      ...row,
      lines: row.lines.sort((first, second) => (Number(first.x) || 0) - (Number(second.x) || 0)),
    }))
}

function parseTocRow(row) {
  const segments = row.lines.map((line) => normalizeText(line.text)).filter(Boolean)
  if (!segments.length) return null
  const x = Math.min(...row.lines.map((line) => Number(line.x) || 0))

  if (segments.length >= 2) {
    const page = parsePrintedPage(segments[segments.length - 1])
    const title = cleanTocTitle(segments.slice(0, -1).join(' '))
    if (page && title && !CONTENTS_HEADING_PATTERN.test(title)) {
      return { title, printedPage: page, x }
    }
  }

  const text = segments.join(' ')
  const dottedMatch = text.match(TOC_DOTTED_LINE_PATTERN)
  if (dottedMatch) {
    return {
      title: cleanTocTitle(dottedMatch[1]),
      printedPage: parsePrintedPage(dottedMatch[2]),
      x,
    }
  }

  const trailingMatch = text.match(TOC_TRAILING_PAGE_PATTERN)
  if (!trailingMatch) return null
  const title = cleanTocTitle(trailingMatch[1])
  const printedPage = parsePrintedPage(trailingMatch[2])
  const explicitLevel = getExplicitHeadingLevel(title)
  if (!printedPage || !title || (!explicitLevel && !isTitleLike(title))) return null
  return { title, printedPage, x }
}

function findBodyTitleMatch(pages, title, excludedPageIndexes = new Set()) {
  const key = normalizeHeadingKey(title)
  if (!key) return null
  let best = null

  getAllPageLines(pages).forEach((line) => {
    if (excludedPageIndexes.has(line.pageIndex)) return
    const lineKey = normalizeHeadingKey(line.text)
    if (!lineKey) return
    const exact = lineKey === key
    const contains = lineKey.includes(key) || key.includes(lineKey)
    if (!exact && (!contains || Math.min(lineKey.length, key.length) / Math.max(lineKey.length, key.length) < 0.72)) {
      return
    }
    const explicit = getExplicitHeadingLevel(line.text) ? 1 : 0
    const similarity = exact ? 1 : Math.min(lineKey.length, key.length) / Math.max(lineKey.length, key.length)
    const score = similarity * 10 + explicit * 2 + (line.bold ? 1 : 0)
    if (!best || score > best.score || (score === best.score && line.pageIndex < best.pageIndex)) {
      best = { pageIndex: line.pageIndex, pageNumber: line.pageIndex + 1, score }
    }
  })

  return best
}

export function extractTocPageCandidates(pages, options = {}) {
  const safePages = Array.isArray(pages) ? pages : []
  const maxPage = Math.max(1, Number(options.totalPages) || safePages.length || 1)
  const frontPages = safePages.slice(0, Math.min(20, safePages.length))
  const parsedPages = frontPages.map((page) => {
    const entries = buildVisualRows(page)
      .map(parseTocRow)
      .filter((entry) => entry?.title && entry.printedPage && !isNoiseTitle(entry.title))
    return {
      pageIndex: Math.max(0, (Number(page.pageNumber) || 1) - 1),
      entries,
      hasContentsHeading: (page.lines || []).some((line) => CONTENTS_HEADING_PATTERN.test(cleanTocTitle(line.text))),
    }
  })
  const tocPages = parsedPages.filter((page) => (
    page.entries.length >= 3 || (page.hasContentsHeading && page.entries.length >= 2)
  ))
  const tocPageIndexes = new Set(tocPages.map((page) => page.pageIndex))
  const rawEntries = tocPages.flatMap((page) => page.entries.map((entry, index) => ({
    ...entry,
    tocPageIndex: page.pageIndex,
    order: page.pageIndex * 1000 + index,
  })))

  if (rawEntries.length < MIN_TOC_CANDIDATES) {
    return { detected: false, candidates: [], pageOffset: null, tocPageIndexes: [] }
  }

  const matches = rawEntries.map((entry) => ({
    ...entry,
    bodyMatch: findBodyTitleMatch(safePages, entry.title, tocPageIndexes),
  }))
  const baseIndent = Math.min(...matches.map((entry) => Number(entry.x) || 0))
  const offsets = matches
    .filter((entry) => entry.bodyMatch && !entry.printedPage.roman)
    .map((entry) => entry.bodyMatch.pageIndex - (entry.printedPage.number - 1))
  const pageOffset = offsets.length ? Math.round(median(offsets)) : null
  const candidates = matches
    .map((entry, index) => {
      const fallbackPageIndex = entry.printedPage.roman
        ? entry.printedPage.number - 1
        : entry.printedPage.number - 1 + (pageOffset || 0)
      const pageIndex = clamp(
        entry.bodyMatch?.pageIndex ?? fallbackPageIndex,
        0,
        maxPage - 1,
      )
      const level = getExplicitHeadingLevel(entry.title) ||
        ((Number(entry.x) || 0) > baseIndent + 18 ? 2 : 1)
      return {
        id: `toc-page-${pageIndex}-${index}`,
        title: entry.title,
        level,
        pageIndex,
        pageNumber: pageIndex + 1,
        printedPageLabel: entry.printedPage.label,
        score: entry.bodyMatch ? 14 : pageOffset !== null ? 11 : 8,
        confidence: entry.bodyMatch ? 0.96 : pageOffset !== null ? 0.86 : 0.68,
        reasons: entry.bodyMatch ? ['toc-page', 'body-title-match'] : ['toc-page', 'page-offset'],
        penalties: [],
        source: 'toc-page',
        order: entry.order,
      }
    })
    .filter((candidate) => candidate.pageIndex >= 0 && candidate.pageIndex < maxPage)

  const resolvedCount = matches.filter((entry) => entry.bodyMatch).length
  const detected = candidates.length >= MIN_TOC_CANDIDATES && (
    resolvedCount >= 2 || pageOffset !== null || tocPages.some((page) => page.hasContentsHeading)
  )
  return {
    detected,
    candidates: detected ? candidates : [],
    pageOffset,
    tocPageIndexes: Array.from(tocPageIndexes),
    resolvedCount,
  }
}

function flattenTocItems(items, inheritedLevel = 1, output = []) {
  ;(Array.isArray(items) ? items : []).forEach((item) => {
    if (!item || typeof item !== 'object') return
    const level = clamp(Math.floor(Number(item.level) || inheritedLevel), 1, 3)
    output.push({ ...item, level })
    const children = Array.isArray(item.children)
      ? item.children
      : Array.isArray(item.subsections)
        ? item.subsections
        : []
    flattenTocItems(children, clamp(level + 1, 1, 3), output)
  })
  return output
}

function normalizeFlatTocItem(item, index, maxPage) {
  const title = cleanTocTitle(item?.title)
  const legacyPage = Number(item?.pageStart ?? item?.pageNumber ?? item?.page)
  const rawPageIndex = Number(item?.pageIndex)
  const pageIndex = Number.isFinite(rawPageIndex)
    ? Math.floor(rawPageIndex)
    : Math.max(0, Math.floor(legacyPage || 1) - 1)
  if (!title || pageIndex < 0 || pageIndex >= maxPage || isNoiseTitle(title) || isSentenceLike(title)) return null

  return {
    id: String(item?.id || `toc-${pageIndex}-${index}`),
    title,
    level: clamp(Math.floor(Number(item?.level) || getExplicitHeadingLevel(title) || 1), 1, 3),
    pageNumber: pageIndex + 1,
    pageIndex,
    confidence: clamp(Number(item?.confidence) || 0.75, 0, 1),
    score: Number(item?.score) || 0,
    source: String(item?.source || ''),
    order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index,
  }
}

function cleanFlatCandidates(items, maxPage) {
  const normalized = flattenTocItems(items)
    .map((item, index) => normalizeFlatTocItem(item, index, maxPage))
    .filter(Boolean)
  const sourcePriority = { native: 5, body: 4, 'toc-page': 3, ai: 2 }
  const byTitle = new Map()

  normalized.forEach((item) => {
    const key = normalizeHeadingKey(item.title)
    const existing = byTitle.get(key)
    const quality = (sourcePriority[item.source] || 0) * 100 + item.score * 5 + item.confidence
    const existingQuality = existing
      ? (sourcePriority[existing.source] || 0) * 100 + existing.score * 5 + existing.confidence
      : -1
    if (!existing || quality > existingQuality) byTitle.set(key, item)
  })

  return Array.from(byTitle.values())
    .sort((first, second) => (
      first.pageIndex - second.pageIndex ||
      first.order - second.order ||
      first.level - second.level
    ))
    .filter((item, index, array) => {
      if (!index) return true
      const previous = array[index - 1]
      return normalizeHeadingKey(previous.title) !== normalizeHeadingKey(item.title) ||
        previous.pageIndex !== item.pageIndex
    })
    .slice(0, MAX_TOC_ITEMS)
}

export function buildTocTree(flatItems, maxPage = Number.POSITIVE_INFINITY) {
  const safeMaxPage = Number.isFinite(maxPage) ? Math.max(1, Math.floor(maxPage)) : Number.MAX_SAFE_INTEGER
  const cleaned = cleanFlatCandidates(flatItems, safeMaxPage)
  const roots = []
  const stack = []

  cleaned.forEach((item, index) => {
    let level = item.level
    if (!roots.length && level > 1) level = 1
    if (level === 2 && !stack[1]) level = stack[0] ? 2 : 1
    if (level === 3 && !stack[1]) level = stack[0] ? 2 : 1

    const normalized = {
      id: String(item.id || `toc-${item.pageIndex}-${level}-${index}`),
      title: item.title,
      level,
      pageNumber: item.pageIndex + 1,
      pageIndex: item.pageIndex,
      confidence: item.confidence,
      children: [],
    }

    if (level === 1) {
      roots.push(normalized)
      stack[0] = normalized
      stack.length = 1
    } else if (level === 2) {
      stack[0].children.push(normalized)
      stack[1] = normalized
      stack.length = 2
    } else {
      stack[1].children.push(normalized)
      stack[2] = normalized
      stack.length = 3
    }
  })

  return roots
}

export function normalizeTocItems(items, maxPage = Number.POSITIVE_INFINITY) {
  return buildTocTree(items, maxPage)
}

export function analyzeTocFromPages(pages, maxPage = Number.POSITIVE_INFINITY) {
  const safePages = Array.isArray(pages) ? pages : []
  const safeMaxPage = Number.isFinite(maxPage) ? maxPage : safePages.length || 1
  const document = classifyDocumentType(safePages, safeMaxPage)
  const tocPage = extractTocPageCandidates(safePages, { totalPages: safeMaxPage })
  const body = extractHeadingCandidates(safePages, {
    documentType: document.documentType,
    totalPages: safeMaxPage,
  })
  const candidates = tocPage.detected ? tocPage.candidates : body.candidates
  const items = candidates.length >= MIN_TOC_CANDIDATES
    ? buildTocTree(candidates, safeMaxPage)
    : []

  return {
    documentType: document.documentType,
    documentTypeConfidence: document.confidence,
    documentSignals: document.signals,
    source: tocPage.detected ? 'toc-page' : 'body',
    candidates,
    items,
    pageOffset: tocPage.pageOffset,
    tocPageDetected: tocPage.detected,
    tocPageIndexes: tocPage.tocPageIndexes,
    diagnostics: body.diagnostics,
  }
}

export function buildHeuristicTocFromPages(pages, maxPage = Number.POSITIVE_INFINITY) {
  return analyzeTocFromPages(pages, maxPage).items
}

function parseJsonCandidates(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return []
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  const objectStart = withoutFence.indexOf('{')
  const objectEnd = withoutFence.lastIndexOf('}')
  const arrayStart = withoutFence.indexOf('[')
  const arrayEnd = withoutFence.lastIndexOf(']')
  return [
    withoutFence,
    objectStart >= 0 && objectEnd > objectStart ? withoutFence.slice(objectStart, objectEnd + 1) : '',
    arrayStart >= 0 && arrayEnd > arrayStart ? withoutFence.slice(arrayStart, arrayEnd + 1) : '',
  ].filter(Boolean)
}

export function parseAiTocResponse(rawText, maxPage = Number.POSITIVE_INFINITY, allowedCandidates = []) {
  const allowed = cleanFlatCandidates(
    allowedCandidates,
    Number.isFinite(maxPage) ? maxPage : Number.MAX_SAFE_INTEGER,
  )
  const allowedByTitle = new Map(allowed.map((item) => [normalizeHeadingKey(item.title), item]))

  for (const candidate of parseJsonCandidates(rawText)) {
    try {
      const parsed = JSON.parse(candidate)
      const rawItems = Array.isArray(parsed) ? parsed : parsed?.items || parsed?.toc
      const aiItems = flattenTocItems(rawItems)
      const constrained = allowed.length
        ? aiItems.map((item) => {
            const source = allowedByTitle.get(normalizeHeadingKey(item.title))
            if (!source) return null
            return {
              ...source,
              level: clamp(Math.floor(Number(item.level) || source.level), 1, 3),
              confidence: clamp(Number(item.confidence) || source.confidence, 0, 1),
              source: 'ai',
            }
          }).filter(Boolean)
        : aiItems
      const normalized = buildTocTree(constrained, maxPage)
      if (flattenTocItems(normalized).length >= MIN_TOC_CANDIDATES) return normalized
    } catch {
      // Try the next JSON-shaped substring.
    }
  }

  return []
}
