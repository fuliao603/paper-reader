import { useCallback, useEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { createWorker } from 'tesseract.js'
import {
  Archive,
  BookOpen,
  CircleOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FilePlus2,
  FolderPlus,
  Highlighter,
  History,
  LibraryBig,
  ListTree,
  Maximize2,
  Minimize2,
  Minus,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  ScanLine,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import './App.css'
import appIconUrl from '../build/icon.png'
import IconButton from './components/ui/IconButton'
import {
  HISTORY_LIMIT,
  HISTORY_TYPE_LABELS,
  formatHistoryTime,
  getHistoryPreview,
  normalizeBrowsingHistory,
  normalizeBrowsingRecord,
  normalizeHistoryItem,
  normalizeHistoryList,
  restoreHistoryItem as restoreHistoryResult,
} from './utils/history'
import {
  buildBatchPdfMarkdown,
  buildPdfMarkdown,
  getPdfDisplayName,
  makeSafeMarkdownFileName,
} from './utils/markdownExport'
import {
  buildBatchPdfReportHtml,
  buildPdfReportHtml,
  makeSafePdfReportFileName,
} from './utils/pdfReportExport'
import {
  analyzeTocFromPages,
  cleanTocTitle,
  normalizeTocItems,
  parseAiTocResponse,
} from './utils/toc'

function TreeChevron({ expanded, onToggle }) {
  return (
    <IconButton
      className="tree-chevron"
      label={expanded ? '折叠文件夹' : '展开文件夹'}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onToggle()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDragStart={(event) => event.preventDefault()}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </IconButton>
  )
}

const TEXT_ENTRY_SELECTOR = [
  'textarea',
  '[contenteditable="true"]',
  'input:not([type="button"]):not([type="checkbox"]):not([type="color"]):not([type="file"]):not([type="hidden"]):not([type="image"]):not([type="radio"]):not([type="range"]):not([type="reset"]):not([type="submit"])',
].join(', ')

function getTextEntryElement(target) {
  if (!target || typeof target.closest !== 'function') return null

  const element = target.closest(TEXT_ENTRY_SELECTOR)
  if (!element || element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true') {
    return null
  }

  return element
}

const UI = {
  choosePdf: '\u9009\u62e9 PDF',
  emptyPdf: '\u8bf7\u4e0a\u4f20 PDF',
  errorPrefix: '\u7ffb\u8bd1\u5931\u8d25\uff1a',
  exitFullscreen: '\u9000\u51fa\u5168\u5c4f',
  fullscreen: '\u5168\u5c4f\u9605\u8bfb',
  loadingPdf: 'PDF \u52a0\u8f7d\u4e2d...',
  loadingTranslation: '\u7ffb\u8bd1\u4e2d...',
  nextPage: '\u4e0b\u4e00\u9875',
  noText: '\u8bf7\u9009\u4e2d\u6587\u5b57',
  page: '\u7b2c',
  pageControl: 'PDF \u7ffb\u9875\u63a7\u5236',
  pageError: 'PDF \u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u786e\u8ba4\u6587\u4ef6\u6ca1\u6709\u635f\u574f\u3002',
  pageSuffix: '\u9875',
  previousPage: '\u4e0a\u4e00\u9875',
  settings: '\u8bbe\u7f6e',
  settingsCancel: '\u53d6\u6d88',
  settingsDesktopOnly: '\u8bbe\u7f6e\u529f\u80fd\u4ec5\u5728\u684c\u9762\u7248\u53ef\u7528',
  settingsKeyConfigured: '\u5df2\u914d\u7f6e API Key',
  settingsKeyEmpty: '\u672a\u914d\u7f6e API Key',
  settingsLoadError: '\u8bfb\u53d6\u8bbe\u7f6e\u5931\u8d25',
  settingsSave: '\u4fdd\u5b58\u8bbe\u7f6e',
  settingsSaved: '\u8bbe\u7f6e\u5df2\u4fdd\u5b58',
  settingsSaveError: '\u4fdd\u5b58\u8bbe\u7f6e\u5931\u8d25',
  totalPages: '\u5171',
  translateError: '\u8bf7\u786e\u8ba4\u540e\u7aef\u670d\u52a1\u5df2\u542f\u52a8',
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'
const TESSERACT_ASSET_BASE = `${import.meta.env.BASE_URL || '/'}tesseract`
const MULTIMODAL_OCR_DEBUG = import.meta.env.VITE_MULTIMODAL_OCR_DEBUG === 'true'
const MULTIMODAL_VISUAL_OCR_ENABLED = import.meta.env.VITE_ENABLE_MULTIMODAL_VISUAL_OCR === 'true'
const INLINE_FORMULA_OCR_MODEL = 'onnx-community/TexTeller-ONNX'
let inlineFormulaOcrPipelinePromise = null
const DEFAULT_TRANSLATION_PROMPT =
  '你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'

async function getInlineFormulaOcrPipeline() {
  if (!inlineFormulaOcrPipelinePromise) {
    inlineFormulaOcrPipelinePromise = import('@huggingface/transformers')
      .then(({ env, pipeline }) => {
        env.allowLocalModels = true
        env.allowRemoteModels = true
        env.useBrowserCache = true

        return pipeline('image-to-text', INLINE_FORMULA_OCR_MODEL, {
          device: 'wasm',
          dtype: 'q8',
          progress_callback: (progress) => {
            if (progress?.status === 'progress') {
              console.debug('行内公式 OCR 模型加载', {
                file: progress.file,
                progress: progress.progress,
              })
            }
          },
        })
      })
      .catch((error) => {
        inlineFormulaOcrPipelinePromise = null
        throw error
      })
  }

  return inlineFormulaOcrPipelinePromise
}

const DEFAULT_CONTENT_EXPORT_OPTIONS = {
  exportHistories: true,
  exportNotes: true,
  exportHighlights: false,
  exportAnnotations: false,
  exportBookmarks: false,
}
const CONTENT_EXPORT_OPTION_ITEMS = [
  { key: 'exportNotes', label: '笔记' },
  { key: 'exportHistories', label: '翻译历史' },
  { key: 'exportHighlights', label: '高亮' },
  { key: 'exportAnnotations', label: '批注' },
  { key: 'exportBookmarks', label: '书签' },
]
const SEARCH_SCOPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'document', label: '文献' },
  { value: 'translation', label: '翻译' },
  { value: 'annotation', label: '批注' },
  { value: 'note', label: '笔记' },
]
const SEARCH_RESULT_TYPE_LABELS = {
  document: '文献',
  translation: '翻译',
  annotation: '批注',
  note: '笔记',
}
const SEARCH_RESULT_LIMIT = 10
const SEARCH_DEBOUNCE_MS = 180
const TOC_RECOGNITION_VERSION = 3
const TOC_OCR_MAX_PAGES = 60
const TOC_OCR_RENDER_SCALE = 1.15
const TOC_DEBUG = import.meta.env.VITE_TOC_DEBUG === 'true'
const SEARCH_TEXT_FIELDS = [
  'title',
  'fileName',
  'selectedText',
  'highlightText',
  'ocrText',
  'sourceText',
  'originalText',
  'translation',
  'translatedText',
  'targetText',
  'result',
  'noteText',
  'text',
  'content',
  'comment',
]
const EXPORT_DETAIL_PREVIEW_LIMIT = 120
const EXPORT_DETAIL_TEXT_FIELDS = [
  'selectedText',
  'highlightText',
  'ocrText',
  'sourceText',
  'originalText',
  'text',
  'source',
  'original',
]
const EXPORT_DETAIL_NOTE_FIELDS = ['noteText', 'note', 'content', 'comment', 'memo', 'remark']
const EXPORT_DETAIL_TRANSLATION_FIELDS = ['translation', 'translatedText', 'targetText', 'result', 'translated', 'target']
const MIN_ZOOM = 50
const MAX_ZOOM = 300
const ZOOM_STEP = 10
const MIN_RIGHT_PANEL_WIDTH = 280
const MAX_RIGHT_PANEL_WIDTH = 700
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    supportsMultimodal: true,
  },
  'openai-compatible': {
    label: 'OpenAI / GPT',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    supportsMultimodal: true,
  },
  'anthropic-compatible': {
    label: 'Anthropic / Claude',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
    supportsMultimodal: true,
  },
  glm: {
    label: '智谱 AI / GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: '',
    supportsMultimodal: true,
  },
  gemini: {
    label: 'Google / Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
    supportsMultimodal: true,
  },
  qwen: {
    label: '阿里云百炼 / Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: '',
    supportsMultimodal: true,
  },
  kimi: {
    label: '月之暗面 / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: '',
    supportsMultimodal: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    supportsMultimodal: true,
  },
  siliconflow: {
    label: '硅基流动 / SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
    supportsMultimodal: true,
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    model: '',
    supportsMultimodal: true,
  },
}
const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: PROVIDERS.deepseek.model,
  modelSupportsMultimodal: null,
  temperatureMode: 'auto',
  temperature: 0.2,
  prompt: DEFAULT_TRANSLATION_PROMPT,
  enableMultimodalTranslation: false,
  rightPanelWidth: 420,
  exportDefaultDir: '',
}

function normalizeProviderKey(provider) {
  return Object.hasOwn(PROVIDERS, provider) ? provider : 'deepseek'
}

function settingsCanEnableMultimodal(settings) {
  const provider = normalizeProviderKey(settings?.provider)
  return PROVIDERS[provider].supportsMultimodal
}

function settingsSupportMultimodal(settings) {
  return settings?.enableMultimodalTranslation === true && settingsCanEnableMultimodal(settings)
}

function debugMultimodalOcr(label, payload) {
  if (!MULTIMODAL_OCR_DEBUG) return
  console.log(`[PaperReader multimodal OCR] ${label}`, payload)
}

function getFirstExportDetailText(source, fields) {
  if (!source || typeof source !== 'object') return ''

  for (const field of fields) {
    const value = source[field]
    if (value === null || value === undefined) continue

    const text = Array.isArray(value) ? value.join('\n') : String(value)
    if (text.trim()) return text.trim()
  }

  return ''
}

function getExportDetailTime(record = {}) {
  return Number(record.updatedAt || record.createdAt || record.timestamp) || 0
}

function sortExportDetailRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter(Boolean)
    .slice()
    .sort((firstRecord, secondRecord) => getExportDetailTime(secondRecord) - getExportDetailTime(firstRecord))
}

function normalizeDocumentNoteList(notes) {
  return sortExportDetailRecords(notes)
}

function normalizeDocumentBookmarkList(bookmarks) {
  return (Array.isArray(bookmarks) ? bookmarks : [])
    .filter(Boolean)
    .map((bookmark) => ({
      ...bookmark,
      id: String(bookmark.id || `${bookmark.pageNumber || 1}-${bookmark.title || Date.now()}`),
      pageNumber: Math.max(1, Math.floor(Number(bookmark.pageNumber) || 1)),
      title: String(bookmark.title || '').replace(/\s+/g, ' ').trim() || '未命名书签',
      createdAt: Number(bookmark.createdAt || Date.now()),
      updatedAt: Number(bookmark.updatedAt || bookmark.createdAt || Date.now()),
    }))
    .sort((firstBookmark, secondBookmark) =>
      firstBookmark.pageNumber - secondBookmark.pageNumber ||
      secondBookmark.updatedAt - firstBookmark.updatedAt,
    )
}

function normalizeDocumentAnnotationList(annotations) {
  return sortExportDetailRecords(annotations)
}

function getExportDocumentDisplayName(document = {}) {
  return getPdfDisplayName(document)
}

function getExportDetailPageText(record = {}) {
  const pageNumber = Number(record.pageNumber ?? record.page ?? record.pageNo ?? record.targetPage)
  if (Number.isFinite(pageNumber) && pageNumber > 0) return `第 ${Math.floor(pageNumber)} 页`

  const pageIndex = Number(record.pageIndex)
  if (Number.isFinite(pageIndex) && pageIndex >= 0) return `第 ${Math.floor(pageIndex) + 1} 页`

  return '页数未知'
}

function trimExportDetailPreview(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.length > EXPORT_DETAIL_PREVIEW_LIMIT ? `${text.slice(0, EXPORT_DETAIL_PREVIEW_LIMIT)}...` : text
}

function getExportHistoryDetailPreview(item = {}) {
  return trimExportDetailPreview(
    getFirstExportDetailText(item, EXPORT_DETAIL_TEXT_FIELDS) ||
      getFirstExportDetailText(item, EXPORT_DETAIL_TRANSLATION_FIELDS) ||
      getHistoryPreview(item),
    '历史记录',
  )
}

function getExportNoteDetailPreview(note = {}) {
  const title = getFirstExportDetailText(note, ['title'])
  const body = getFirstExportDetailText(note, EXPORT_DETAIL_NOTE_FIELDS) ||
    getFirstExportDetailText(note, EXPORT_DETAIL_TEXT_FIELDS) ||
    getFirstExportDetailText(note, EXPORT_DETAIL_TRANSLATION_FIELDS)

  return trimExportDetailPreview([title, body].filter(Boolean).join('：'), '笔记')
}

function getExportAnnotationDetailPreview(annotation = {}) {
  return trimExportDetailPreview(
    getFirstExportDetailText(annotation, EXPORT_DETAIL_TEXT_FIELDS),
    '高亮批注',
  )
}

function getExportBookmarkDetailPreview(bookmark = {}) {
  return trimExportDetailPreview(bookmark.title, '书签')
}

async function readExportDocumentDetail(electronAPI, documentId) {
  if (!documentId) return null
  if (
    !electronAPI?.getDocumentTranslationHistory ||
    !electronAPI?.getDocumentAnnotations ||
    !electronAPI?.getDocumentNotes
  ) {
    throw new Error('文献详情仅在桌面版可用')
  }

  const [histories, annotations, notes, bookmarks] = await Promise.all([
    electronAPI.getDocumentTranslationHistory(documentId),
    electronAPI.getDocumentAnnotations(documentId),
    electronAPI.getDocumentNotes(documentId),
    electronAPI.getDocumentBookmarks?.(documentId) || [],
  ])

  return {
    documentId,
    histories: sortExportDetailRecords(histories),
    annotations: normalizeDocumentAnnotationList(annotations).filter((item) => item?.type !== 'ocr-note-tag'),
    notes: normalizeDocumentNoteList(notes),
    bookmarks: normalizeDocumentBookmarkList(bookmarks),
  }
}

function normalizeSearchText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function buildSearchHitTextStream(spanRecords, includeSeparators) {
  const chars = []
  const map = []

  spanRecords.forEach((record, spanIndex) => {
    if (includeSeparators && chars.length > 0) {
      chars.push(' ')
      map.push(null)
    }

    record.chars.forEach((char, charIndex) => {
      chars.push(char)
      map.push({ spanIndex, charIndex })
    })
  })

  return { text: chars.join('').toLowerCase(), map }
}

function appendSearchHitRangesFromStream(stream, query, seenRanges, ranges) {
  let searchIndex = 0

  while (searchIndex < stream.text.length) {
    const matchStart = stream.text.indexOf(query, searchIndex)
    if (matchStart === -1) break

    const matchEnd = matchStart + query.length
    const segments = []
    let activeSegment = null

    for (let index = matchStart; index < matchEnd; index += 1) {
      const entry = stream.map[index]

      if (!entry) {
        if (activeSegment) {
          segments.push(activeSegment)
          activeSegment = null
        }
        continue
      }

      if (
        !activeSegment ||
        activeSegment.spanIndex !== entry.spanIndex ||
        activeSegment.end !== entry.charIndex
      ) {
        if (activeSegment) segments.push(activeSegment)
        activeSegment = {
          spanIndex: entry.spanIndex,
          start: entry.charIndex,
          end: entry.charIndex + 1,
        }
        continue
      }

      activeSegment.end = entry.charIndex + 1
    }

    if (activeSegment) segments.push(activeSegment)

    segments.forEach((segment) => {
      if (segment.end <= segment.start) return

      const key = `${segment.spanIndex}:${segment.start}:${segment.end}`
      if (seenRanges.has(key)) return

      seenRanges.add(key)
      ranges.push(segment)
    })

    searchIndex = matchStart + Math.max(1, query.length)
  }
}

function getSearchHitRanges(spanRecords, query) {
  const normalizedQuery = normalizeSearchText(query).toLowerCase()
  if (!spanRecords.length || !normalizedQuery) return []

  const seenRanges = new Set()
  const ranges = []

  appendSearchHitRangesFromStream(
    buildSearchHitTextStream(spanRecords, true),
    normalizedQuery,
    seenRanges,
    ranges,
  )
  appendSearchHitRangesFromStream(
    buildSearchHitTextStream(spanRecords, false),
    normalizedQuery,
    seenRanges,
    ranges,
  )

  return ranges.sort((firstRange, secondRange) => (
    firstRange.spanIndex - secondRange.spanIndex ||
    firstRange.start - secondRange.start ||
    firstRange.end - secondRange.end
  ))
}

function collectSearchTexts(source, fields = SEARCH_TEXT_FIELDS) {
  if (!source || typeof source !== 'object') return []

  return fields
    .map((field) => source[field])
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map(normalizeSearchText)
    .filter(Boolean)
}

function getSearchPageNumber(record = {}) {
  const pageNumber = Number(record.pageNumber ?? record.page ?? record.pageNo ?? record.targetPage)
  if (Number.isFinite(pageNumber) && pageNumber > 0) return Math.floor(pageNumber)

  const pageIndex = Number(record.pageIndex)
  if (Number.isFinite(pageIndex) && pageIndex >= 0) return Math.floor(pageIndex) + 1

  return null
}

function getSearchMatchSnippet(texts, query) {
  const normalizedQuery = normalizeSearchText(query).toLowerCase()
  if (!normalizedQuery) return ''

  const matchedText = texts.find((text) => text.toLowerCase().includes(normalizedQuery))
  if (!matchedText) return ''

  const matchIndex = matchedText.toLowerCase().indexOf(normalizedQuery)
  const start = Math.max(0, matchIndex - 42)
  const end = Math.min(matchedText.length, matchIndex + normalizedQuery.length + 78)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < matchedText.length ? '...' : ''

  return `${prefix}${matchedText.slice(start, end)}${suffix}`
}

function canSearchScope(scope, type) {
  return scope === 'all' || scope === type
}

function getPdfTextItemFontSize(item = {}) {
  const transformHeight = Math.abs(Number(item.transform?.[3]) || 0)
  return Math.max(Number(item.height) || 0, transformHeight)
}

function buildPdfPageStructure(textContent, pageNumber, pageMetrics = {}) {
  const rawItems = (Array.isArray(textContent?.items) ? textContent.items : [])
    .map((item) => {
      const text = String(item?.str || '').replace(/\s+/g, ' ').trim()
      if (!text) return null
      const style = textContent?.styles?.[item.fontName] || {}
      const fontName = [item.fontName, style.fontFamily].filter(Boolean).join(' ')
      const fontSize = getPdfTextItemFontSize(item)

      return {
        text,
        x: Number(item.transform?.[4]) || 0,
        y: Number(item.transform?.[5]) || 0,
        width: Math.max(Number(item.width) || 0, text.length * Math.max(fontSize, 1) * 0.38),
        fontSize,
        bold: /bold|black|heavy|semibold|demi/i.test(fontName),
        hasEOL: item.hasEOL === true,
      }
    })
    .filter(Boolean)
  const lineGroups = []

  rawItems
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .forEach((item) => {
      const tolerance = Math.max(1.5, item.fontSize * 0.24)
      let line = lineGroups.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance)

      if (!line) {
        line = { y: item.y, items: [] }
        lineGroups.push(line)
      }

      line.items.push(item)
    })

  const lines = lineGroups
    .sort((a, b) => b.y - a.y)
    .flatMap((line) => {
      const items = line.items.sort((a, b) => a.x - b.x)
      const segments = []
      let currentSegment = []
      let lastRight = null

      items.forEach((item) => {
        const gap = lastRight === null ? 0 : item.x - lastRight
        const splitGap = Math.max(28, item.fontSize * 3.2)

        if (currentSegment.length && gap > splitGap) {
          segments.push(currentSegment)
          currentSegment = []
        }

        currentSegment.push(item)
        lastRight = Math.max(lastRight || 0, item.x + item.width)
      })

      if (currentSegment.length) segments.push(currentSegment)

      return segments.map((segment) => {
        const left = Math.min(...segment.map((item) => item.x))
        const right = Math.max(...segment.map((item) => item.x + item.width))
        return {
          text: segment.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400),
          x: left,
          y: line.y,
          width: Math.max(0, right - left),
          right,
          fontSize: Math.max(...segment.map((item) => item.fontSize)),
          bold: segment.some((item) => item.bold),
        }
      })
    })
    .filter((line) => line.text)

  lines.forEach((line, index) => {
    const previous = lines[index - 1]
    const next = lines[index + 1]
    line.spaceBefore = previous && Number.isFinite(previous.y) && Number.isFinite(line.y)
      ? Math.max(0, previous.y - line.y - previous.fontSize)
      : 0
    line.spaceAfter = next && Number.isFinite(next.y) && Number.isFinite(line.y)
      ? Math.max(0, line.y - next.y - line.fontSize)
      : 0
  })

  return {
    pageNumber,
    pageWidth: Number(pageMetrics.width) || 0,
    pageHeight: Number(pageMetrics.height) || 0,
    text: rawItems.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim(),
    lines,
  }
}

async function resolvePdfOutlinePage(pdfDocument, destination) {
  try {
    const resolvedDestination = typeof destination === 'string'
      ? await pdfDocument.getDestination(destination)
      : destination
    const pageReference = Array.isArray(resolvedDestination) ? resolvedDestination[0] : null
    if (!pageReference) return null
    if (Number.isInteger(pageReference)) return pageReference + 1
    return (await pdfDocument.getPageIndex(pageReference)) + 1
  } catch {
    return null
  }
}

async function buildNativePdfToc(pdfDocument, outline, level = 1) {
  const items = []

  for (let index = 0; index < (Array.isArray(outline) ? outline.length : 0); index += 1) {
    const outlineItem = outline[index]
    const pageNumber = await resolvePdfOutlinePage(pdfDocument, outlineItem.dest)
    const children = await buildNativePdfToc(pdfDocument, outlineItem.items, level + 1)

    if (pageNumber) {
      items.push({
        id: `native-toc-${pageNumber}-${level}-${index}`,
        title: cleanTocTitle(outlineItem.title),
        pageNumber,
        pageIndex: pageNumber - 1,
        level: Math.min(3, level),
        confidence: 1,
        children,
      })
    } else {
      items.push(...children)
    }
  }

  return items
}

function getTocFingerprint(documentRecord = {}) {
  return {
    filePath: String(documentRecord.filePath || ''),
    fileSize: Math.max(0, Number(documentRecord.fileSize) || 0),
    modifiedTime: Math.max(0, Number(documentRecord.modifiedTime) || 0),
    fileHash: String(documentRecord.fileHash || ''),
  }
}

function isTocFingerprintCurrent(savedFingerprint, documentRecord) {
  if (!savedFingerprint || typeof savedFingerprint !== 'object') return false
  const current = getTocFingerprint(documentRecord)
  const comparableFields = ['fileHash', 'modifiedTime', 'fileSize', 'filePath']
    .filter((field) => current[field] && savedFingerprint[field])
  if (!comparableFields.length) return false
  return comparableFields.every((field) => String(savedFingerprint[field]) === String(current[field]))
}

function logTocDebug(stage, payload) {
  if (!TOC_DEBUG) return
  console.groupCollapsed(`[TOC] ${stage}`)
  console.log(payload)
  console.groupEnd()
}

const APP_ICON_SRC = appIconUrl
const MODULE_NAV_ITEMS = [
  {
    id: 'reader',
    label: '阅读',
    icon: BookOpen,
  },
  {
    id: 'library',
    label: '文献库',
    icon: LibraryBig,
  },
  {
    id: 'importExport',
    label: '历史笔记管理',
    icon: Archive,
  },
  {
    id: 'settings',
    label: '设置',
    icon: Settings,
  },
]
const NOTE_TYPE_LABELS = {
  'page-note': '页面笔记',
  'text-selection-note': '划词笔记',
  'ocr-text-note': '文本 OCR 笔记',
  'ocr-diagram-note': '图解 OCR 笔记',
  'ocr-compare-note': '对照 OCR 笔记',
  'annotation-note': '批注笔记',
}
const HIGHLIGHT_COLORS = [
  { name: 'yellow', label: '黄', color: '#FFFF00' },
  { name: 'cyan', label: '蓝', color: '#00FFFF' },
  { name: 'green', label: '绿', color: '#00FF00' },
  { name: 'magenta', label: '紫', color: '#FF00FF' },
  { name: 'pink', label: '粉', color: '#FF1493' },
]
const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].color
const HIGHLIGHT_OPACITY = 0.4
const HIGHLIGHT_COLOR_OPACITY = {
  [HIGHLIGHT_COLORS[0].color]: 0.5,
  [HIGHLIGHT_COLORS[1].color]: 0.45,
}
const HIGHLIGHT_HOVER_OPACITY = 0.55

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

function SettingsModelCombobox({
  value,
  models,
  status,
  error,
  placeholder,
  onChange,
}) {
  const rootRef = useRef(null)
  const [isOpen, setIsOpen] = useState(false)
  const listboxId = 'settings-model-listbox'

  useEffect(() => {
    if (!isOpen) return undefined

    function handlePointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  const emptyMessage = status === 'loading'
    ? '正在获取模型…'
    : status === 'error'
      ? error || '获取模型列表失败，可手动输入'
      : status === 'success'
        ? '未获取到可用模型，可手动输入'
        : '填写 API Key 后获取模型'

  return (
    <div className="settings-model-combobox" ref={rootRef}>
      <input
        id="settings-model-input"
        type="text"
        value={value}
        role="combobox"
        aria-label="模型名称"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={isOpen}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIsOpen(true)
          }
        }}
        placeholder={placeholder}
      />
      <button
        type="button"
        className="settings-model-toggle"
        aria-label={isOpen ? '收起模型列表' : '展开模型列表'}
        aria-controls={listboxId}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {isOpen ? (
        <div className="settings-model-options" id={listboxId} role="listbox">
          {models.length ? (
            models.map((model) => (
              <button
                type="button"
                className={model.id === value ? 'settings-model-option selected' : 'settings-model-option'}
                key={model.id}
                role="option"
                aria-selected={model.id === value}
                title={model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
                onClick={() => {
                  onChange(model.id)
                  setIsOpen(false)
                }}
              >
                <span>{model.id}</span>
                {model.name && model.name !== model.id ? <small>{model.name}</small> : null}
              </button>
            ))
          ) : (
            <p className={status === 'error' ? 'settings-model-empty error' : 'settings-model-empty'}>
              {emptyMessage}
            </p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function App() {
  const appRef = useRef(null)
  const readerLayoutRef = useRef(null)
  const pdfViewerRef = useRef(null)
  const lastWheelTimeRef = useRef(0)
  const pendingWheelScrollRef = useRef(null)
  const lastTranslatedTextRef = useRef('')
  const requestIdRef = useRef(0)
  const isSelectingRef = useRef(false)
  const selectionFrameRef = useRef(null)
  const selectionInteractionVersionRef = useRef(0)
  // Text entry pauses PDF selection without clearing the user's annotation color.
  const annotationInteractionSuspendedRef = useRef(false)
  const ocrStartPointRef = useRef(null)
  const panelResizeStartRef = useRef(null)
  const settingsFormRef = useRef(DEFAULT_SETTINGS)
  const modelListRequestIdRef = useRef(0)
  const rightPanelWidthRef = useRef(DEFAULT_SETTINGS.rightPanelWidth)
  const readingRecordSaveTimerRef = useRef(null)
  const pendingReadingRestoreRef = useRef(null)
  const pdfTabsRef = useRef([])
  const activeTabIdRef = useRef('')
  const pdfSessionSaveTimerRef = useRef(null)
  const pdfSessionRestoreRef = useRef(false)
  const pdfSessionSkipNextSaveRef = useRef(true)
  const pdfTabScrollSaveTimerRef = useRef(null)
  const pageWidthRef = useRef(700)
  const lastViewerSizeRef = useRef({ width: 0, height: 0 })
  const sidebarResizeSettlingRef = useRef(false)
  const sidebarResizeTimerRef = useRef(null)
  const syncPageWidthRef = useRef(null)
  const pendingSessionRestoreRef = useRef(null)
  const fallbackFileInputRef = useRef(null)
  const recentButtonRef = useRef(null)
  const recentPopoverRef = useRef(null)
  const annotationButtonRef = useRef(null)
  const annotationToolbarRef = useRef(null)
  const noteDialogRef = useRef(null)
  const noteTitleInputRef = useRef(null)
  const noteTextareaRef = useRef(null)
  const pdfHighlightWritePromptRef = useRef(null)
  const bookmarkTitleInputRef = useRef(null)
  const libraryFolderNameInputRef = useRef(null)
  const retainedRightPanelActionsRef = useRef(null)
  const searchDialogInputRef = useRef(null)
  const batchExportNameRef = useRef('')
  const pdfTextSearchCacheRef = useRef({ key: '', pages: [] })
  const librarySearchCacheRef = useRef({ key: '', data: null })
  const libraryDocumentTextCacheRef = useRef(new Map())
  const tocGenerationKeyRef = useRef('')
  const tocGenerationRequestRef = useRef(0)
  const generateTableOfContentsRef = useRef(null)
  const prepareSelectionTranslationRef = useRef(null)

  const [pdfUrl, setPdfUrl] = useState('')
  const [currentDocument, setCurrentDocument] = useState(null)
  const [pdfTabs, setPdfTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState('')
  const [draggingTabId, setDraggingTabId] = useState('')
  const [dragOverTabId, setDragOverTabId] = useState('')
  const [pdfSessionStatus, setPdfSessionStatus] = useState('')
  const [pendingSessionRestore, setPendingSessionRestore] = useState(null)
  const [browsingHistory, setBrowsingHistory] = useState([])
  const [isRecentOpen, setIsRecentOpen] = useState(false)
  const [recentStatus, setRecentStatus] = useState('')
  const [libraryFolders, setLibraryFolders] = useState([])
  const [libraryDocuments, setLibraryDocuments] = useState([])
  const [libraryLiteratures, setLibraryLiteratures] = useState([])
  const [recycledLibraryDocuments, setRecycledLibraryDocuments] = useState([])
  const [selectedLibraryFolderId, setSelectedLibraryFolderId] = useState('all')
  const [librarySearch, setLibrarySearch] = useState('')
  const [librarySearchMode, setLibrarySearchMode] = useState('filename')
  const [librarySort, setLibrarySort] = useState('recent')
  const [selectedLibraryDocumentIds, setSelectedLibraryDocumentIds] = useState([])
  const [libraryStatus, setLibraryStatus] = useState('')
  const [libraryContextMenu, setLibraryContextMenu] = useState(null)
  const [libraryFolderContextMenu, setLibraryFolderContextMenu] = useState(null)
  const [libraryMoveDialog, setLibraryMoveDialog] = useState(null)
  const [libraryMoveRootExpanded, setLibraryMoveRootExpanded] = useState(true)
  const [libraryMoveExpandedIds, setLibraryMoveExpandedIds] = useState(() => new Set())
  const [libraryFolderMoveDialog, setLibraryFolderMoveDialog] = useState(null)
  const [libraryFolderMoveRootExpanded, setLibraryFolderMoveRootExpanded] = useState(true)
  const [libraryFolderMoveExpandedIds, setLibraryFolderMoveExpandedIds] = useState(() => new Set())
  const [draggedLibraryFolderId, setDraggedLibraryFolderId] = useState('')
  const [libraryFolderDropTarget, setLibraryFolderDropTarget] = useState(null)
  const [libraryFolderDialogOpen, setLibraryFolderDialogOpen] = useState(false)
  const [libraryFolderParentId, setLibraryFolderParentId] = useState(null)
  const [libraryFolderEditingId, setLibraryFolderEditingId] = useState('')
  const [libraryFolderNameDraft, setLibraryFolderNameDraft] = useState('')
  const [libraryFolderNameError, setLibraryFolderNameError] = useState('')
  const [libraryDeleteDialog, setLibraryDeleteDialog] = useState(null)
  const [permanentDeleteDialogIds, setPermanentDeleteDialogIds] = useState([])
  const [historyLibraryNodeId, setHistoryLibraryNodeId] = useState('all')
  const [historyIncludeDescendants, setHistoryIncludeDescendants] = useState(true)
  const [historySelectedRecycleIds, setHistorySelectedRecycleIds] = useState([])
  const [pageNumber, setPageNumber] = useState(1)
  const [numPages, setNumPages] = useState(null)
  const [selectedText, setSelectedText] = useState('')
  const [selectionCapture, setSelectionCapture] = useState(null)
  const [highlightRects, setHighlightRects] = useState([])
  const [translation, setTranslation] = useState('')
  const [translationStatus, setTranslationStatus] = useState('idle')
  const [isOcrMode, setIsOcrMode] = useState(false)
  const [isOcrMenuOpen, setIsOcrMenuOpen] = useState(false)
  const [ocrModeType, setOcrModeType] = useState('sidebar')
  const [isOcrDragging, setIsOcrDragging] = useState(false)
  const [ocrRect, setOcrRect] = useState(null)
  const [ocrResult, setOcrResult] = useState(null)
  const [rightPanelResult, setRightPanelResult] = useState(null)
  const [editableOcrText, setEditableOcrText] = useState('')
  const [ocrRetranslateStatus, setOcrRetranslateStatus] = useState('idle')
  const [ocrRetranslateError, setOcrRetranslateError] = useState('')
  const [translationHistory, setTranslationHistory] = useState([])
  const [readerSearchInput, setReaderSearchInput] = useState('')
  const [searchDialog, setSearchDialog] = useState({ open: false, source: 'reader', query: '', scope: 'all' })
  const [searchResults, setSearchResults] = useState([])
  const [searchStatus, setSearchStatus] = useState('')
  const [libraryGlobalSearchData, setLibraryGlobalSearchData] = useState(null)
  const [searchHitMarkers, setSearchHitMarkers] = useState([])
  const [searchHitMarkerRequest, setSearchHitMarkerRequest] = useState(null)
  const [rightPanelTab, setRightPanelTab] = useState('result')
  const [documentNotes, setDocumentNotes] = useState([])
  const [documentBookmarks, setDocumentBookmarks] = useState([])
  const [documentToc, setDocumentToc] = useState([])
  const [, setTocSource] = useState('unavailable')
  const [tocStatus, setTocStatus] = useState('')
  const [isTocGenerating, setIsTocGenerating] = useState(false)
  const [collapsedTocItemIds, setCollapsedTocItemIds] = useState([])
  const [tocDrawerOpen, setTocDrawerOpen] = useState(false)
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [noteDialog, setNoteDialog] = useState(null)
  const [noteDraft, setNoteDraft] = useState({ title: '', noteText: '' })
  const [bookmarkDialogOpen, setBookmarkDialogOpen] = useState(false)
  const [bookmarkTitleDraft, setBookmarkTitleDraft] = useState('')
  const [notesStatus, setNotesStatus] = useState('')
  const [bookmarksStatus, setBookmarksStatus] = useState('')
  const [historyStatus, setHistoryStatus] = useState('')
  const [exportStatus, setExportStatus] = useState('')
  const [exportFailures, setExportFailures] = useState([])
  const [, setIsHistoryImportExportBusy] = useState(false)
  const [, setIsNotesImportExportBusy] = useState(false)
  const [exportableDocuments, setExportableDocuments] = useState([])
  const [selectedExportDocumentIds, setSelectedExportDocumentIds] = useState([])
  const [selectedExportDetailDocumentId, setSelectedExportDetailDocumentId] = useState('')
  const [exportDocumentDetail, setExportDocumentDetail] = useState(null)
  const [exportDocumentDetailStatus, setExportDocumentDetailStatus] = useState('')
  const [selectedFileExportDocumentIds, setSelectedFileExportDocumentIds] = useState([])
  const [fileExportScope, setFileExportScope] = useState('selected')
  const [fileExportFolderId, setFileExportFolderId] = useState('unfiled')
  const [exportFolderTreeRootExpanded, setExportFolderTreeRootExpanded] = useState(true)
  const [exportFolderTreeUnfiledExpanded, setExportFolderTreeUnfiledExpanded] = useState(true)
  const [exportFolderTreeRecycleExpanded, setExportFolderTreeRecycleExpanded] = useState(true)
  const [exportFolderTreeExpandedIds, setExportFolderTreeExpandedIds] = useState(() => new Set())
  const [fileExportFormat, setFileExportFormat] = useState('markdown')
  const [fileExportMethod, setFileExportMethod] = useState('merged')
  const [fileExportContents, setFileExportContents] = useState(DEFAULT_CONTENT_EXPORT_OPTIONS)
  const [markdownFormatOptions, setMarkdownFormatOptions] = useState({ includeOriginal: true, generateToc: false, groupByType: true })
  const [pdfFormatOptions, setPdfFormatOptions] = useState({ pageSize: 'A4', pageMargin: 'normal', showPageNumbers: true, includeOriginal: true, groupByType: true })
  const [isFileExporting, setIsFileExporting] = useState(false)
  const [exportDefaultDir, setExportDefaultDir] = useState('')
  const [isAnnotationToolbarOpen, setIsAnnotationToolbarOpen] = useState(false)
  const [annotationColor, setAnnotationColor] = useState(null)
  const [pdfHighlightWriteMode, setPdfHighlightWriteMode] = useState('ask')
  const [pdfHighlightWritePromptOpen, setPdfHighlightWritePromptOpen] = useState(false)
  const [documentAnnotations, setDocumentAnnotations] = useState([])
  const [previewHighlight, setPreviewHighlight] = useState(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState('')
  const [highlightContextMenu, setHighlightContextMenu] = useState(null)
  const [annotationStatus, setAnnotationStatus] = useState('')
  const [isHistoryBatchSelecting, setIsHistoryBatchSelecting] = useState(false)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([])
  const [isNotesBatchSelecting, setIsNotesBatchSelecting] = useState(false)
  const [selectedNoteIds, setSelectedNoteIds] = useState([])
  const [isBookmarksBatchSelecting, setIsBookmarksBatchSelecting] = useState(false)
  const [selectedBookmarkIds, setSelectedBookmarkIds] = useState([])
  const [hideOcrNoteTags, setHideOcrNoteTags] = useState(false)
  const [diagramResult, setDiagramResult] = useState(null)
  const [diagramZoom, setDiagramZoom] = useState(1)
  const [isDiagramModalFullscreen, setIsDiagramModalFullscreen] = useState(false)
  const [compareResult, setCompareResult] = useState(null)
  const [compareOriginalZoom, setCompareOriginalZoom] = useState(1)
  const [compareTranslatedZoom, setCompareTranslatedZoom] = useState(1)
  const [isCompareModalFullscreen, setIsCompareModalFullscreen] = useState(false)
  const [imagePreview, setImagePreview] = useState(null)
  const [imagePreviewZoom, setImagePreviewZoom] = useState(1)
  const [isImagePreviewFullscreen, setIsImagePreviewFullscreen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [pageWidth, setPageWidth] = useState(700)
  const [pageRatio, setPageRatio] = useState(0.72)
  const [zoomPercent, setZoomPercent] = useState(100)
  const [zoomInput, setZoomInput] = useState('100')
  const [pageJumpInput, setPageJumpInput] = useState('1')
  const [isPageJumpFocused, setIsPageJumpFocused] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [settingsForm, setSettingsForm] = useState(DEFAULT_SETTINGS)
  const [settingsStatus, setSettingsStatus] = useState('')
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [availableModels, setAvailableModels] = useState([])
  const [modelListStatus, setModelListStatus] = useState('idle')
  const [modelListError, setModelListError] = useState('')
  const [glossary, setGlossary] = useState([])
  const [glossaryStatus, setGlossaryStatus] = useState('未导入术语库')
  const [isGlossaryVisible, setIsGlossaryVisible] = useState(false)
  const [settingsTab, setSettingsTab] = useState('model')
  const [importExportTab, setImportExportTab] = useState('libraryRecords')
  const [activeModule, setActiveModule] = useState('reader')
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_SETTINGS.rightPanelWidth)
  const [rightPanelVisible, setRightPanelVisible] = useState(true)
  const [isResizingPanel, setIsResizingPanel] = useState(false)

  function clearTranslation() {
    requestIdRef.current += 1
    setSelectedText('')
    setSelectionCapture(null)
    setHighlightRects([])
    setTranslation('')
    setTranslationStatus('idle')
    lastTranslatedTextRef.current = ''
  }

  const clearOcrSelection = useCallback(() => {
    ocrStartPointRef.current = null
    setIsOcrDragging(false)
    setOcrRect(null)
  }, [])

  const clearOcrResult = useCallback(() => {
    clearOcrSelection()
    setOcrResult(null)
    setDiagramResult(null)
    setDiagramZoom(1)
    setIsDiagramModalFullscreen(false)
    setCompareResult(null)
    setCompareOriginalZoom(1)
    setCompareTranslatedZoom(1)
    setIsCompareModalFullscreen(false)
    setImagePreview(null)
    setImagePreviewZoom(1)
    setIsImagePreviewFullscreen(false)
  }, [clearOcrSelection])

  const releasePdfTextSelection = useCallback(() => {
    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }

    window.getSelection()?.removeAllRanges()
    isSelectingRef.current = false
    setHighlightRects([])
    setPreviewHighlight(null)
  }, [])

  const suspendPdfTextSelection = useCallback(() => {
    annotationInteractionSuspendedRef.current = true
    selectionInteractionVersionRef.current += 1

    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }

    // Do not clear the native selection while a text field is processing its
    // pointer sequence. On Windows, doing so during pointerdown/mouseup can
    // leave Chromium's caret visible without activating the IME text session.
    isSelectingRef.current = false
  }, [])

  const cancelTransientPointerInteractions = useCallback(() => {
    releasePdfTextSelection()
    ocrStartPointRef.current = null
    panelResizeStartRef.current = null
    document.body.classList.remove('resizing-panel')

    setIsOcrDragging(false)
    setOcrRect(null)
    setIsResizingPanel(false)
    setDraggingTabId('')
    setDragOverTabId('')
    setDraggedLibraryFolderId('')
    setLibraryFolderDropTarget(null)
  }, [releasePdfTextSelection])

  function clearNoteDialogBlockers() {
    selectionInteractionVersionRef.current += 1
    cancelTransientPointerInteractions()
    requestIdRef.current += 1

    setSelectedText('')
    setSelectionCapture(null)
    setHighlightRects([])
    setPreviewHighlight(null)
    setActiveAnnotationId('')
    setHighlightContextMenu(null)
    setIsAnnotationToolbarOpen(false)
    setAnnotationStatus('')
    setIsOcrMode(false)
    setIsOcrMenuOpen(false)
    setLibraryContextMenu(null)
    setLibraryMoveDialog(null)
    setIsRecentOpen(false)
    setImagePreview(null)
    setImagePreviewZoom(1)
    setIsImagePreviewFullscreen(false)
    setDiagramResult(null)
    setDiagramZoom(1)
    setIsDiagramModalFullscreen(false)
    setCompareResult(null)
    setCompareOriginalZoom(1)
    setCompareTranslatedZoom(1)
    setIsCompareModalFullscreen(false)
  }

  function clearOcrCaptureUi() {
    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }

    window.getSelection()?.removeAllRanges()
    isSelectingRef.current = false
    setSelectedText('')
    setSelectionCapture(null)
    setHighlightRects([])
    setPreviewHighlight(null)
    setHighlightContextMenu(null)
    setIsAnnotationToolbarOpen(false)
    setActiveAnnotationId('')
    setAnnotationStatus('')
    setIsOcrMenuOpen(false)
  }

  function clearRightPanelResult() {
    clearTranslation()
    clearOcrResult()
    setEditableOcrText('')
    setOcrRetranslateStatus('idle')
    setOcrRetranslateError('')
    setRightPanelResult(null)
  }

  function resetCurrentPdfState() {
    clearRightPanelResult()
    setPdfUrl('')
    setCurrentDocument(null)
    setSearchHitMarkers([])
    setSearchHitMarkerRequest(null)
    setActiveTabId('')
    setPageNumber(1)
    setNumPages(null)
    setPageJumpInput('1')
    setIsPageJumpFocused(false)
    setZoomPercent(100)
    setZoomInput('100')
    setPageRatio(0.72)
    setPageWidth(700)
    setTranslationHistory([])
    setDocumentNotes([])
    setDocumentBookmarks([])
    setDocumentToc([])
    setTocSource('unavailable')
    setTocStatus('')
    setIsTocGenerating(false)
    setCollapsedTocItemIds([])
    setTocDrawerOpen(false)
    tocGenerationKeyRef.current = ''
    tocGenerationRequestRef.current += 1
    setSelectedNoteId('')
    setSelectedBookmarkIds([])
    setIsBookmarksBatchSelecting(false)
    setBookmarkDialogOpen(false)
    setBookmarkTitleDraft('')
    setBookmarksStatus('')
    setNoteDialog(null)
    setNotesStatus('')
    setIsOcrMode(false)
    setIsOcrMenuOpen(false)
    setOcrModeType('sidebar')
    setRightPanelTab('result')
    setIsAnnotationToolbarOpen(false)
    setDocumentAnnotations([])
    setPreviewHighlight(null)
    setActiveAnnotationId('')
    setAnnotationColor(null)
    setPdfHighlightWriteMode('ask')
    setHighlightContextMenu(null)
    setAnnotationStatus('')
    setNoteDialog(null)
  }

  // Keep the toolbar-level close command available even though the top button is hidden.
  // eslint-disable-next-line no-unused-vars
  function closeCurrentPdf() {
    if (activeTabId) {
      closePdfTab(activeTabId)
      return
    }

    void saveCurrentReadingRecord()
    resetCurrentPdfState()
  }

  const persistHistory = useCallback(async (nextHistory, document = currentDocument) => {
    if (!document?.documentId || !window.electronAPI?.saveDocumentTranslationHistory) return nextHistory

    try {
      return await window.electronAPI.saveDocumentTranslationHistory(document.documentId, {
        filePath: document.filePath,
        fileName: document.fileName,
        lastOpenedAt: Date.now(),
        items: nextHistory,
      })
    } catch (error) {
      console.error('Failed to save translation history', error)
      return nextHistory
    }
  }, [currentDocument])

  const addHistoryItem = useCallback((result) => {
    if (!currentDocument?.documentId) return

    const item = normalizeHistoryItem({
      ...result,
      documentId: currentDocument.documentId,
      filePath: currentDocument.filePath,
      fileName: currentDocument.fileName,
    }, pageNumber)

    if (!item) return

    setTranslationHistory((currentHistory) => {
      const nextHistory = normalizeHistoryList([
        item,
        ...currentHistory.filter((historyItem) => historyItem.id !== item.id),
      ]).slice(0, HISTORY_LIMIT)

      void persistHistory(nextHistory, currentDocument)
      return nextHistory
    })
  }, [currentDocument, pageNumber, persistHistory])

  const setSuccessfulRightPanelResult = useCallback((result) => {
    setRightPanelResult(result)
    setRightPanelTab('result')
    void addHistoryItem(result)
  }, [addHistoryItem])

  function getPdfTabId(documentId, filePath, fileName) {
    return String(documentId || filePath || fileName || Date.now())
  }

  function updateActivePdfTabSnapshot(overrides = {}) {
    if (!activeTabId) return

    const scrollTop = Number(overrides.scrollTop ?? pdfViewerRef.current?.scrollTop ?? 0)

    setPdfTabs((currentTabs) => currentTabs.map((tab) => {
      if (tab.id !== activeTabId) return tab

      return {
        ...tab,
        pdfUrl,
        document: currentDocument || tab.document,
        filePath: currentDocument?.filePath || tab.filePath,
        fileName: currentDocument?.fileName || tab.fileName,
        documentId: currentDocument?.documentId || tab.documentId,
        currentPage: pageNumber,
        totalPages: numPages,
        scale: zoomPercent,
        scrollTop,
        rightPanelResult,
        ocrResult,
        rightPanelTab,
        rightPanelVisible,
        updatedAt: Date.now(),
        ...overrides,
      }
    }))
  }

  function getSessionTabsSnapshot(overrides = {}) {
    const currentActiveTabId = overrides.activeTabId ?? activeTabIdRef.current
    const currentTabs = overrides.tabs || pdfTabsRef.current
    const scrollTop = Number(overrides.scrollTop ?? pdfViewerRef.current?.scrollTop ?? 0)

    return currentTabs.map((tab) => {
      if (tab.id !== currentActiveTabId) return tab

      return {
        ...tab,
        pdfUrl,
        document: currentDocument || tab.document,
        filePath: currentDocument?.filePath || tab.filePath,
        fileName: currentDocument?.fileName || tab.fileName,
        documentId: currentDocument?.documentId || tab.documentId,
        currentPage: pageNumber,
        totalPages: numPages,
        scale: zoomPercent,
        scrollTop,
        rightPanelResult,
        ocrResult,
        rightPanelTab,
        rightPanelVisible,
        updatedAt: Date.now(),
      }
    })
  }

  function serializePdfSession(tabs = getSessionTabsSnapshot(), nextActiveTabId = activeTabIdRef.current) {
    return {
      activeTabId: nextActiveTabId,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        documentId: tab.documentId,
        filePath: tab.filePath,
        fileName: tab.fileName,
        fileSize: tab.document?.fileSize || tab.fileSize || 0,
        currentPage: tab.currentPage || 1,
        totalPages: tab.totalPages || null,
        scale: tab.scale || 100,
        scrollTop: Number(tab.scrollTop) || 0,
        rightPanelResult: tab.rightPanelResult || null,
        ocrResult: tab.ocrResult || null,
        rightPanelTab: tab.rightPanelTab || 'result',
        rightPanelVisible: tab.rightPanelVisible !== false,
        openedAt: tab.openedAt || Date.now(),
        updatedAt: tab.updatedAt || Date.now(),
      })),
      updatedAt: Date.now(),
    }
  }

  async function savePdfSessionNow(tabs = getSessionTabsSnapshot(), nextActiveTabId = activeTabIdRef.current) {
    if (!window.electronAPI?.savePdfSession) return

    try {
      await window.electronAPI.savePdfSession(serializePdfSession(tabs, nextActiveTabId))
    } catch (error) {
      console.error('Failed to save PDF session', error)
    }
  }

  function schedulePdfSessionSave(tabs = getSessionTabsSnapshot(), nextActiveTabId = activeTabIdRef.current) {
    if (pdfSessionRestoreRef.current || !window.electronAPI?.savePdfSession) return

    if (pdfSessionSaveTimerRef.current) {
      clearTimeout(pdfSessionSaveTimerRef.current)
    }

    const session = serializePdfSession(tabs, nextActiveTabId)
    pdfSessionSaveTimerRef.current = setTimeout(() => {
      pdfSessionSaveTimerRef.current = null
      void window.electronAPI.savePdfSession(session).catch((error) => {
        console.error('Failed to save PDF session', error)
      })
    }, 300)
  }

  function reorderPdfTabs(sourceTabId, targetTabId) {
    if (!sourceTabId || !targetTabId || sourceTabId === targetTabId) return

    setPdfTabs((currentTabs) => {
      const sourceIndex = currentTabs.findIndex((tab) => tab.id === sourceTabId)
      const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId)

      if (sourceIndex < 0 || targetIndex < 0) return currentTabs

      const nextTabs = currentTabs.slice()
      const [movedTab] = nextTabs.splice(sourceIndex, 1)
      nextTabs.splice(targetIndex, 0, movedTab)
      schedulePdfSessionSave(nextTabs, activeTabIdRef.current)
      return nextTabs
    })
  }

  function clearTransientReadingState() {
    requestIdRef.current += 1
    window.getSelection()?.removeAllRanges()
    ocrStartPointRef.current = null
    setSelectedText('')
    setSelectionCapture(null)
    setHighlightRects([])
    setTranslation('')
    setTranslationStatus('idle')
    lastTranslatedTextRef.current = ''
    setIsOcrMode(false)
    setIsOcrMenuOpen(false)
    setIsOcrDragging(false)
    setOcrRect(null)
    setPreviewHighlight(null)
    setActiveAnnotationId('')
    setHighlightContextMenu(null)
    setNoteDialog(null)
    setNoteDraft({ title: '', noteText: '' })
    setCopyStatus('')
  }

  function restorePdfTab(tab) {
    if (!tab?.pdfUrl || !tab.document) return

    pendingReadingRestoreRef.current = null
    setSearchHitMarkers([])
    setSearchHitMarkerRequest(null)
    setActiveTabId(tab.id)
    setCurrentDocument(tab.document)
    setPdfUrl(tab.pdfUrl)
    setPageNumber(tab.currentPage || 1)
    setNumPages(tab.totalPages || null)
    setPageJumpInput(String(tab.currentPage || 1))
    setIsPageJumpFocused(false)
    setZoomPercent(tab.scale || 100)
    setZoomInput(String(tab.scale || 100))
    setRightPanelResult(tab.rightPanelResult || null)
    setOcrResult(tab.ocrResult || null)
    setRightPanelTab(tab.rightPanelTab || 'result')
    setRightPanelVisible(tab.rightPanelVisible !== false)
    setTranslationHistory([])
    setDocumentNotes([])
    setDocumentBookmarks([])
    setDocumentToc([])
    setTocSource('unavailable')
    setTocStatus('')
    setIsTocGenerating(false)
    setCollapsedTocItemIds([])
    setTocDrawerOpen(false)
    tocGenerationKeyRef.current = ''
    tocGenerationRequestRef.current += 1
    setDocumentAnnotations([])
    setSelectedNoteId('')
    setSelectedBookmarkIds([])
    setIsBookmarksBatchSelecting(false)
    setBookmarkDialogOpen(false)
    setBookmarkTitleDraft('')
    setBookmarksStatus('')
    clearTransientReadingState()

    requestAnimationFrame(() => {
      if (pdfViewerRef.current) {
        pdfViewerRef.current.scrollTop = Number(tab.scrollTop) || 0
      }
    })
  }

  function confirmSessionRestore() {
    const session = pendingSessionRestore
    const restoredTabs = Array.isArray(session?.tabs) ? session.tabs : []

    if (!restoredTabs.length) {
      setPendingSessionRestore(null)
      resetCurrentPdfState()
      void savePdfSessionNow([], '')
      return
    }

    const restoredActiveTab = restoredTabs.find((tab) => tab.id === session.activeTabId) || restoredTabs[0]

    setPdfTabs(restoredTabs)
    restorePdfTab(restoredActiveTab)
    setPendingSessionRestore(null)
    if (session.failedTabs?.length) {
      setPdfSessionStatus(`部分文献文件不存在，已跳过：${session.failedTabs.slice(0, 3).join('、')}`)
    } else {
      setPdfSessionStatus('')
    }
    void savePdfSessionNow(restoredTabs, restoredActiveTab.id)
  }

  function declineSessionRestore() {
    setPendingSessionRestore(null)
    resetCurrentPdfState()
    setPdfTabs([])
    setPdfSessionStatus('')
    void savePdfSessionNow([], '')
  }

  function activatePdfTab(tabId) {
    if (!tabId || tabId === activeTabId) return

    updateActivePdfTabSnapshot()
    void saveCurrentReadingRecord()

    const targetTab = pdfTabs.find((tab) => tab.id === tabId)
    if (targetTab) {
      restorePdfTab(targetTab)
      schedulePdfSessionSave(getSessionTabsSnapshot(), tabId)
    }
  }

  function closePdfTab(tabId) {
    const closingIndex = pdfTabs.findIndex((tab) => tab.id === tabId)
    if (closingIndex < 0) return

    if (tabId === activeTabId) {
      updateActivePdfTabSnapshot()
      void saveCurrentReadingRecord()
    }

    const closingTab = pdfTabs[closingIndex]
    const nextTabs = pdfTabs.filter((tab) => tab.id !== tabId)

    if (closingTab?.pdfUrl?.startsWith?.('blob:')) {
      URL.revokeObjectURL(closingTab.pdfUrl)
    }

    const nextActiveTab = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] || nextTabs[closingIndex - 1]
    const nextActiveTabId = tabId === activeTabId ? nextActiveTab?.id || '' : activeTabIdRef.current

    setPdfTabs(nextTabs)
    schedulePdfSessionSave(nextTabs, nextActiveTabId)

    if (tabId !== activeTabId) return

    if (nextActiveTab) {
      restorePdfTab(nextActiveTab)
      return
    }

    resetCurrentPdfState()
  }

  function renderPdfTabs() {
    return (
      <nav className={pdfTabs.length ? 'pdf-tabs-bar' : 'pdf-tabs-bar empty'} aria-label="PDF 标签页">
        {pdfTabs.length ? (
          <div className="pdf-tabs-scroll">
            {pdfTabs.map((tab) => (
              <div
                key={tab.id}
                className={[
                  'pdf-tab',
                  tab.id === activeTabId ? 'active' : '',
                  tab.id === draggingTabId ? 'dragging' : '',
                  tab.id === dragOverTabId && tab.id !== draggingTabId ? 'drag-over' : '',
                ].filter(Boolean).join(' ')}
                title={tab.fileName}
                draggable
                onDragStart={(event) => {
                  setDraggingTabId(tab.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', tab.id)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dragOverTabId !== tab.id) {
                    setDragOverTabId(tab.id)
                  }
                }}
                onDragLeave={() => {
                  setDragOverTabId((currentId) => (currentId === tab.id ? '' : currentId))
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const sourceTabId = event.dataTransfer.getData('text/plain') || draggingTabId
                  reorderPdfTabs(sourceTabId, tab.id)
                  setDraggingTabId('')
                  setDragOverTabId('')
                }}
                onDragEnd={() => {
                  setDraggingTabId('')
                  setDragOverTabId('')
                }}
              >
                <button
                  type="button"
                  className="pdf-tab-main"
                  onClick={() => activatePdfTab(tab.id)}
                >
                  <span>{tab.fileName}</span>
                </button>
                <button
                  type="button"
                  className="pdf-tab-close"
                  draggable={false}
                  aria-label={`关闭 ${tab.fileName}`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    closePdfTab(tab.id)
                  }}
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {pdfSessionStatus ? <p className="pdf-session-status">{pdfSessionStatus}</p> : null}
      </nav>
    )
  }

  useEffect(() => {
    if (rightPanelResult?.type === 'ocr-text') {
      setEditableOcrText(rightPanelResult.ocrText || '')
    } else {
      setEditableOcrText('')
    }

    setOcrRetranslateStatus('idle')
    setOcrRetranslateError('')
  }, [rightPanelResult])

  function restoreHistoryItem(item) {
    const result = restoreHistoryResult(item)

    if (!result) return

    clearTranslation()
    clearOcrResult()
    setRightPanelResult(result)
    setRightPanelTab('result')
  }

  function deleteHistoryItem(id) {
    setTranslationHistory((currentHistory) => {
      const nextHistory = currentHistory.filter((item) => item.id !== id)

      void persistHistory(nextHistory)
      return nextHistory
    })
  }

  function toggleHistorySelection(id) {
    setSelectedHistoryIds((currentIds) =>
      currentIds.includes(id) ? currentIds.filter((itemId) => itemId !== id) : [...currentIds, id],
    )
  }

  async function deleteSelectedHistoryItems() {
    if (!selectedHistoryIds.length) {
      setHistoryStatus('请先选择要删除的记录')
      return
    }
    if (!window.confirm(`确定删除选中的 ${selectedHistoryIds.length} 条翻译历史吗？`)) return

    const selectedIds = new Set(selectedHistoryIds)
    setTranslationHistory((currentHistory) => {
      const nextHistory = currentHistory.filter((item) => !selectedIds.has(item.id))
      void persistHistory(nextHistory)
      return nextHistory
    })
    setSelectedHistoryIds([])
    setIsHistoryBatchSelecting(false)
    setHistoryStatus('已删除所选翻译历史')
  }

  function normalizeNoteList(notes) {
    return normalizeDocumentNoteList(notes)
  }

  function normalizeBookmarkList(bookmarks) {
    return normalizeDocumentBookmarkList(bookmarks)
  }

  function openBookmarkDialog() {
    if (!currentDocument?.documentId) {
      setBookmarksStatus('请先打开 PDF')
      return
    }

    setBookmarkTitleDraft('')
    setBookmarkDialogOpen(true)
    setBookmarksStatus('')
  }

  function closeBookmarkDialog() {
    setBookmarkDialogOpen(false)
    setBookmarkTitleDraft('')
  }

  async function confirmAddBookmark() {
    if (!currentDocument?.documentId) {
      setBookmarksStatus('请先打开 PDF')
      return
    }

    const title = bookmarkTitleDraft.replace(/\s+/g, ' ').trim()
    if (!title) {
      setBookmarksStatus('请输入本页主题')
      return
    }

    const now = Date.now()
    const bookmark = {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      documentId: currentDocument.documentId,
      filePath: currentDocument.filePath,
      fileName: currentDocument.fileName,
      pageNumber,
      title,
      createdAt: now,
      updatedAt: now,
    }

    try {
      const nextBookmarks = window.electronAPI?.addDocumentBookmark
        ? await window.electronAPI.addDocumentBookmark(bookmark)
        : [bookmark, ...documentBookmarks.filter((item) => item.id !== bookmark.id)]
      setDocumentBookmarks(normalizeBookmarkList(nextBookmarks))
      closeBookmarkDialog()
      setRightPanelTab('bookmarks')
      setBookmarksStatus('')
    } catch (error) {
      setBookmarksStatus(error.message || '添加书签失败')
    }
  }

  function jumpToBookmark(bookmark) {
    const nextPage = Math.max(1, Math.min(Number(bookmark?.pageNumber) || 1, numPages || Number(bookmark?.pageNumber) || 1))
    setPageNumber(nextPage)
    setPageJumpInput(String(nextPage))
    setBookmarksStatus('')
  }

  function toggleBookmarkSelection(id) {
    setSelectedBookmarkIds((currentIds) =>
      currentIds.includes(id) ? currentIds.filter((itemId) => itemId !== id) : [...currentIds, id],
    )
  }

  async function deleteSelectedBookmarks() {
    if (!currentDocument?.documentId) {
      setBookmarksStatus('请先打开 PDF')
      return
    }
    if (!selectedBookmarkIds.length) {
      setBookmarksStatus('请先选择要删除的书签')
      return
    }
    if (!window.confirm(`确定删除选中的 ${selectedBookmarkIds.length} 条书签吗？`)) return

    try {
      let nextBookmarks = documentBookmarks
      for (const bookmarkId of selectedBookmarkIds) {
        nextBookmarks = window.electronAPI?.deleteDocumentBookmark
          ? await window.electronAPI.deleteDocumentBookmark(currentDocument.documentId, bookmarkId)
          : nextBookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
      }
      setDocumentBookmarks(normalizeBookmarkList(nextBookmarks))
      setSelectedBookmarkIds([])
      setIsBookmarksBatchSelecting(false)
      setBookmarksStatus('已删除所选书签')
    } catch (error) {
      setBookmarksStatus(error.message || '删除所选书签失败')
    }
  }

  async function clearCurrentDocumentBookmarks() {
    if (!currentDocument?.documentId) {
      setBookmarksStatus('请先打开 PDF')
      return
    }
    if (!documentBookmarks.length) {
      setBookmarksStatus('暂无可清空的书签')
      return
    }
    if (!window.confirm('确定清空当前文献的全部书签吗？')) return

    try {
      const nextBookmarks = window.electronAPI?.clearDocumentBookmarks
        ? await window.electronAPI.clearDocumentBookmarks(currentDocument.documentId)
        : []
      setDocumentBookmarks(normalizeBookmarkList(nextBookmarks))
      setSelectedBookmarkIds([])
      setIsBookmarksBatchSelecting(false)
      setBookmarksStatus('已清空当前文献书签')
    } catch (error) {
      setBookmarksStatus(error.message || '清空书签失败')
    }
  }

  async function persistCurrentDocumentToc(items, source, metadata = {}) {
    const normalizedItems = normalizeTocItems(items, numPages || Number.POSITIVE_INFINITY)
    const payload = {
      filePath: currentDocument?.filePath,
      fileName: currentDocument?.fileName,
      fingerprint: getTocFingerprint(currentDocument),
      source,
      version: TOC_RECOGNITION_VERSION,
      documentType: metadata.documentType || 'unknown',
      pageOffset: Number.isFinite(metadata.pageOffset) ? metadata.pageOffset : null,
      items: normalizedItems,
    }

    if (currentDocument?.documentId && window.electronAPI?.saveDocumentTableOfContents) {
      const saved = await window.electronAPI.saveDocumentTableOfContents(currentDocument.documentId, payload)
      return {
        source: saved?.source || source,
        documentType: saved?.documentType || payload.documentType,
        pageOffset: Number.isFinite(saved?.pageOffset) ? saved.pageOffset : payload.pageOffset,
        items: normalizeTocItems(saved?.items || normalizedItems, numPages || Number.POSITIVE_INFINITY),
      }
    }

    return {
      source,
      documentType: payload.documentType,
      pageOffset: payload.pageOffset,
      items: normalizedItems,
    }
  }

  async function requestAiTocRecognition(candidates, documentType) {
    const payload = {
      documentType,
      candidates: candidates.map((candidate) => ({
        text: candidate.title,
        pageNumber: candidate.pageNumber,
        pageIndex: candidate.pageIndex,
        fontSize: candidate.fontSize,
        level: candidate.level,
        score: candidate.score,
        reasons: candidate.reasons,
        penalties: candidate.penalties,
      })),
    }
    const data = window.electronAPI?.recognizeTableOfContents
      ? await window.electronAPI.recognizeTableOfContents(payload)
      : await requestBackendJson('/ai/recognize-toc', payload)

    return parseAiTocResponse(
      data?.toc,
      numPages || Number.POSITIVE_INFINITY,
      candidates,
    )
  }

  function getTocOcrPageNumbers(totalPages) {
    if (totalPages <= TOC_OCR_MAX_PAGES) {
      return Array.from({ length: totalPages }, (_item, index) => index + 1)
    }

    const firstPages = Array.from({ length: 20 }, (_item, index) => index + 1)
    const remainingSlots = TOC_OCR_MAX_PAGES - firstPages.length
    const sampledPages = Array.from({ length: remainingSlots }, (_item, index) => (
      Math.round(21 + ((totalPages - 21) * index) / Math.max(remainingSlots - 1, 1))
    ))

    return Array.from(new Set([...firstPages, ...sampledPages])).sort((a, b) => a - b)
  }

  async function renderPdfPageForTocOcr(pdfPage) {
    const baseViewport = pdfPage.getViewport({ scale: TOC_OCR_RENDER_SCALE })
    const maxDimension = Math.max(baseViewport.width, baseViewport.height)
    const scale = maxDimension > 1600
      ? TOC_OCR_RENDER_SCALE * (1600 / maxDimension)
      : TOC_OCR_RENDER_SCALE
    const viewport = pdfPage.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('无法创建目录 OCR 画布')

    canvas.width = Math.max(1, Math.ceil(viewport.width))
    canvas.height = Math.max(1, Math.ceil(viewport.height))
    await pdfPage.render({ canvasContext: context, viewport }).promise
    return canvas.toDataURL('image/jpeg', 0.84)
  }

  async function extractScannedTocPages(pdfDocument, requestId) {
    let worker = null
    const pages = []
    const pageNumbers = getTocOcrPageNumbers(pdfDocument.numPages)

    try {
      worker = await createWorker('eng', 1, {
        workerPath: `${TESSERACT_ASSET_BASE}/worker.min.js`,
        corePath: `${TESSERACT_ASSET_BASE}/core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${TESSERACT_ASSET_BASE}/lang`,
        cacheMethod: 'none',
      })

      for (let index = 0; index < pageNumbers.length; index += 1) {
        if (requestId !== tocGenerationRequestRef.current) return []

        const currentPageNumber = pageNumbers[index]
        setTocStatus(`正在识别扫描页 ${index + 1} / ${pageNumbers.length}`)
        const pdfPage = await pdfDocument.getPage(currentPageNumber)
        const image = await renderPdfPageForTocOcr(pdfPage)
        const { data } = await worker.recognize(image, {}, { text: true })
        const text = cleanOcrText(data.text || '')

        if (text) {
          pages.push({
            pageNumber: currentPageNumber,
            text,
            lines: text
              .split(/\r?\n/)
              .map((line) => ({
                text: String(line || '').replace(/\s+/g, ' ').trim().slice(0, 400),
                fontSize: 0,
                bold: false,
                x: 0,
              }))
              .filter((line) => line.text),
          })
        }
      }
    } finally {
      if (worker) await worker.terminate()
    }

    return pages
  }

  async function generateTableOfContents(options = {}) {
    if (!pdfUrl || !currentDocument?.documentId) {
      setTocStatus('请先打开 PDF')
      return
    }

    const fingerprint = getTocFingerprint(currentDocument)
    const generationKey = [
      currentDocument.documentId,
      fingerprint.fileHash,
      fingerprint.modifiedTime,
      fingerprint.fileSize,
      fingerprint.filePath,
    ].join('|')
    if (!options.force && tocGenerationKeyRef.current === generationKey) return

    tocGenerationKeyRef.current = generationKey
    const requestId = tocGenerationRequestRef.current + 1
    tocGenerationRequestRef.current = requestId
    let pdfDocument = null
    let lastAnalysis = null
    setIsTocGenerating(true)
    setTocStatus('正在读取 PDF 目录')

    try {
      const saveAndApplyToc = async (items, source, metadata = {}, status = '') => {
        if (requestId !== tocGenerationRequestRef.current) return false
        const saved = await persistCurrentDocumentToc(items, source, metadata)
        if (requestId !== tocGenerationRequestRef.current) return false
        setDocumentToc(saved.items)
        setTocSource(saved.source)
        setCollapsedTocItemIds([])
        setTocStatus(status)
        logTocDebug('final toc', {
          source: saved.source,
          documentType: metadata.documentType || 'unknown',
          pageOffset: metadata.pageOffset ?? null,
          items: saved.items,
        })
        return true
      }

      const cleanCandidatesWithAi = async (analysis, source) => {
        if (analysis.candidates.length < 2 || !analysis.items.length) return false
        setTocStatus('正在使用 AI 整理目录')

        try {
          logTocDebug('before AI cleanup', {
            documentType: analysis.documentType,
            candidates: analysis.candidates,
          })
          const aiToc = await requestAiTocRecognition(
            analysis.candidates,
            analysis.documentType,
          )
          logTocDebug('after AI cleanup', aiToc)
          if (aiToc.length) {
            return saveAndApplyToc(aiToc, `${source}-ai`, analysis)
          }
        } catch (error) {
          logTocDebug('AI cleanup failed; using local fallback', {
            message: error?.message || String(error),
          })
        }

        return saveAndApplyToc(analysis.items, source, analysis)
      }

      const loadingTask = pdfjs.getDocument(pdfUrl)
      pdfDocument = await loadingTask.promise
      const maxPage = pdfDocument.numPages
      let nativeOutline = []
      try {
        nativeOutline = await pdfDocument.getOutline()
      } catch (error) {
        logTocDebug('native outline read failed', { message: error?.message || String(error) })
      }
      const nativeToc = normalizeTocItems(
        await buildNativePdfToc(pdfDocument, nativeOutline),
        maxPage,
      )

      logTocDebug('native outline', {
        found: nativeToc.length > 0,
        rootCount: nativeToc.length,
        items: nativeToc,
      })
      if (requestId !== tocGenerationRequestRef.current) return
      if (nativeToc.length) {
        await saveAndApplyToc(nativeToc, 'native', {
          documentType: 'unknown',
          pageOffset: null,
        })
        return
      }

      const textPages = []
      for (let pageIndex = 1; pageIndex <= maxPage; pageIndex += 1) {
        if (requestId !== tocGenerationRequestRef.current) return
        if (pageIndex === 1 || pageIndex % 10 === 0 || pageIndex === maxPage) {
          setTocStatus(`正在分析文本结构 ${pageIndex} / ${maxPage}`)
        }

        const page = await pdfDocument.getPage(pageIndex)
        const textContent = await page.getTextContent()
        const viewport = page.getViewport({ scale: 1 })
        textPages.push(buildPdfPageStructure(textContent, pageIndex, viewport))
      }

      const textCharacterCount = textPages.reduce((total, page) => total + page.text.length, 0)
      const looksLikeTextPdf = textCharacterCount >= Math.max(120, maxPage * 18)

      if (looksLikeTextPdf) {
        lastAnalysis = analyzeTocFromPages(textPages, maxPage)
        logTocDebug('local text analysis', {
          documentType: lastAnalysis.documentType,
          documentTypeConfidence: lastAnalysis.documentTypeConfidence,
          documentSignals: lastAnalysis.documentSignals,
          tocPageDetected: lastAnalysis.tocPageDetected,
          pageOffset: lastAnalysis.pageOffset,
          candidateCount: lastAnalysis.candidates.length,
          candidateDiagnostics: lastAnalysis.diagnostics,
          localItems: lastAnalysis.items,
        })
        if (await cleanCandidatesWithAi(lastAnalysis, lastAnalysis.source)) return
      } else {
        setTocStatus('未检测到文本层，正在 OCR 扫描页')
        const ocrPages = await extractScannedTocPages(pdfDocument, requestId)
        if (requestId !== tocGenerationRequestRef.current) return

        if (ocrPages.length) {
          lastAnalysis = analyzeTocFromPages(ocrPages, maxPage)
          logTocDebug('local OCR analysis', {
            documentType: lastAnalysis.documentType,
            tocPageDetected: lastAnalysis.tocPageDetected,
            pageOffset: lastAnalysis.pageOffset,
            candidateCount: lastAnalysis.candidates.length,
            candidateDiagnostics: lastAnalysis.diagnostics,
            localItems: lastAnalysis.items,
          })
          if (lastAnalysis.candidates.length >= 2 && lastAnalysis.items.length) {
            setTocStatus('正在使用 AI 整理 OCR 目录')
            try {
              const aiToc = await requestAiTocRecognition(
                lastAnalysis.candidates,
                lastAnalysis.documentType,
              )
              if (aiToc.length && await saveAndApplyToc(aiToc, 'ocr-ai', lastAnalysis)) {
                return
              }
            } catch (error) {
              logTocDebug('OCR AI cleanup failed; using local fallback', {
                message: error?.message || String(error),
              })
            }
            if (await saveAndApplyToc(
              lastAnalysis.items,
              'ocr',
              lastAnalysis,
              'AI 识别不可用，已使用 OCR 结构生成目录',
            )) return
          }
        }
      }

      await saveAndApplyToc([], 'unavailable', lastAnalysis || {
        documentType: 'unknown',
        pageOffset: null,
      }, '无法识别出目录')
    } catch (error) {
      tocGenerationKeyRef.current = ''
      logTocDebug('generation failed', {
        message: error?.message || String(error),
        stack: error?.stack,
      })
      setTocStatus(error.message || '目录生成失败')
    } finally {
      if (pdfDocument?.destroy) {
        try {
          await pdfDocument.destroy()
        } catch {
          // PDF.js worker cleanup should not interrupt the reader.
        }
      }
      if (requestId === tocGenerationRequestRef.current) {
        setIsTocGenerating(false)
      }
    }
  }

  generateTableOfContentsRef.current = generateTableOfContents

  function toggleTocPanel() {
    setActiveModule('reader')

    if (!pdfUrl) {
      setTocStatus('请先打开 PDF')
      setTocDrawerOpen((isOpen) => !isOpen)
      return
    }

    setTocDrawerOpen((isOpen) => {
      const nextOpen = !isOpen
      if (nextOpen && !documentToc.length && !isTocGenerating) {
        void generateTableOfContents()
      }
      return nextOpen
    })
  }

  function jumpToTocItem(item) {
    const requestedPage = Number.isFinite(Number(item?.pageIndex))
      ? Number(item.pageIndex) + 1
      : Number(item?.pageNumber ?? item?.pageStart) || 1
    const nextPage = clampNumber(requestedPage, 1, numPages || requestedPage)
    setPageNumber(nextPage)
    setPageJumpInput(String(nextPage))
    setTocStatus('')
  }

  function toggleTocItemCollapsed(itemId) {
    setCollapsedTocItemIds((currentIds) => (
      currentIds.includes(itemId)
        ? currentIds.filter((id) => id !== itemId)
        : [...currentIds, itemId]
    ))
  }

  function getResultNoteType(result) {
    if (result?.type === 'text-selection') return 'text-selection-note'
    if (result?.type === 'ocr-text') return 'ocr-text-note'
    if (result?.type === 'ocr-diagram') return 'ocr-diagram-note'
    if (result?.type === 'ocr-compare') return 'ocr-compare-note'
    return null
  }

  function createBaseNote(type, source = {}) {
    if (!currentDocument?.documentId) return null

    const now = Date.now()

    return {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      documentId: currentDocument.documentId,
      filePath: currentDocument.filePath,
      fileName: currentDocument.fileName,
      type,
      pageNumber: Number(source.pageNumber || pageNumber) || 1,
      title: source.title || NOTE_TYPE_LABELS[type] || '笔记',
      noteText: '',
      selectedText: source.selectedText,
      translation: source.translation,
      highlightId: source.highlightId,
      color: source.color,
      ocrText: source.type === 'ocr-text' ? editableOcrText.trim() || source.ocrText : source.ocrText,
      screenshotDataUrl: source.screenshotDataUrl,
      diagramResultImage: source.diagramResultImage,
      compareOriginalImage: source.compareOriginalImage,
      compareTranslatedImage: source.compareTranslatedImage,
      compareLayout: source.compareLayout,
      sourceHistoryId: source.id,
      createdAt: now,
      updatedAt: now,
    }
  }

  function openResultNoteDialog() {
    const type = getResultNoteType(rightPanelResult)

    if (!type) return

    const note = createBaseNote(type, rightPanelResult)

    if (!note) {
      setNotesStatus('请先打开 PDF')
      setRightPanelTab('notes')
      return
    }

    setIsNotesBatchSelecting(false)
    setSelectedNoteIds([])
    setSelectedNoteId('')
    setNotesStatus('')
    openNoteDialog('add', note)
  }

  function openAnnotationNoteDialog(annotation) {
    if (!annotation) {
      setAnnotationStatus('请先选择需要批注的文字')
      return
    }

    const note = createBaseNote('annotation-note', {
      pageNumber: annotation.pageNumber,
      title: '批注笔记',
      selectedText: annotation.selectedText,
      translation: annotation.translation,
      highlightId: annotation.id,
      color: annotation.color,
    })

    if (!note) {
      setNotesStatus('请先打开 PDF')
      setRightPanelTab('notes')
      return
    }

    setIsNotesBatchSelecting(false)
    setSelectedNoteIds([])
    setSelectedNoteId('')
    setNotesStatus('')
    openNoteDialog('add', note)
  }

  function openPageNoteDialog() {
    const note = createBaseNote('page-note', {
      pageNumber,
      title: `第 ${pageNumber} 页笔记`,
    })

    if (!note) {
      setNotesStatus('请先打开 PDF')
      setRightPanelTab('notes')
      return
    }

    setRightPanelTab('notes')
    setIsNotesBatchSelecting(false)
    setSelectedNoteIds([])
    setSelectedNoteId('')
    setNotesStatus('')
    openNoteDialog('add', note)
  }

  function openEditNoteDialog(note) {
    setIsNotesBatchSelecting(false)
    setSelectedNoteIds([])
    setNotesStatus('')
    openNoteDialog('edit', note)
  }

  function closeNoteDialog() {
    annotationInteractionSuspendedRef.current = false
    setNoteDialog(null)
    setNoteDraft({ title: '', noteText: '' })
  }

  function openNoteDialog(mode, note) {
    annotationInteractionSuspendedRef.current = true
    clearNoteDialogBlockers()

    const draft = {
      title: note.title || NOTE_TYPE_LABELS[note.type] || '笔记',
      noteText: mode === 'edit' ? note.noteText || '' : '',
    }

    setNoteDraft(draft)
    setNoteDialog({
      mode,
      note,
      draft,
      dialogId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    })
  }

  function isInteractiveElement(target) {
    if (!target || typeof target.closest !== 'function') return false

    return Boolean(target.closest(
      'textarea, input, button, select, option, [contenteditable="true"], .note-dialog-overlay, .settings-modal, .selection-panel, .recent-popover, .annotation-context-menu, .annotation-toolbar',
    ))
  }

  async function saveNoteDialog() {
    if (!noteDialog?.note) return

    const titleValue = noteTitleInputRef.current?.value ?? noteDialog.draft?.title ?? noteDraft.title
    const noteTextValue = noteTextareaRef.current?.value ?? noteDialog.draft?.noteText ?? noteDraft.noteText
    const title = titleValue.trim() || NOTE_TYPE_LABELS[noteDialog.note.type] || '笔记'
    const noteText = noteTextValue.trim()

    if (!noteText) {
      setNotesStatus('请输入笔记内容')
      return
    }

    const nextNote = {
      ...noteDialog.note,
      title,
      noteText,
      updatedAt: Date.now(),
    }

    try {
      const nextNotes = noteDialog.mode === 'edit' && window.electronAPI?.updateDocumentNote
        ? await window.electronAPI.updateDocumentNote(nextNote)
        : window.electronAPI?.addDocumentNote
          ? await window.electronAPI.addDocumentNote(nextNote)
          : [nextNote, ...documentNotes.filter((note) => note.id !== nextNote.id)]

      setDocumentNotes(normalizeNoteList(nextNotes))
      setSelectedNoteId(nextNote.id)
      setRightPanelTab('notes')
      setNotesStatus('')
      if (nextNote.type === 'annotation-note' && nextNote.highlightId) {
        const highlight = documentAnnotations.find((item) => item.id === nextNote.highlightId)
        if (highlight) {
          await saveAnnotation({ ...highlight, noteId: nextNote.id })
        }
      }
      if (['ocr-text-note', 'ocr-diagram-note', 'ocr-compare-note'].includes(nextNote.type)) {
        await createOcrNoteTag(nextNote)
      }
      closeNoteDialog()
    } catch (error) {
      setNotesStatus(error.message || '保存笔记失败')
    }
  }

  async function deleteNote(note) {
    if (!note?.id || !currentDocument?.documentId) return
    if (!window.confirm('确定要删除这条笔记吗？')) return

    try {
      const nextNotes = window.electronAPI?.deleteDocumentNote
        ? await window.electronAPI.deleteDocumentNote(currentDocument.documentId, note.id)
        : documentNotes.filter((item) => item.id !== note.id)

      setDocumentNotes(normalizeNoteList(nextNotes))
      if (selectedNoteId === note.id) {
        setSelectedNoteId('')
      }
      await refreshAnnotationsAfterNoteDelete(note.id)
    } catch (error) {
      setNotesStatus(error.message || '删除笔记失败')
    }
  }

  async function clearCurrentDocumentNotes() {
    if (!currentDocument?.documentId) {
      setNotesStatus('请先打开 PDF')
      return
    }
    if (!documentNotes.length) {
      setNotesStatus('暂无可清空的笔记')
      return
    }
    if (!window.confirm('确定清空当前文献的全部笔记吗？高亮标记会保留，OCR 小便签标签会删除。')) return

    try {
      const nextNotes = window.electronAPI?.clearDocumentNotes
        ? await window.electronAPI.clearDocumentNotes(currentDocument.documentId)
        : []
      setDocumentNotes(normalizeNoteList(nextNotes))
      setSelectedNoteId('')
      setSelectedNoteIds([])
      setIsNotesBatchSelecting(false)
      if (window.electronAPI?.getDocumentAnnotations) {
        const nextAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
        setDocumentAnnotations(normalizeAnnotationList(nextAnnotations))
      } else {
        setDocumentAnnotations((currentAnnotations) => normalizeAnnotationList(
          currentAnnotations
            .filter((item) => item.type !== 'ocr-note-tag')
            .map((item) => (item.type === 'text-highlight' && item.noteId ? { ...item, noteId: undefined } : item)),
        ))
      }
      setNotesStatus('已清空当前文献笔记')
    } catch (error) {
      setNotesStatus(error.message || '清空笔记失败')
    }
  }

  function toggleNoteSelection(id) {
    setSelectedNoteIds((currentIds) =>
      currentIds.includes(id) ? currentIds.filter((itemId) => itemId !== id) : [...currentIds, id],
    )
  }

  async function deleteSelectedNotes() {
    if (!selectedNoteIds.length) {
      setNotesStatus('请先选择要删除的笔记')
      return
    }
    if (!window.confirm(`确定删除选中的 ${selectedNoteIds.length} 条笔记吗？`)) return

    try {
      let nextNotes = documentNotes
      for (const noteId of selectedNoteIds) {
        nextNotes = window.electronAPI?.deleteDocumentNote
          ? await window.electronAPI.deleteDocumentNote(currentDocument.documentId, noteId)
          : nextNotes.filter((note) => note.id !== noteId)
      }
      setDocumentNotes(normalizeNoteList(nextNotes))
      if (selectedNoteIds.includes(selectedNoteId)) setSelectedNoteId('')
      setSelectedNoteIds([])
      setIsNotesBatchSelecting(false)
      if (window.electronAPI?.getDocumentAnnotations) {
        const nextAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
        setDocumentAnnotations(normalizeAnnotationList(nextAnnotations))
      }
      setNotesStatus('已删除所选笔记')
    } catch (error) {
      setNotesStatus(error.message || '删除所选笔记失败')
    }
  }

  async function refreshAnnotationsAfterNoteDelete(noteId) {
    if (!currentDocument?.documentId) return

    if (window.electronAPI?.getDocumentAnnotations) {
      const nextAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
      setDocumentAnnotations(Array.isArray(nextAnnotations) ? nextAnnotations : [])
      return
    }

    setDocumentAnnotations((currentAnnotations) => normalizeAnnotationList(
      currentAnnotations
        .filter((item) => !(item.type === 'ocr-note-tag' && item.noteId === noteId))
        .map((item) => (item.type === 'text-highlight' && item.noteId === noteId ? { ...item, noteId: undefined } : item)),
    ))
  }

  async function detachHighlightNote(highlight) {
    if (!highlight?.noteId) return

    const note = documentNotes.find((item) => item.id === highlight.noteId)
    if (!note) return

    const nextNote = {
      ...note,
      highlightId: undefined,
      updatedAt: Date.now(),
    }

    if (window.electronAPI?.updateDocumentNote) {
      const nextNotes = await window.electronAPI.updateDocumentNote(nextNote)
      setDocumentNotes(normalizeNoteList(nextNotes))
      return
    }

    setDocumentNotes((currentNotes) => normalizeNoteList(
      currentNotes.map((item) => (item.id === nextNote.id ? nextNote : item)),
    ))
  }

  function normalizeAnnotationList(annotations) {
    return normalizeDocumentAnnotationList(annotations)
  }

  async function saveAnnotation(annotation) {
    if (!annotation || !currentDocument?.documentId) return null

    const nextAnnotation = {
      ...annotation,
      documentId: currentDocument.documentId,
      filePath: currentDocument.filePath,
      fileName: currentDocument.fileName,
      updatedAt: Date.now(),
    }

    try {
      const nextAnnotations = window.electronAPI?.updateDocumentAnnotation
        ? await window.electronAPI.updateDocumentAnnotation(nextAnnotation)
        : documentAnnotations.map((item) => (item.id === nextAnnotation.id ? nextAnnotation : item))
      setDocumentAnnotations(normalizeAnnotationList(nextAnnotations))
      return nextAnnotation
    } catch (error) {
      setAnnotationStatus(error.message || '保存批注失败')
      return null
    }
  }

  async function addAnnotation(annotation) {
    if (!annotation || !currentDocument?.documentId) return null

    try {
      const nextAnnotations = window.electronAPI?.addDocumentAnnotation
        ? await window.electronAPI.addDocumentAnnotation(annotation)
        : [annotation, ...documentAnnotations]
      setDocumentAnnotations(normalizeAnnotationList(nextAnnotations))
      return annotation
    } catch (error) {
      setAnnotationStatus(error.message || '保存批注失败')
      return null
    }
  }

  function requestPdfHighlightWriteMode() {
    if (pdfHighlightWritePromptRef.current?.promise) {
      return pdfHighlightWritePromptRef.current.promise
    }

    let resolvePrompt
    const promise = new Promise((resolve) => {
      resolvePrompt = resolve
    })

    pdfHighlightWritePromptRef.current = { promise, resolve: resolvePrompt }
    setPdfHighlightWritePromptOpen(true)
    return promise
  }

  function resolvePdfHighlightWritePrompt(mode) {
    const pendingPrompt = pdfHighlightWritePromptRef.current
    if (!pendingPrompt) return

    pdfHighlightWritePromptRef.current = null
    setPdfHighlightWritePromptOpen(false)
    pendingPrompt.resolve(mode)
  }

  async function maybeEmbedHighlightInPdf(annotation) {
    if (!annotation || annotation.type !== 'text-highlight' || !window.electronAPI?.embedPdfHighlightAnnotation) return annotation
    if (!currentDocument?.filePath || currentDocument.filePath === currentDocument.fileName) return annotation

    let nextWriteMode = pdfHighlightWriteMode
    if (nextWriteMode === 'ask') {
      nextWriteMode = await requestPdfHighlightWriteMode()
      setPdfHighlightWriteMode(nextWriteMode)
    }

    if (nextWriteMode !== 'write') return annotation

    try {
      const embedded = await window.electronAPI.embedPdfHighlightAnnotation(annotation)
      const saved = await saveAnnotation(embedded)
      setAnnotationStatus('高亮已写入 PDF 本体')
      return saved || embedded
    } catch (error) {
      setAnnotationStatus(error.message || '写入 PDF 本体高亮失败')
      return annotation
    }
  }

  async function deleteHighlightAnnotation(highlightId) {
    if (!highlightId || !currentDocument?.documentId) return

    const highlight = documentAnnotations.find((item) => item.id === highlightId && item.type === 'text-highlight')
    if (!highlight) {
      setHighlightContextMenu(null)
      return
    }

    try {
      let pdfDeleteWarning = ''
      if ((highlight.embeddedInPdf || highlight.pdfAnnotationId) && window.electronAPI?.deletePdfHighlightAnnotation) {
        try {
          const pdfDeleteResult = await window.electronAPI.deletePdfHighlightAnnotation(highlight)
          if (pdfDeleteResult?.dataUrl) {
            setPdfUrl(pdfDeleteResult.dataUrl)
          }
        } catch (error) {
          console.error('Failed to delete embedded PDF highlight', error)
          pdfDeleteWarning = error.message || '未能同步删除 PDF 本体高亮'
        }
      }
      const nextAnnotations = window.electronAPI?.deleteDocumentAnnotation
        ? await window.electronAPI.deleteDocumentAnnotation(currentDocument.documentId, highlightId)
        : documentAnnotations.filter((item) => item.id !== highlightId)

      setDocumentAnnotations(normalizeAnnotationList(nextAnnotations))
      await detachHighlightNote(highlight)

      if (activeAnnotationId === highlightId) {
        setActiveAnnotationId('')
      }
      setHighlightContextMenu(null)
      setAnnotationStatus(pdfDeleteWarning ? `已删除应用内高亮；${pdfDeleteWarning}` : '')
    } catch (error) {
      setAnnotationStatus(error.message || '删除高亮失败')
    }
  }

  async function createOcrNoteTag(note) {
    if (!note?.id || !rightPanelResult?.ocrSelectionRect || !currentDocument?.documentId) return
    if (!['ocr-text-note', 'ocr-diagram-note', 'ocr-compare-note'].includes(note.type)) return

    const now = Date.now()
    const tag = {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      documentId: currentDocument.documentId,
      filePath: currentDocument.filePath,
      fileName: currentDocument.fileName,
      type: 'ocr-note-tag',
      pageNumber: note.pageNumber,
      rect: rightPanelResult.ocrSelectionRect.rect,
      pageWidth: rightPanelResult.ocrSelectionRect.pageWidth,
      pageHeight: rightPanelResult.ocrSelectionRect.pageHeight,
      noteId: note.id,
      mode: rightPanelResult.type,
      createdAt: now,
      updatedAt: now,
    }

    await addAnnotation(tag)
  }

  function jumpToNotePage(note) {
    if (!numPages || !note?.pageNumber) return

    const nextPage = clampNumber(Number(note.pageNumber) || 1, 1, numPages)
    setPageNumber(nextPage)
    setPageJumpInput(String(nextPage))
  }

  async function translateHighlightFromContextMenu() {
    const highlight = documentAnnotations.find(
      (item) => item.id === highlightContextMenu?.highlightId && item.type === 'text-highlight',
    )
    setHighlightContextMenu(null)

    if (!highlight?.selectedText) {
      setAnnotationStatus('请先选择需要批注的文字')
      return
    }

    setAnnotationStatus('翻译中...')

    try {
      const sourceText = cleanOcrSourceForTranslation(highlight.selectedText)
      const inlineFormulas = getInlineFormulaMetadataFromText(sourceText, 'highlight-text')
      const preserveOriginal =
        isScientificExpressionOnly(sourceText) ||
        isDenseFormulaOrSymbolText(sourceText)
      const nextTranslation = preserveOriginal
        ? sourceText
        : await translateOcrBlockText(sourceText, inlineFormulas)
      const nextResult = {
        type: 'text-selection',
        title: '批注翻译结果',
        selectedText: sourceText,
        translation: nextTranslation,
        pageNumber: highlight.pageNumber,
        timestamp: Date.now(),
      }
      setSuccessfulRightPanelResult(nextResult)
      setRightPanelVisible(true)
      setRightPanelTab('result')
      await saveAnnotation({ ...highlight, translation: nextTranslation })
      setAnnotationStatus('')
    } catch (error) {
      setAnnotationStatus(error.message || UI.translateError)
    }
  }

  function openNoteById(noteId) {
    if (!noteId) return false

    const note = documentNotes.find((item) => item.id === noteId)

    if (!note) return false

    setRightPanelVisible(true)
    setRightPanelTab('notes')
    setSelectedNoteId(note.id)
    return true
  }

  function handleAnnotationClick(annotation) {
    selectionInteractionVersionRef.current += 1
    releasePdfTextSelection()
    setIsAnnotationToolbarOpen(false)
    setActiveAnnotationId(annotation.id)

    if (annotation.noteId && openNoteById(annotation.noteId)) return

    if (annotation.type === 'text-highlight') {
      openAnnotationNoteDialog(annotation)
    }
  }

  function openHighlightContextMenu(event, annotation) {
    event.preventDefault()
    event.stopPropagation()

    if (annotation?.type !== 'text-highlight') return

    const menuWidth = 132
    const menuHeight = 80

    setActiveAnnotationId(annotation.id)
    setHighlightContextMenu({
      highlightId: annotation.id,
      x: Math.min(event.clientX + 2, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY + 2, window.innerHeight - menuHeight - 8),
    })
  }

  async function deleteBrowsingRecord(id) {
    if (!window.electronAPI?.deleteBrowsingRecord) {
      setBrowsingHistory((currentHistory) => currentHistory.filter((item) => item.id !== id))
      return
    }

    if (!window.confirm('确定要删除这条最近打开记录吗？对应文献的翻译历史也会删除。')) return

    try {
      const nextHistory = await window.electronAPI.deleteBrowsingRecord(id)
      setBrowsingHistory(normalizeBrowsingHistory(nextHistory))

      if (currentDocument?.id === id || currentDocument?.documentId === id) {
        setTranslationHistory([])
      }
    } catch (error) {
      setRecentStatus(error.message || '删除最近打开记录失败')
    }
  }

  async function clearBrowsingHistory() {
    if (!browsingHistory.length) return

    if (!window.confirm('确定要清空最近打开记录吗？这些文献对应的翻译历史也会清空，但不会删除 PDF 文件。')) return

    try {
      const nextHistory = window.electronAPI?.clearBrowsingHistory
        ? await window.electronAPI.clearBrowsingHistory()
        : []
      setBrowsingHistory(normalizeBrowsingHistory(nextHistory))
      setTranslationHistory([])
    } catch (error) {
      setRecentStatus(error.message || '清空最近打开记录失败')
    }
  }

  async function clearHistory() {
    if (!translationHistory.length) return

    if (!window.confirm('确定要清空当前文献的翻译历史吗？')) return

    try {
      const nextHistory = currentDocument?.documentId && window.electronAPI?.clearDocumentTranslationHistory
        ? await window.electronAPI.clearDocumentTranslationHistory(currentDocument.documentId)
        : []
      setTranslationHistory(normalizeHistoryList(nextHistory))
    } catch (error) {
      console.error('Failed to clear translation history', error)
      setTranslationHistory([])
    }
  }

  function formatImportExportSummary(summary) {
    if (!summary) return ''
    const recordCount = (summary.translationHistory || 0) + (summary.notes || 0) +
      (summary.annotations || 0) + (summary.bookmarks || 0)
    const folderLine = summary.restoredStates ? `\n恢复文件夹 ${summary.folders || 0}` : ''
    return `导入完成\n新增文献 ${summary.addedLiteratures ?? summary.documents ?? 0}\n合并文献 ${summary.mergedLiteratures || 0}\n新增记录 ${recordCount}${folderLine}`
  }

  async function refreshCurrentDocumentData() {
    if (!currentDocument?.documentId) return

    if (window.electronAPI?.getDocumentTranslationHistory) {
      const nextHistory = await window.electronAPI.getDocumentTranslationHistory(currentDocument.documentId)
      setTranslationHistory(normalizeHistoryList(nextHistory))
    }
    if (window.electronAPI?.getDocumentNotes) {
      const nextNotes = await window.electronAPI.getDocumentNotes(currentDocument.documentId)
      setDocumentNotes(normalizeNoteList(Array.isArray(nextNotes) ? nextNotes : []))
    }
    if (window.electronAPI?.getDocumentBookmarks) {
      const nextBookmarks = await window.electronAPI.getDocumentBookmarks(currentDocument.documentId)
      setDocumentBookmarks(normalizeBookmarkList(Array.isArray(nextBookmarks) ? nextBookmarks : []))
    }
    if (window.electronAPI?.getDocumentAnnotations) {
      const nextAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
      setDocumentAnnotations(normalizeAnnotationList(Array.isArray(nextAnnotations) ? nextAnnotations : []))
    }
  }

  const updateLibraryState = useCallback((library) => {
    const nextFolders = Array.isArray(library?.folders) ? library.folders : []
    const nextDocuments = Array.isArray(library?.documents) ? library.documents : []
    const nextLiteratures = Array.isArray(library?.literatures) ? library.literatures : nextDocuments
    const nextRecycledDocuments = Array.isArray(library?.recycledDocuments)
      ? library.recycledDocuments
      : nextLiteratures.filter((document) => document.status === 'recycled')

    setLibraryFolders(nextFolders)
    setLibraryDocuments(nextDocuments)
    setLibraryLiteratures(nextLiteratures)
    setRecycledLibraryDocuments(nextRecycledDocuments)
    setSelectedLibraryDocumentIds((currentIds) => (
      currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id))
    ))
    setSelectedLibraryFolderId((currentFolderId) => (
      currentFolderId === 'all' ||
      currentFolderId === 'unfiled' ||
      nextFolders.some((folder) => folder.id === currentFolderId)
        ? currentFolderId
        : 'all'
    ))
    setHistorySelectedRecycleIds((currentIds) => (
      currentIds.filter((id) => nextRecycledDocuments.some((document) => document.documentId === id))
    ))
  }, [])

  const refreshLibrary = useCallback(async () => {
    if (!window.electronAPI?.getLibrary) return

    try {
      const library = await window.electronAPI.getLibrary()
      updateLibraryState(library)
      setLibraryStatus('')
    } catch (error) {
      setLibraryStatus(error.message || '读取文献库失败')
    }
  }, [updateLibraryState])

  const syncDocumentToLibrary = useCallback(async (document = currentDocument) => {
    if (!document?.documentId || !window.electronAPI?.upsertLibraryDocument) return

    try {
      const library = await window.electronAPI.upsertLibraryDocument(document)
      updateLibraryState(library)
    } catch (error) {
      console.error('Failed to sync library document', error)
    }
  }, [currentDocument, updateLibraryState])

  async function exportCurrentHistory() {
    if (!currentDocument?.documentId) {
      setHistoryStatus('请先打开 PDF')
      return
    }
    if (!translationHistory.length) {
      setHistoryStatus('暂无可导出的翻译历史')
      return
    }

    setIsHistoryImportExportBusy(true)
    setHistoryStatus('')
    try {
      const result = await window.electronAPI.exportCurrentDocumentHistory(currentDocument.documentId)
      if (!result?.canceled) {
        setHistoryStatus(`已导出：${result.filePath}`)
      }
    } catch (error) {
      setHistoryStatus(error.message || '导出翻译历史失败')
    } finally {
      setIsHistoryImportExportBusy(false)
    }
  }

  async function importCurrentHistory() {
    if (!currentDocument?.documentId) {
      setHistoryStatus('请先打开 PDF')
      return
    }

    setIsHistoryImportExportBusy(true)
    setHistoryStatus('')
    try {
      const result = await window.electronAPI.importHistoryToCurrentDocument(currentDocument.documentId)
      if (!result?.canceled) {
        await refreshCurrentDocumentData()
        setHistoryStatus(formatImportExportSummary(result.summary))
      }
    } catch (error) {
      setHistoryStatus(error.message || '导入翻译历史失败')
    } finally {
      setIsHistoryImportExportBusy(false)
    }
  }

  async function exportCurrentNotes() {
    if (!currentDocument?.documentId) {
      setNotesStatus('请先打开 PDF')
      return
    }
    if (!documentNotes.length) {
      setNotesStatus('暂无可导出的笔记')
      return
    }

    setIsNotesImportExportBusy(true)
    setNotesStatus('')
    try {
      const result = await window.electronAPI.exportCurrentDocumentNotes(currentDocument.documentId)
      if (!result?.canceled) {
        setNotesStatus(`已导出：${result.filePath}`)
      }
    } catch (error) {
      setNotesStatus(error.message || '导出笔记失败')
    } finally {
      setIsNotesImportExportBusy(false)
    }
  }

  async function importCurrentNotes() {
    if (!currentDocument?.documentId) {
      setNotesStatus('请先打开 PDF')
      return
    }

    setIsNotesImportExportBusy(true)
    setNotesStatus('')
    try {
      const result = await window.electronAPI.importNotesToCurrentDocument(currentDocument.documentId)
      if (!result?.canceled) {
        await refreshCurrentDocumentData()
        setNotesStatus(formatImportExportSummary(result.summary))
      }
    } catch (error) {
      setNotesStatus(error.message || '导入笔记失败')
    } finally {
      setIsNotesImportExportBusy(false)
    }
  }

  retainedRightPanelActionsRef.current = {
    openPageNoteDialog,
    exportCurrentHistory,
    importCurrentHistory,
    exportCurrentNotes,
    importCurrentNotes,
  }

  async function loadExportSettingsData() {
    if (!window.electronAPI) return

    try {
      const [documents, defaultDir] = await Promise.all([
        window.electronAPI.getExportableDocuments?.() || [],
        window.electronAPI.getExportDefaultDir?.() || '',
      ])
      const nextDocuments = (Array.isArray(documents) ? documents : [])
        .slice()
        .sort((firstDocument, secondDocument) =>
          (Number(secondDocument.lastUpdatedAt) || 0) - (Number(firstDocument.lastUpdatedAt) || 0),
        )
      setExportableDocuments(nextDocuments)
      setExportDefaultDir(defaultDir || '')
      setSelectedExportDocumentIds((currentIds) => currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id)))
      setSelectedFileExportDocumentIds((currentIds) => currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id)))
      setSelectedExportDetailDocumentId((currentId) => (
        nextDocuments.some((document) => document.documentId === currentId)
          ? currentId
          : nextDocuments[0]?.documentId || ''
      ))
    } catch (error) {
      setExportStatus(error.message || '读取导入导出数据失败')
    }
  }

  async function selectExportDefaultDir() {
    try {
      const config = await window.electronAPI.selectExportDefaultDir()
      setExportDefaultDir(config?.exportDefaultDir || await window.electronAPI.getExportDefaultDir())
      if (config && !config.canceled) {
        setSettingsForm(normalizeSettings(config))
      }
      setExportStatus('默认导出位置已更新')
    } catch (error) {
      setExportStatus(error.message || '设置默认导出位置失败')
    }
  }

  async function resetExportDefaultDir() {
    try {
      const config = await window.electronAPI.resetExportDefaultDir()
      setExportDefaultDir(await window.electronAPI.getExportDefaultDir())
      setSettingsForm(normalizeSettings(config))
      setExportStatus('已恢复默认导出位置')
    } catch (error) {
      setExportStatus(error.message || '恢复默认导出位置失败')
    }
  }

  async function batchImportPaperReaderData() {
    setExportStatus('')
    setExportFailures([])
    try {
      const result = await window.electronAPI.batchImportPaperReaderData()
      if (!result?.canceled) {
        await Promise.all([loadExportSettingsData(), refreshCurrentDocumentData(), refreshLibrary()])
        setExportStatus(formatImportExportSummary(result.summary))
      }
    } catch (error) {
      setExportStatus(error.message || '批量导入失败')
    }
  }

  async function backupPaperReaderData(scope = 'selected') {
    const documentIds = scope === 'full'
      ? exportableDocuments.map((document) => document.documentId)
      : selectedExportDocumentIds
    if (!documentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }

    setExportStatus('')
    try {
      const result = await window.electronAPI.batchExportPaperReaderData({
        documentIds,
        exportType: 'full',
        exportMode: 'merged',
        userExportName: batchExportNameRef.current.trim() || (scope === 'full' ? 'Paper Reader 完整备份' : 'Paper Reader 文献备份'),
        includeAppState: true,
      })
      if (!result?.canceled) {
        setExportStatus(`备份完成\n文献 ${documentIds.length}\n${result.filePath}`)
      }
    } catch (error) {
      setExportStatus(error.message || '备份失败')
    }
  }

  async function collectMarkdownExportItems(documentIds, featureName = 'Markdown 导出') {
    if (!window.electronAPI?.getDocumentTranslationHistory || !window.electronAPI?.getDocumentAnnotations || !window.electronAPI?.getDocumentNotes || !window.electronAPI?.getDocumentBookmarks) {
      throw new Error(`${featureName}仅在桌面版可用`)
    }

    const uniqueDocumentIds = Array.from(new Set((Array.isArray(documentIds) ? documentIds : []).filter(Boolean)))
    const documentsById = new Map(exportableDocuments.map((document) => [document.documentId, document]))

    return Promise.all(uniqueDocumentIds.map(async (documentId) => {
      const pdf = documentsById.get(documentId) || (currentDocument?.documentId === documentId ? currentDocument : { documentId })
      const [histories, annotations, notes, bookmarks] = await Promise.all([
        window.electronAPI.getDocumentTranslationHistory(documentId),
        window.electronAPI.getDocumentAnnotations(documentId),
        window.electronAPI.getDocumentNotes(documentId),
        window.electronAPI.getDocumentBookmarks(documentId),
      ])

      return {
        pdf: {
          ...pdf,
          folderPath: getFileExportRelativePath(pdf),
        },
        histories: Array.isArray(histories) ? histories : [],
        annotations: Array.isArray(annotations) ? annotations : [],
        notes: Array.isArray(notes) ? notes : [],
        bookmarks: Array.isArray(bookmarks) ? bookmarks : [],
      }
    }))
  }

  function hasSelectedContentExportOption(options) {
    return Boolean(
      options?.exportNotes ||
      options?.exportHistories ||
      options?.exportHighlights ||
      options?.exportAnnotations ||
      options?.exportBookmarks,
    )
  }

  function assertPdfReportHtml(html) {
    const safeHtml = String(html || '').trim()
    if (!safeHtml) throw new Error('没有可导出的 PDF HTML 内容')
    return safeHtml
  }

  function toggleExportDocument(documentId) {
    setSelectedExportDetailDocumentId(documentId)
    setSelectedExportDocumentIds((currentIds) =>
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId],
    )
  }

  useEffect(() => {
    settingsFormRef.current = { ...settingsForm, rightPanelWidth }
    rightPanelWidthRef.current = rightPanelWidth
  }, [settingsForm, rightPanelWidth])

  useEffect(() => {
    let blurFrameId = null

    function handleTextEntryPointerDown(event) {
      const textEntry = getTextEntryElement(event.target)
      if (!textEntry) return

      // Keep the native pointer sequence intact so Chromium can focus the
      // field normally. State updates here can re-render between pointerdown
      // and mouseup and intermittently discard the user's click.
      suspendPdfTextSelection()
    }

    function handleTextEntryFocusIn(event) {
      if (!getTextEntryElement(event.target)) return

      annotationInteractionSuspendedRef.current = true
    }

    function handleWindowBlur() {
      if (blurFrameId) cancelAnimationFrame(blurFrameId)
      blurFrameId = requestAnimationFrame(() => {
        blurFrameId = null

        // Chromium can briefly report BODY as the active element while a
        // mouse click transfers focus into a text field. Cleaning React state
        // during that gap breaks the native mousedown/mouseup focus sequence.
        if (document.hasFocus() || getTextEntryElement(document.activeElement)) {
          annotationInteractionSuspendedRef.current = Boolean(
            getTextEntryElement(document.activeElement),
          )
          return
        }

        cancelTransientPointerInteractions()
      })
    }

    document.addEventListener('pointerdown', handleTextEntryPointerDown, true)
    document.addEventListener('focusin', handleTextEntryFocusIn, true)
    document.addEventListener('pointercancel', cancelTransientPointerInteractions)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      if (blurFrameId) cancelAnimationFrame(blurFrameId)
      document.removeEventListener('pointerdown', handleTextEntryPointerDown, true)
      document.removeEventListener('focusin', handleTextEntryFocusIn, true)
      document.removeEventListener('pointercancel', cancelTransientPointerInteractions)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [cancelTransientPointerInteractions, suspendPdfTextSelection])

  useEffect(() => {
    if (settingsTab === 'importExport') {
      void loadExportSettingsData()
    }
  }, [settingsTab])

  useEffect(() => {
    if (activeModule !== 'importExport' || !selectedExportDetailDocumentId) {
      setExportDocumentDetail(null)
      setExportDocumentDetailStatus('')
      return undefined
    }

    let isCanceled = false
    setExportDocumentDetailStatus('正在读取文件详情...')

    readExportDocumentDetail(window.electronAPI, selectedExportDetailDocumentId)
      .then((detail) => {
        if (isCanceled) return
        setExportDocumentDetail(detail)
        setExportDocumentDetailStatus('')
      })
      .catch((error) => {
        if (isCanceled) return
        setExportDocumentDetail(null)
        setExportDocumentDetailStatus(error.message || '读取文件详情失败')
      })

    return () => {
      isCanceled = true
    }
  }, [activeModule, selectedExportDetailDocumentId, exportableDocuments])

  useEffect(() => {
    if (!searchDialog.open) return undefined

    const frameId = requestAnimationFrame(() => {
      searchDialogInputRef.current?.focus()
      searchDialogInputRef.current?.select?.()
    })

    return () => cancelAnimationFrame(frameId)
  }, [searchDialog.open])

  useEffect(() => {
    if (!searchDialog.open) {
      setSearchResults([])
      setSearchStatus('')
      return undefined
    }

    const query = normalizeSearchText(searchDialog.query)
    if (!query) {
      setSearchResults([])
      setSearchStatus('')
      return undefined
    }

    let isCanceled = false
    const timerId = window.setTimeout(async () => {
      try {
        if (searchDialog.source === 'reader') {
          if (!pdfUrl && canSearchScope(searchDialog.scope, 'document')) {
            setSearchResults([])
            setSearchStatus('请先打开 PDF')
            return
          }

          setSearchStatus(canSearchScope(searchDialog.scope, 'document') ? '正在搜索当前 PDF...' : '')
          const pdfPages = canSearchScope(searchDialog.scope, 'document')
            ? await getCurrentPdfTextPages()
            : []
          if (isCanceled) return

          const nextResults = buildReaderSearchResults(query, searchDialog.scope, pdfPages)
          setSearchResults(nextResults)
          setSearchStatus(nextResults.length ? '' : '没有找到匹配结果')
          return
        }

        setSearchStatus('正在搜索文献库...')
        const data = await loadLibraryGlobalSearchData(canSearchScope(searchDialog.scope, 'document'))
        if (isCanceled) return

        const nextResults = buildLibrarySearchResults(query, searchDialog.scope, data)
        setSearchResults(nextResults.slice(0, SEARCH_RESULT_LIMIT))
        setSearchStatus(
          nextResults.length > SEARCH_RESULT_LIMIT
            ? '结果数量过多'
            : nextResults.length
              ? ''
              : '没有找到匹配结果',
        )
      } catch (error) {
        if (isCanceled) return
        setSearchResults([])
        setSearchStatus(error.message || '搜索失败')
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      isCanceled = true
      window.clearTimeout(timerId)
    }
  // Search runs are debounced and canceled manually; the state dependencies below are the result-changing inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchDialog,
    pdfUrl,
    currentDocument,
    translationHistory,
    documentAnnotations,
    documentNotes,
    libraryDocuments,
    libraryGlobalSearchData,
  ])

  useEffect(() => {
    if (!searchHitMarkerRequest || !pdfUrl || searchHitMarkerRequest.pageNumber !== pageNumber) return undefined

    let isCanceled = false
    let timerId = 0
    let attempts = 0

    const syncMarks = () => {
      if (isCanceled) return

      const markers = getSearchTextLayerHitMarkers(searchHitMarkerRequest.query)
      if (markers.length || attempts >= 8) {
        setSearchHitMarkers(markers)
        return
      }

      attempts += 1
      timerId = window.setTimeout(syncMarks, 120)
    }

    timerId = window.setTimeout(syncMarks, 120)

    return () => {
      isCanceled = true
      window.clearTimeout(timerId)
    }
  // Marker geometry is recomputed from the current PDF textLayer; the state below is the render-changing input set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchHitMarkerRequest, pdfUrl, pageNumber, pageWidth, zoomPercent])

  useEffect(() => {
    if (searchHitMarkerRequest && searchHitMarkerRequest.pageNumber !== pageNumber) {
      setSearchHitMarkers([])
    }
  }, [pageNumber, searchHitMarkerRequest])

  useEffect(() => {
    if (!isPageJumpFocused) {
      setPageJumpInput(String(pageNumber))
    }
  }, [isPageJumpFocused, pageNumber])

  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  useEffect(() => {
    if (!activeTabId) return

    const scrollTop = Number(pdfViewerRef.current?.scrollTop || 0)

    setPdfTabs((currentTabs) => currentTabs.map((tab) => (
      tab.id === activeTabId
        ? {
            ...tab,
            pdfUrl,
            document: currentDocument || tab.document,
            filePath: currentDocument?.filePath || tab.filePath,
            fileName: currentDocument?.fileName || tab.fileName,
            documentId: currentDocument?.documentId || tab.documentId,
            currentPage: pageNumber,
            totalPages: numPages,
            scale: zoomPercent,
            scrollTop,
            rightPanelResult,
            ocrResult,
            rightPanelTab,
            rightPanelVisible,
            updatedAt: Date.now(),
          }
        : tab
    )))
  }, [activeTabId, currentDocument, numPages, ocrResult, pageNumber, pdfUrl, rightPanelResult, rightPanelTab, rightPanelVisible, zoomPercent])

  useEffect(() => {
    if (pdfSessionSkipNextSaveRef.current) {
      pdfSessionSkipNextSaveRef.current = false
      return
    }

    schedulePdfSessionSave()
    // Session save helpers read refs and current state snapshots; adding them as deps would reschedule on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, pdfTabs])

  useEffect(() => {
    async function loadBrowsingHistory() {
      if (!window.electronAPI?.getBrowsingHistory) return

      try {
        const savedHistory = await window.electronAPI.getBrowsingHistory()
        setBrowsingHistory(normalizeBrowsingHistory(savedHistory))
      } catch (error) {
        console.error('Failed to load browsing history', error)
      }
    }

    loadBrowsingHistory()
  }, [])

  useEffect(() => {
    async function restorePdfSession() {
      if (!window.electronAPI?.getPdfSession || !window.electronAPI?.openPdfFromPath) return

      pdfSessionRestoreRef.current = true

      try {
        const savedSession = await window.electronAPI.getPdfSession()
        const savedTabs = Array.isArray(savedSession?.tabs) ? savedSession.tabs : []

        if (!savedTabs.length) return

        const restoredTabs = []
        const failedTabs = []

        for (const savedTab of savedTabs) {
          try {
            const pdfFile = await window.electronAPI.openPdfFromPath(savedTab.filePath)
            const document = {
              id: savedTab.documentId || pdfFile.documentId,
              documentId: savedTab.documentId || pdfFile.documentId,
              filePath: pdfFile.filePath || savedTab.filePath,
              fileName: pdfFile.fileName || savedTab.fileName || 'PDF',
              fileSize: Number(pdfFile.fileSize || savedTab.fileSize) || 0,
            }

            restoredTabs.push({
              id: getPdfTabId(document.documentId, document.filePath, document.fileName),
              documentId: document.documentId,
              filePath: document.filePath,
              fileName: document.fileName,
              fileSize: document.fileSize,
              document,
              pdfUrl: pdfFile.dataUrl || pdfFile.url,
              currentPage: savedTab.currentPage || 1,
              totalPages: savedTab.totalPages || null,
              scale: savedTab.scale || 100,
              scrollTop: Number(savedTab.scrollTop) || 0,
              rightPanelResult: savedTab.rightPanelResult || null,
              ocrResult: savedTab.ocrResult || null,
              rightPanelTab: savedTab.rightPanelTab || 'result',
              rightPanelVisible: savedTab.rightPanelVisible !== false,
              openedAt: savedTab.openedAt || Date.now(),
              updatedAt: savedTab.updatedAt || Date.now(),
            })
          } catch (error) {
            failedTabs.push(savedTab.fileName || savedTab.filePath || 'PDF')
            console.error('Failed to restore PDF tab', error)
          }
        }

        if (!restoredTabs.length) {
          resetCurrentPdfState()
          void savePdfSessionNow([], '')
          if (failedTabs.length) {
            setPdfSessionStatus(`上次打开的 PDF 均无法恢复：${failedTabs.slice(0, 3).join('、')}`)
          }
          if (failedTabs.length) {
            setRecentStatus(`上次打开的 PDF 均无法恢复：${failedTabs.slice(0, 3).join('、')}`)
          }
          return
        }

        setPendingSessionRestore({
          tabs: restoredTabs,
          activeTabId: savedSession.activeTabId,
          failedTabs,
        })
        return

        /*
        const restoredActiveTab = restoredTabs.find((tab) => tab.id === savedSession.activeTabId) || restoredTabs[0]

        setPdfTabs(restoredTabs)
        restorePdfTab(restoredActiveTab)
        if (failedTabs.length) {
          setPdfSessionStatus(`已跳过无法恢复的 PDF：${failedTabs.slice(0, 3).join('、')}`)
        }
        if (failedTabs.length) {
          setRecentStatus(`已跳过无法恢复的 PDF：${failedTabs.slice(0, 3).join('、')}`)
        }
        void savePdfSessionNow(restoredTabs, restoredActiveTab.id)
        */
      } catch (error) {
        console.error('Failed to restore PDF session', error)
      } finally {
        pdfSessionRestoreRef.current = false
      }
    }

    void restorePdfSession()
    // Restore should run once on startup and uses the initial Electron session only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isRecentOpen) return

    function handlePointerDown(event) {
      const target = event.target

      if (recentPopoverRef.current?.contains(target) || recentButtonRef.current?.contains(target)) {
        return
      }

      setIsRecentOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isRecentOpen])

  useEffect(() => {
    if (!libraryContextMenu) return

    function closeLibraryContextMenu() {
      setLibraryContextMenu(null)
    }

    document.addEventListener('pointerdown', closeLibraryContextMenu)

    return () => {
      document.removeEventListener('pointerdown', closeLibraryContextMenu)
    }
  }, [libraryContextMenu])

  useEffect(() => {
    if (!libraryFolderContextMenu) return

    function closeLibraryFolderContextMenu() {
      setLibraryFolderContextMenu(null)
    }

    function handleLibraryFolderMenuKeyDown(event) {
      if (event.key === 'Escape') closeLibraryFolderContextMenu()
    }

    document.addEventListener('pointerdown', closeLibraryFolderContextMenu)
    document.addEventListener('keydown', handleLibraryFolderMenuKeyDown)

    return () => {
      document.removeEventListener('pointerdown', closeLibraryFolderContextMenu)
      document.removeEventListener('keydown', handleLibraryFolderMenuKeyDown)
    }
  }, [libraryFolderContextMenu])

  useEffect(() => {
    if (!libraryMoveDialog) return

    function closeMoveDialog() {
      setLibraryMoveDialog(null)
    }

    document.addEventListener('pointerdown', closeMoveDialog)

    return () => {
      document.removeEventListener('pointerdown', closeMoveDialog)
    }
  }, [libraryMoveDialog])

  useEffect(() => {
    if (!libraryFolderMoveDialog) return

    function closeFolderMoveDialog() {
      setLibraryFolderMoveDialog(null)
    }

    function handleFolderMoveDialogKeyDown(event) {
      if (event.key === 'Escape') closeFolderMoveDialog()
    }

    document.addEventListener('pointerdown', closeFolderMoveDialog)
    document.addEventListener('keydown', handleFolderMoveDialogKeyDown)

    return () => {
      document.removeEventListener('pointerdown', closeFolderMoveDialog)
      document.removeEventListener('keydown', handleFolderMoveDialogKeyDown)
    }
  }, [libraryFolderMoveDialog])

  useEffect(() => {
    if (!libraryFolderDialogOpen) return

    const frameId = requestAnimationFrame(() => {
      libraryFolderNameInputRef.current?.focus()
      libraryFolderNameInputRef.current?.select()
    })

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        closeLibraryFolderDialog()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      cancelAnimationFrame(frameId)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [libraryFolderDialogOpen])

  const saveCurrentReadingRecord = useCallback(async (overrides = {}) => {
    if (!currentDocument?.documentId || !window.electronAPI?.updateBrowsingRecord) return

    const record = normalizeBrowsingRecord({
      ...currentDocument,
      totalPages: numPages,
      lastPage: pageNumber,
      scale: zoomPercent,
      rightPanelWidth,
      rightPanelVisible,
      ...overrides,
      lastOpenedAt: overrides.lastOpenedAt || Date.now(),
    })

    if (!record) return

    try {
      const nextHistory = await window.electronAPI.updateBrowsingRecord(record)
      setBrowsingHistory(normalizeBrowsingHistory(nextHistory))
      void syncDocumentToLibrary(currentDocument)
    } catch (error) {
      console.error('Failed to save browsing record', error)
    }
  }, [currentDocument, numPages, pageNumber, rightPanelVisible, rightPanelWidth, syncDocumentToLibrary, zoomPercent])

  useEffect(() => {
    if (!currentDocument?.documentId) return

    if (readingRecordSaveTimerRef.current) {
      clearTimeout(readingRecordSaveTimerRef.current)
    }

    readingRecordSaveTimerRef.current = setTimeout(() => {
      void saveCurrentReadingRecord()
    }, 700)

    return () => {
      if (readingRecordSaveTimerRef.current) {
        clearTimeout(readingRecordSaveTimerRef.current)
      }
    }
  }, [currentDocument, numPages, pageNumber, rightPanelVisible, rightPanelWidth, saveCurrentReadingRecord, zoomPercent])

  useEffect(() => {
    if (!isAnnotationToolbarOpen) {
      setPreviewHighlight(null)
      setHighlightContextMenu(null)
    }
  }, [isAnnotationToolbarOpen])

  useEffect(() => {
    if (!bookmarkDialogOpen) return undefined

    const timerId = window.setTimeout(() => {
      bookmarkTitleInputRef.current?.focus({ preventScroll: true })
    }, 50)

    return () => window.clearTimeout(timerId)
  }, [bookmarkDialogOpen])

  useEffect(() => {
    if (!isAnnotationToolbarOpen) return undefined

    function closeAnnotationToolbar(event) {
      const target = event.target

      if (
        annotationButtonRef.current?.contains(target) ||
        annotationToolbarRef.current?.contains(target) ||
        noteDialogRef.current?.contains(target) ||
        isInteractiveElement(target)
      ) {
        return
      }

      setIsAnnotationToolbarOpen(false)
      setPreviewHighlight(null)
    }

    document.addEventListener('pointerdown', closeAnnotationToolbar)

    return () => {
      document.removeEventListener('pointerdown', closeAnnotationToolbar)
    }
  }, [isAnnotationToolbarOpen])

  useEffect(() => {
    setPreviewHighlight(null)
    setHighlightContextMenu(null)
    setIsAnnotationToolbarOpen(false)
  }, [pageNumber, pdfUrl])

  useEffect(() => {
    if (!highlightContextMenu) return undefined

    function closeHighlightContextMenu(event) {
      if (event.target?.closest?.('.annotation-context-menu')) return
      setHighlightContextMenu(null)
    }

    function handleHighlightContextKeydown(event) {
      if (event.key === 'Escape') {
        setHighlightContextMenu(null)
      }
    }

    document.addEventListener('pointerdown', closeHighlightContextMenu)
    document.addEventListener('keydown', handleHighlightContextKeydown)

    return () => {
      document.removeEventListener('pointerdown', closeHighlightContextMenu)
      document.removeEventListener('keydown', handleHighlightContextKeydown)
    }
  }, [highlightContextMenu])

  useEffect(() => {
    async function loadDocumentTranslationHistory() {
      if (!currentDocument?.documentId || !window.electronAPI?.getDocumentTranslationHistory) {
        setTranslationHistory([])
        return
      }

      try {
        const savedHistory = await window.electronAPI.getDocumentTranslationHistory(currentDocument.documentId)
        setTranslationHistory(normalizeHistoryList(savedHistory))
      } catch (error) {
        console.error('Failed to load document translation history', error)
        setTranslationHistory([])
      }
    }

    loadDocumentTranslationHistory()
  }, [currentDocument])

  useEffect(() => {
    async function loadDocumentNotes() {
      setSelectedNoteId('')

      if (!currentDocument?.documentId || !window.electronAPI?.getDocumentNotes) {
        setDocumentNotes([])
        return
      }

      try {
        const savedNotes = await window.electronAPI.getDocumentNotes(currentDocument.documentId)
        setDocumentNotes(Array.isArray(savedNotes) ? savedNotes : [])
      } catch (error) {
        console.error('Failed to load document notes', error)
        setDocumentNotes([])
      }
    }

    loadDocumentNotes()
  }, [currentDocument])

  useEffect(() => {
    async function loadDocumentBookmarks() {
      setSelectedBookmarkIds([])
      setIsBookmarksBatchSelecting(false)
      setBookmarkDialogOpen(false)
      setBookmarkTitleDraft('')
      setBookmarksStatus('')

      if (!currentDocument?.documentId || !window.electronAPI?.getDocumentBookmarks) {
        setDocumentBookmarks([])
        return
      }

      try {
        const savedBookmarks = await window.electronAPI.getDocumentBookmarks(currentDocument.documentId)
        setDocumentBookmarks(normalizeBookmarkList(Array.isArray(savedBookmarks) ? savedBookmarks : []))
      } catch (error) {
        console.error('Failed to load document bookmarks', error)
        setDocumentBookmarks([])
      }
    }

    loadDocumentBookmarks()
  }, [currentDocument])

  useEffect(() => {
    let cancelled = false
    tocGenerationRequestRef.current += 1
    tocGenerationKeyRef.current = ''
    setDocumentToc([])
    setTocSource('unavailable')
    setTocStatus('')
    setIsTocGenerating(false)
    setCollapsedTocItemIds([])

    async function loadDocumentTableOfContents() {
      if (!currentDocument?.documentId || !pdfUrl) return

      if (!window.electronAPI?.getDocumentTableOfContents) {
        void generateTableOfContentsRef.current?.()
        return
      }

      try {
        const saved = await window.electronAPI.getDocumentTableOfContents(currentDocument.documentId)
        if (cancelled) return

        const isUserModified = saved?.userModified === true
        const isCurrentTocVersion = Number(saved?.version) >= TOC_RECOGNITION_VERSION
        const isCurrentFile = isTocFingerprintCurrent(saved?.fingerprint, currentDocument)
        const items = isUserModified || (isCurrentTocVersion && isCurrentFile)
          ? normalizeTocItems(saved?.items, Number.POSITIVE_INFINITY)
          : []
        setDocumentToc(items)
        setTocSource(saved?.source || 'unavailable')

        if (items.length) {
          setTocStatus('')
        } else if (!isCurrentTocVersion || !isCurrentFile) {
          void generateTableOfContentsRef.current?.()
        } else if (saved?.lastUpdatedAt) {
          setTocStatus('无法识别出目录')
        } else {
          void generateTableOfContentsRef.current?.()
        }
      } catch (error) {
        if (cancelled) return
        setTocStatus(error.message || '读取目录失败')
      }
    }

    void loadDocumentTableOfContents()
    return () => {
      cancelled = true
      tocGenerationRequestRef.current += 1
    }
  }, [currentDocument, pdfUrl])

  useEffect(() => {
    async function loadDocumentAnnotations() {
      setActiveAnnotationId('')

      if (!currentDocument?.documentId || !window.electronAPI?.getDocumentAnnotations) {
        setDocumentAnnotations([])
        return
      }

      try {
        const savedAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
        setDocumentAnnotations(Array.isArray(savedAnnotations) ? savedAnnotations : [])
      } catch (error) {
        console.error('Failed to load document annotations', error)
        setDocumentAnnotations([])
      }
    }

    loadDocumentAnnotations()
  }, [currentDocument])

  useEffect(() => {
    async function loadSavedLayout() {
      if (!window.electronAPI?.getConfig) return

      try {
        const config = await window.electronAPI.getConfig()
        const savedWidth = Number(config.rightPanelWidth) || DEFAULT_SETTINGS.rightPanelWidth
        setRightPanelWidth(Math.min(MAX_RIGHT_PANEL_WIDTH, Math.max(MIN_RIGHT_PANEL_WIDTH, savedWidth)))
      } catch {
        // Layout restore is optional; settings dialog will report config errors when opened.
      }
    }

    loadSavedLayout()
  }, [])

  useEffect(() => {
    pdfTabsRef.current = pdfTabs
  }, [pdfTabs])

  useEffect(() => {
    pendingSessionRestoreRef.current = pendingSessionRestore
  }, [pendingSessionRestore])

  useEffect(() => {
    pageWidthRef.current = pageWidth
  }, [pageWidth])

  useEffect(() => () => {
    if (sidebarResizeTimerRef.current) {
      clearTimeout(sidebarResizeTimerRef.current)
      sidebarResizeTimerRef.current = null
    }
    syncPageWidthRef.current = null
  }, [])

  useEffect(() => () => {
    if (pdfSessionSaveTimerRef.current) {
      clearTimeout(pdfSessionSaveTimerRef.current)
      pdfSessionSaveTimerRef.current = null
    }
    if (pendingSessionRestoreRef.current?.tabs?.length) {
      void savePdfSessionNow(pendingSessionRestoreRef.current.tabs, pendingSessionRestoreRef.current.activeTabId)
    } else {
      void savePdfSessionNow()
    }

    pdfTabsRef.current.forEach((tab) => {
      if (tab.pdfUrl?.startsWith?.('blob:')) {
        URL.revokeObjectURL(tab.pdfUrl)
      }
    })
    // Final cleanup should use refs captured at unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    function handleBeforeUnload() {
      if (pendingSessionRestoreRef.current?.tabs?.length) {
        void savePdfSessionNow(pendingSessionRestoreRef.current.tabs, pendingSessionRestoreRef.current.activeTabId)
        return
      }

      void savePdfSessionNow()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
    // beforeunload should keep a stable handler and read current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || !activeTabId) return

    function handlePdfViewerScroll() {
      if (pdfTabScrollSaveTimerRef.current) {
        clearTimeout(pdfTabScrollSaveTimerRef.current)
      }

      pdfTabScrollSaveTimerRef.current = setTimeout(() => {
        const scrollTop = Number(pdfViewer.scrollTop) || 0
        updateActivePdfTabSnapshot({ scrollTop })
        schedulePdfSessionSave(getSessionTabsSnapshot({ scrollTop }))
      }, 250)
    }

    pdfViewer.addEventListener('scroll', handlePdfViewerScroll, { passive: true })

    return () => {
      pdfViewer.removeEventListener('scroll', handlePdfViewerScroll)
      if (pdfTabScrollSaveTimerRef.current) {
        clearTimeout(pdfTabScrollSaveTimerRef.current)
        pdfTabScrollSaveTimerRef.current = null
      }
    }
    // Scroll persistence reads current refs and should only rebind when the active document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, pdfUrl])

  useEffect(() => {
    return () => {
      if (selectionFrameRef.current) {
        cancelAnimationFrame(selectionFrameRef.current)
      }
    }
  }, [clearOcrSelection])

  useEffect(() => {
    function handleFullscreenChange() {
      const isAppFullscreen = document.fullscreenElement === appRef.current

      setIsFullscreen(isAppFullscreen)
      setHighlightRects([])
      document.documentElement.classList.toggle('fullscreen-reading', isAppFullscreen)
      document.body.classList.toggle('fullscreen-reading', isAppFullscreen)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.documentElement.classList.remove('fullscreen-reading')
      document.body.classList.remove('fullscreen-reading')
    }
  }, [])

  useEffect(() => {
    if (!pdfViewerRef.current) return

    lastViewerSizeRef.current = { width: 0, height: 0 }

    function getStableDevicePixelRatio() {
      if (typeof window === 'undefined') return 1

      const ratio = Number(window.devicePixelRatio) || 1
      return Math.max(1, Math.min(ratio, 4))
    }

    function alignWidthToDevicePixels(width) {
      const flooredWidth = Math.max(160, Math.floor(width))
      const pixelRatio = getStableDevicePixelRatio()

      for (let candidateWidth = flooredWidth; candidateWidth >= Math.max(160, flooredWidth - 8); candidateWidth -= 1) {
        const deviceWidth = candidateWidth * pixelRatio

        if (Math.abs(Math.round(deviceWidth) - deviceWidth) < 0.01) {
          return candidateWidth
        }
      }

      return flooredWidth
    }

    function updatePageWidth() {
      const viewer = pdfViewerRef.current
      if (!viewer) return

      // Use the border-box as the resize key. A page near the viewport edge can
      // add or remove a scrollbar, which changes clientWidth without changing
      // the reader's actual layout. Treating that as a resize creates a loop:
      // page width -> scrollbar -> clientWidth -> page width.
      const roundedContainerWidth = Math.floor(viewer.offsetWidth)
      const roundedContainerHeight = Math.floor(viewer.offsetHeight)
      const lastViewerSize = lastViewerSizeRef.current

      if (
        Math.abs(lastViewerSize.width - roundedContainerWidth) < 1 &&
        Math.abs(lastViewerSize.height - roundedContainerHeight) < 1
      ) {
        return
      }

      lastViewerSizeRef.current = {
        width: roundedContainerWidth,
        height: roundedContainerHeight,
      }

      const sideSpace = isFullscreen ? 24 : 28
      const availableWidth = Math.max(160, Math.floor(viewer.clientWidth) - sideSpace)
      const availableHeight = Math.max(160, Math.floor(viewer.clientHeight) - sideSpace)
      const widthByHeight = availableHeight * pageRatio
      const basePageWidth = isFullscreen
        ? Math.min(availableWidth, widthByHeight, 1200)
        : Math.min(availableWidth, 1200)
      const zoomedWidth = basePageWidth * (zoomPercent / 100)
      const nextPageWidth = alignWidthToDevicePixels(zoomedWidth)

      if (Math.abs(pageWidthRef.current - nextPageWidth) < 4) {
        return
      }

      pageWidthRef.current = nextPageWidth
      setPageWidth(nextPageWidth)
    }

    let animationFrameId = null
    const pdfViewer = pdfViewerRef.current

    syncPageWidthRef.current = () => {
      updatePageWidth()
    }

    const resizeObserver = new ResizeObserver(() => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }

      animationFrameId = requestAnimationFrame(() => {
        if (sidebarResizeSettlingRef.current && !isFullscreen) {
          return
        }

        updatePageWidth()
      })
    })

    resizeObserver.observe(pdfViewer)
    animationFrameId = requestAnimationFrame(() => {
      updatePageWidth()
    })

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
      syncPageWidthRef.current = null
      resizeObserver.disconnect()
    }
  }, [isFullscreen, pageRatio, pdfUrl, zoomPercent])

  useEffect(() => {
    if (!pdfUrl) return undefined

    let secondFrameId = null
    const firstFrameId = requestAnimationFrame(() => {
      secondFrameId = requestAnimationFrame(() => {
        syncPageWidthRef.current?.()
      })
    })

    return () => {
      cancelAnimationFrame(firstFrameId)
      if (secondFrameId) cancelAnimationFrame(secondFrameId)
    }
  }, [isFullscreen, pdfUrl, toolbarCollapsed])

  useEffect(() => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer) return

    let pageObserver = null
    let cancelled = false

    function updateCenterScroll() {
      if (cancelled || !pdfViewerRef.current) return

      const overflowWidth = pdfViewerRef.current.scrollWidth - pdfViewerRef.current.clientWidth

      // Keep the page horizontally centered when it overflows the viewer; the
      // overflow stays reachable in both directions via scrollbar / shift+wheel.
      if (overflowWidth > 0) {
        pdfViewerRef.current.scrollLeft = overflowWidth / 2
      }

      // Vertical landing position after a wheel-driven page turn is independent
      // of whether the page overflows horizontally.
      const pendingScroll = pendingWheelScrollRef.current

      if (pendingScroll) {
        requestAnimationFrame(() => {
          if (cancelled || !pdfViewerRef.current) return

          if (pendingScroll === 'bottom') {
            pdfViewerRef.current.scrollTop = Math.max(0, pdfViewerRef.current.scrollHeight - pdfViewerRef.current.clientHeight)
          } else {
            pdfViewerRef.current.scrollTop = 0
          }

          pendingWheelScrollRef.current = null
        })
      }
    }

    function observePage() {
      if (cancelled) return
      const pageEl = pdfViewerRef.current?.querySelector('.pdf-page-wrapper')
      if (!pageEl) {
        requestAnimationFrame(observePage)
        return
      }

      // Re-center whenever the rendered page size changes (zoom, fit, page turn).
      if (pageObserver) pageObserver.disconnect()
      pageObserver = new ResizeObserver(() => {
        requestAnimationFrame(updateCenterScroll)
      })
      pageObserver.observe(pageEl)
      requestAnimationFrame(updateCenterScroll)
    }

    requestAnimationFrame(observePage)

    return () => {
      cancelled = true
      if (pageObserver) pageObserver.disconnect()
    }
  }, [pageWidth, pageNumber, pdfUrl, zoomPercent])

  useEffect(() => {
    if (!copyStatus) return

    const timerId = setTimeout(() => {
      setCopyStatus('')
    }, 1600)

    return () => clearTimeout(timerId)
  }, [copyStatus])

  useEffect(() => {
    function handleKeyDown(event) {
      if (isInteractiveElement(event.target)) return
      if (event.key !== 'Escape') return

      if (isDiagramModalFullscreen || isCompareModalFullscreen) {
        setIsDiagramModalFullscreen(false)
        setIsCompareModalFullscreen(false)
        return
      }

      if (imagePreview) {
        setImagePreview(null)
        setIsImagePreviewFullscreen(false)
        return
      }

      if (diagramResult) {
        setDiagramResult(null)
        return
      }

      if (compareResult) {
        setCompareResult(null)
        return
      }

      setImagePreview(null)
      setIsImagePreviewFullscreen(false)
      setIsOcrMode(false)
      setIsOcrMenuOpen(false)
      clearOcrSelection()
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [clearOcrSelection, compareResult, diagramResult, imagePreview, isCompareModalFullscreen, isDiagramModalFullscreen])

  useEffect(() => {
    const pdfViewer = pdfViewerRef.current
    if (!pdfViewer || !pdfUrl) return

    function handleWheel(event) {
      const absDx = Math.abs(event.deltaX)
      const absDy = Math.abs(event.deltaY)
      const maxScrollLeft = Math.max(0, pdfViewer.scrollWidth - pdfViewer.clientWidth)
      const canScrollHorizontally = maxScrollLeft > 0

      if (canScrollHorizontally && absDx >= 1 && absDx >= absDy) {
        const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, pdfViewer.scrollLeft + event.deltaX))

        if (Math.abs(nextScrollLeft - pdfViewer.scrollLeft) >= 0.5) {
          event.preventDefault()
          pdfViewer.scrollLeft = nextScrollLeft
          return
        }
      }

      if (canScrollHorizontally && event.shiftKey && absDy >= 1) {
        event.preventDefault()
        pdfViewer.scrollLeft = Math.min(maxScrollLeft, Math.max(0, pdfViewer.scrollLeft + event.deltaY))
        return
      }

      if (absDy < 10 || absDx > absDy) return
      if (isOcrMode || isOcrDragging || isSelectingRef.current) return

      const scrollTolerance = 2
      const atTop = pdfViewer.scrollTop <= scrollTolerance
      const atBottom = pdfViewer.scrollTop + pdfViewer.clientHeight >= pdfViewer.scrollHeight - scrollTolerance

      if (event.deltaY > 0 && !atBottom) return
      if (event.deltaY < 0 && !atTop) return

      const now = Date.now()
      if (now - lastWheelTimeRef.current < 500) return

      const shouldTurnNext = event.deltaY > 0 && numPages && pageNumber < numPages
      const shouldTurnPrevious = event.deltaY < 0 && pageNumber > 1

      if (!shouldTurnNext && !shouldTurnPrevious) return

      event.preventDefault()
      lastWheelTimeRef.current = now
      pendingWheelScrollRef.current = shouldTurnNext ? 'top' : 'bottom'
      clearTranslation()

      setPageNumber((currentPage) => {
        if (event.deltaY > 0 && numPages && currentPage < numPages) {
          return currentPage + 1
        }

        if (event.deltaY < 0 && currentPage > 1) {
          return currentPage - 1
        }

        return currentPage
      })
    }

    pdfViewer.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      pdfViewer.removeEventListener('wheel', handleWheel)
    }
  }, [isOcrDragging, isOcrMode, numPages, pageNumber, pdfUrl])

  const requestBackendJson = useCallback(async (endpoint, payload) => {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      throw new Error(data.error || UI.translateError)
    }

    return data
  }, [])

  useEffect(() => {
    const provider = normalizeProviderKey(settingsForm.provider)
    const baseUrl = String(settingsForm.baseUrl || '').trim()
    const apiKey = String(settingsForm.apiKey || '').trim()
    const currentRequestId = modelListRequestIdRef.current + 1
    modelListRequestIdRef.current = currentRequestId

    setAvailableModels([])
    setModelListError('')

    if (!baseUrl || !apiKey) {
      setModelListStatus('idle')
      return undefined
    }

    setModelListStatus('loading')

    const timeoutId = window.setTimeout(async () => {
      try {
        const payload = {
          config: {
            provider,
            baseUrl,
            apiKey,
          },
        }
        const data = window.electronAPI?.listAiModels
          ? await window.electronAPI.listAiModels(payload)
          : await requestBackendJson('/ai/models', payload)

        if (modelListRequestIdRef.current !== currentRequestId) return

        const modelsById = new Map()
        ;(Array.isArray(data.models) ? data.models : []).forEach((rawModel) => {
          const model = typeof rawModel === 'string' ? { id: rawModel } : rawModel
          const id = String(model?.id || '').trim()
          if (!id || modelsById.has(id)) return
          modelsById.set(id, {
            id,
            name: String(model?.name || '').trim(),
            inputModalities: Array.isArray(model?.inputModalities)
              ? model.inputModalities.map(String)
              : [],
            supportsMultimodal:
              typeof model?.supportsMultimodal === 'boolean'
                ? model.supportsMultimodal
                : null,
          })
        })

        const nextModels = Array.from(modelsById.values())
        setAvailableModels(nextModels)
        setSettingsForm((currentSettings) => {
          const currentModel = nextModels.find((model) => model.id === currentSettings.model)
          if (!currentModel || typeof currentModel.supportsMultimodal !== 'boolean') {
            return currentSettings
          }
          return {
            ...currentSettings,
            modelSupportsMultimodal: currentModel.supportsMultimodal,
          }
        })
        setModelListStatus('success')
      } catch (error) {
        if (modelListRequestIdRef.current !== currentRequestId) return
        setAvailableModels([])
        setModelListStatus('error')
        setModelListError(error.message || '获取模型列表失败')
      }
    }, 700)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [
    requestBackendJson,
    settingsForm.apiKey,
    settingsForm.baseUrl,
    settingsForm.provider,
  ])

  const requestTranslation = useCallback(async (text) => {
    const payload = { text }
    const data = window.electronAPI?.translateText
      ? await window.electronAPI.translateText(payload)
      : await requestBackendJson('/ai/translate-text', payload)

    if (!data.translation) {
      throw new Error('AI provider returned an empty translation.')
    }

    return data.translation
  }, [requestBackendJson])

  useEffect(() => {
    const text = selectedText.trim()

    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current

    if (!text || text.length <= 1) {
      return
    }

    if (text === lastTranslatedTextRef.current) {
      return
    }

    const timerId = setTimeout(async () => {
      setTranslation('')
      setTranslationStatus('loading')

      try {
        const preparedResult = await prepareSelectionTranslationRef.current(text, selectionCapture)
        const nextTranslation = cleanResultText(preparedResult.translation)

        if (currentRequestId !== requestIdRef.current) return

        lastTranslatedTextRef.current = text
        setTranslation(nextTranslation)
        setTranslationStatus('success')
        setSuccessfulRightPanelResult({
          type: 'text-selection',
          title: '翻译结果',
          selectedText: preparedResult.sourceText,
          translation: nextTranslation,
          inlineFormulas: preparedResult.inlineFormulas,
          preserveOriginalFormula: preparedResult.preserveOriginal,
          timestamp: Date.now(),
        })
      } catch (error) {
        if (currentRequestId !== requestIdRef.current) return

        setTranslation(`${UI.errorPrefix}${error.message || UI.translateError}`)
        setTranslationStatus('error')
      }
    }, 300)

    return () => clearTimeout(timerId)
  }, [selectedText, selectionCapture, setSuccessfulRightPanelResult])

  function applyOpenedPdf(pdfFile, restoreRecord = null) {
    if (!pdfFile?.dataUrl && !pdfFile?.url) return

    const nextDocument = {
      id: pdfFile.documentId,
      documentId: pdfFile.documentId,
      filePath: pdfFile.filePath || '',
      fileName: pdfFile.fileName || 'PDF',
      fileSize: Number(pdfFile.fileSize) || 0,
      modifiedTime: Number(pdfFile.modifiedTime) || 0,
      fileHash: String(pdfFile.fileHash || ''),
    }
    const nextTabId = getPdfTabId(nextDocument.documentId, nextDocument.filePath, nextDocument.fileName)
    const nextPdfUrl = pdfFile.dataUrl || pdfFile.url
    const existingTab = pdfTabs.find((tab) =>
      tab.id === nextTabId ||
      tab.documentId === nextDocument.documentId ||
      (nextDocument.filePath && tab.filePath === nextDocument.filePath),
    )
    setSearchHitMarkers([])
    setSearchHitMarkerRequest(null)

    if (existingTab) {
      const nextTabs = pdfTabs.map((tab) => (
        tab.id === existingTab.id
          ? {
              ...tab,
              pdfUrl: nextPdfUrl || tab.pdfUrl,
              document: nextDocument,
              filePath: nextDocument.filePath,
              fileName: nextDocument.fileName,
              documentId: nextDocument.documentId,
              updatedAt: Date.now(),
            }
          : tab
      ))

      setPdfTabs(nextTabs)
      schedulePdfSessionSave(nextTabs, existingTab.id)
      if (existingTab.id === activeTabId) {
        setCurrentDocument(nextDocument)
        setPdfUrl(nextPdfUrl)
        void syncDocumentToLibrary(nextDocument)
      } else {
        updateActivePdfTabSnapshot()
        void saveCurrentReadingRecord()
        restorePdfTab({
          ...existingTab,
          pdfUrl: nextPdfUrl || existingTab.pdfUrl,
          document: nextDocument,
          filePath: nextDocument.filePath,
          fileName: nextDocument.fileName,
          documentId: nextDocument.documentId,
        })
      }
      setIsRecentOpen(false)
      setRecentStatus('')
      setPdfSessionStatus('')
      return
    }

    pendingReadingRestoreRef.current = restoreRecord
    updateActivePdfTabSnapshot()
    void saveCurrentReadingRecord()
    const nextTab = {
      id: nextTabId,
      documentId: nextDocument.documentId,
      filePath: nextDocument.filePath,
      fileName: nextDocument.fileName,
      document: nextDocument,
      pdfUrl: nextPdfUrl,
      currentPage: 1,
      totalPages: restoreRecord?.totalPages || null,
      scale: restoreRecord?.scale || zoomPercent,
      scrollTop: 0,
      rightPanelResult: null,
      ocrResult: null,
      rightPanelTab: 'result',
      rightPanelVisible: restoreRecord?.rightPanelVisible ?? rightPanelVisible,
      openedAt: Date.now(),
      updatedAt: Date.now(),
    }
    const nextTabs = [...pdfTabs, nextTab]
    setPdfTabs(nextTabs)
    schedulePdfSessionSave(nextTabs, nextTab.id)
    setActiveTabId(nextTab.id)
    setCurrentDocument(nextDocument)
    setPdfUrl(nextPdfUrl)
    setPageNumber(1)
    setNumPages(null)
    setPageJumpInput('1')
    setIsRecentOpen(false)
    setRecentStatus('')
    setPdfSessionStatus('')
    setTranslationHistory([])
    clearRightPanelResult()
    void syncDocumentToLibrary(nextDocument)
    const initialRecord = normalizeBrowsingRecord({
      ...nextDocument,
      totalPages: restoreRecord?.totalPages || null,
      lastPage: restoreRecord?.lastPage || 1,
      scale: restoreRecord?.scale || zoomPercent,
      rightPanelWidth: restoreRecord?.rightPanelWidth || rightPanelWidth,
      rightPanelVisible: restoreRecord?.rightPanelVisible ?? rightPanelVisible,
    })

    if (initialRecord && window.electronAPI?.updateBrowsingRecord) {
      window.electronAPI.updateBrowsingRecord(initialRecord)
        .then((nextHistory) => setBrowsingHistory(normalizeBrowsingHistory(nextHistory)))
        .catch((error) => console.error('Failed to save browsing record', error))
    }
  }

  async function openPdfFromRecent(record) {
    const existingTab = pdfTabs.find((tab) =>
      tab.documentId === record.documentId ||
      (record.filePath && tab.filePath === record.filePath),
    )

    if (existingTab) {
      activatePdfTab(existingTab.id)
      setIsRecentOpen(false)
      setRecentStatus('')
      return
    }

    if (!window.electronAPI?.openPdfFromPath) {
      setRecentStatus('当前环境无法从路径重新打开 PDF')
      return
    }

    try {
      const pdfFile = await window.electronAPI.openPdfFromPath(record.filePath)
      applyOpenedPdf(pdfFile, record)
    } catch (error) {
      setRecentStatus(error.message || '文件不存在或已移动')
    }
  }

  async function handleOpenPdfClick() {
    if (window.electronAPI?.openPdfDialog) {
      try {
        const result = await window.electronAPI.openPdfDialog()

        if (!result?.canceled) {
          applyOpenedPdf(result)
        }
      } catch (error) {
        setRecentStatus(error.message || '打开 PDF 失败')
      }
      return
    }

    fallbackFileInputRef.current?.click()
  }

  function handleFileChange(event) {
    const file = event.target.files[0]

    if (!file) return

    applyOpenedPdf({
      url: URL.createObjectURL(file),
      filePath: file.name,
      fileName: file.name,
      fileSize: file.size,
      documentId: `${file.name}-${file.size}`,
    })
  }

  function getLibraryFolderName(folderId) {
    if (!folderId) return '未分类'
    return libraryFolders.find((folder) => folder.id === folderId)?.name || '未分类'
  }

  function getLibraryFolderChildren(parentId = null) {
    return libraryFolders
      .filter((folder) => (folder.parentId || null) === (parentId || null))
      .sort((first, second) => (first.order || 0) - (second.order || 0) || first.name.localeCompare(second.name))
  }

  function getLibraryDescendantFolderIds(folderId) {
    const ids = new Set(folderId ? [folderId] : [])
    let changed = true
    while (changed) {
      changed = false
      libraryFolders.forEach((folder) => {
        if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
          ids.add(folder.id)
          changed = true
        }
      })
    }
    return ids
  }

  function getLibraryFolderDocumentCount(folderId, includeDescendants = true) {
    const folderIds = includeDescendants ? getLibraryDescendantFolderIds(folderId) : new Set([folderId])
    return libraryDocuments.filter((document) => folderIds.has(document.folderId)).length
  }

  function getLibraryFolderRecordCount(folderId, includeDescendants = true) {
    const folderIds = includeDescendants ? getLibraryDescendantFolderIds(folderId) : new Set([folderId])
    return libraryDocuments
      .filter((document) => folderIds.has(document.folderId))
      .reduce((total, document) => total + (document.recordCount || 0), 0)
  }

  function getHistoryLibraryDocuments() {
    if (historyLibraryNodeId === 'recycle') return recycledLibraryDocuments
    if (historyLibraryNodeId === 'all') return libraryDocuments
    if (historyLibraryNodeId === 'unfiled') return libraryDocuments.filter((document) => !document.folderId)
    const folderIds = historyIncludeDescendants
      ? getLibraryDescendantFolderIds(historyLibraryNodeId)
      : new Set([historyLibraryNodeId])
    return libraryDocuments.filter((document) => folderIds.has(document.folderId))
  }

  function getLibraryProgress(document) {
    if (!document?.totalPages) return '未开始'
    const page = Math.min(Number(document.lastPage) || 1, Number(document.totalPages) || 1)
    return `${page} / ${document.totalPages}`
  }

  function getLibraryProgressPercent(document) {
    if (!document?.totalPages) return 0
    return Math.min(100, Math.max(0, Math.round(((Number(document.lastPage) || 1) / document.totalPages) * 100)))
  }

  function openSearchDialog(source, query = '') {
    setSearchDialog((currentDialog) => ({
      open: true,
      source,
      query,
      scope: currentDialog.source === source ? currentDialog.scope : 'all',
    }))
    setSearchStatus('')
  }

  function closeSearchDialog() {
    setSearchDialog((currentDialog) => ({ ...currentDialog, open: false }))
    setSearchStatus('')
  }

  function updateSearchDialogQuery(query) {
    setSearchDialog((currentDialog) => ({ ...currentDialog, query }))
    if (searchDialog.source === 'reader') {
      setReaderSearchInput(query)
    } else {
      setLibrarySearch(query)
    }
  }

  function updateSearchDialogScope(scope) {
    setSearchDialog((currentDialog) => ({ ...currentDialog, scope }))
  }

  function handleReaderSearchInputChange(event) {
    const query = event.target.value
    setReaderSearchInput(query)
    openSearchDialog('reader', query)
  }

  function handleReaderSearchKeyDown(event) {
    if (event.key === 'Enter') {
      openSearchDialog('reader', readerSearchInput)
    }
  }

  function handleLibrarySearchInputChange(event) {
    const query = event.target.value
    setLibrarySearch(query)
    if (librarySearchMode === 'global') {
      openSearchDialog('library', query)
    }
  }

  function updateLibrarySearchMode(mode) {
    setLibrarySearchMode(mode)
    if (mode === 'global') {
      openSearchDialog('library', librarySearch)
    }
  }

  function getPdfSearchCacheKey() {
    return `${currentDocument?.documentId || ''}|${pdfUrl}`
  }

  async function extractPdfTextPages(pdfSource) {
    if (!pdfSource) return []
    let pdfDocument = null
    const loadingTask = pdfjs.getDocument(pdfSource)

    try {
      pdfDocument = await loadingTask.promise
      const pages = []

      for (let pageIndex = 1; pageIndex <= pdfDocument.numPages; pageIndex += 1) {
        const page = await pdfDocument.getPage(pageIndex)
        const textContent = await page.getTextContent()
        const text = normalizeSearchText(textContent.items.map((item) => item.str).join(' '))
        pages.push({ pageNumber: pageIndex, text })
      }

      return pages
    } finally {
      if (pdfDocument?.destroy) {
        try {
          await pdfDocument.destroy()
        } catch {
          // Ignore cleanup failures from PDF.js worker teardown.
        }
      }
    }
  }

  async function getCurrentPdfTextPages() {
    if (!pdfUrl) return []

    const cacheKey = getPdfSearchCacheKey()
    if (pdfTextSearchCacheRef.current.key === cacheKey) {
      return pdfTextSearchCacheRef.current.pages
    }

    const pages = await extractPdfTextPages(pdfUrl)
    pdfTextSearchCacheRef.current = { key: cacheKey, pages }
    return pages
  }

  async function getLibraryDocumentTextPages(document) {
    if (!document?.documentId || !document.filePath || !window.electronAPI?.openPdfFromPath) return []

    const cacheKey = `${document.documentId}|${document.filePath}|${document.updatedAt || 0}|${document.fileSize || 0}`
    if (libraryDocumentTextCacheRef.current.has(cacheKey)) {
      return libraryDocumentTextCacheRef.current.get(cacheKey)
    }

    const pdfFile = await window.electronAPI.openPdfFromPath(document.filePath)
    const pages = await extractPdfTextPages(pdfFile.dataUrl || pdfFile.url)
    libraryDocumentTextCacheRef.current.set(cacheKey, pages)
    return pages
  }

  function createSearchResult({ source, type, document, item = null, pageNumber = null, title, subtitle = '', snippet, query = '' }) {
    return {
      id: `${source}-${type}-${document?.documentId || currentDocument?.documentId || 'current'}-${item?.id || pageNumber || title}`,
      source,
      type,
      document,
      item,
      pageNumber,
      title,
      subtitle,
      snippet,
      query,
    }
  }

  function appendRecordSearchResult(results, { source, type, document, item, title, fallbackTitle, query }) {
    const texts = collectSearchTexts(item)
    const snippet = getSearchMatchSnippet(texts, query)
    if (!snippet) return

    const page = getSearchPageNumber(item)
    results.push(createSearchResult({
      source,
      type,
      document,
      item,
      pageNumber: page,
      title: title || fallbackTitle,
      subtitle: [document?.fileName, page ? `第 ${page} 页` : ''].filter(Boolean).join(' · '),
      snippet,
      query,
    }))
  }

  function buildReaderSearchResults(query, scope, pdfPages = []) {
    const results = []

    if (canSearchScope(scope, 'document')) {
      pdfPages.forEach((page) => {
        const snippet = getSearchMatchSnippet([page.text], query)
        if (!snippet) return

        results.push(createSearchResult({
          source: 'reader',
          type: 'document',
          document: currentDocument,
          pageNumber: page.pageNumber,
          title: `第 ${page.pageNumber} 页`,
          subtitle: currentDocument?.fileName || '当前文献',
          snippet,
          query,
        }))
      })
    }

    if (canSearchScope(scope, 'translation')) {
      translationHistory.forEach((item) => appendRecordSearchResult(results, {
        source: 'reader',
        type: 'translation',
        document: currentDocument,
        item,
        query,
        title: item.title || HISTORY_TYPE_LABELS[item.type] || '翻译结果',
        fallbackTitle: '翻译结果',
      }))
    }

    if (canSearchScope(scope, 'annotation')) {
      documentAnnotations
        .filter((item) => item?.type !== 'ocr-note-tag')
        .forEach((item) => appendRecordSearchResult(results, {
          source: 'reader',
          type: 'annotation',
          document: currentDocument,
          item,
          query,
          title: '批注',
          fallbackTitle: '批注',
        }))
    }

    if (canSearchScope(scope, 'note')) {
      documentNotes.forEach((item) => appendRecordSearchResult(results, {
        source: 'reader',
        type: 'note',
        document: currentDocument,
        item,
        query,
        title: item.title || NOTE_TYPE_LABELS[item.type] || '笔记',
        fallbackTitle: '笔记',
      }))
    }

    return results
  }

  function getLibraryGlobalSearchCacheKey(includeDocumentText = false) {
    const libraryKey = libraryDocuments
      .map((document) => `${document.documentId}:${document.updatedAt || 0}:${document.lastOpenedAt || 0}:${document.notesCount || 0}:${document.annotationsCount || 0}`)
      .join('|')
    return `${libraryKey}|pdf:${includeDocumentText ? '1' : '0'}`
  }

  async function loadLibraryGlobalSearchData(includeDocumentText = false) {
    const cacheKey = getLibraryGlobalSearchCacheKey(includeDocumentText)
    if (librarySearchCacheRef.current.key === cacheKey && librarySearchCacheRef.current.data) {
      return librarySearchCacheRef.current.data
    }

    const data = {
      documents: libraryDocuments.slice(),
      documentPages: [],
      histories: [],
      annotations: [],
      notes: [],
    }

    if (
      window.electronAPI?.getDocumentTranslationHistory &&
      window.electronAPI?.getDocumentAnnotations &&
      window.electronAPI?.getDocumentNotes
    ) {
      const rows = await Promise.all(libraryDocuments.map(async (document) => {
        try {
          const [histories, annotations, notes] = await Promise.all([
            window.electronAPI.getDocumentTranslationHistory(document.documentId),
            window.electronAPI.getDocumentAnnotations(document.documentId),
            window.electronAPI.getDocumentNotes(document.documentId),
          ])

          return { document, histories, annotations, notes }
        } catch {
          return { document, histories: [], annotations: [], notes: [] }
        }
      }))

      rows.forEach((row) => {
        sortExportDetailRecords(row.histories).forEach((item) => data.histories.push({ document: row.document, item }))
        normalizeDocumentAnnotationList(row.annotations)
          .filter((item) => item?.type !== 'ocr-note-tag')
          .forEach((item) => data.annotations.push({ document: row.document, item }))
        normalizeDocumentNoteList(row.notes).forEach((item) => data.notes.push({ document: row.document, item }))
      })
    }

    if (includeDocumentText) {
      for (const document of libraryDocuments) {
        try {
          const pages = await getLibraryDocumentTextPages(document)
          pages.forEach((page) => {
            if (page.text) data.documentPages.push({ document, page })
          })
        } catch {
          // Some library entries may point to moved files; keep global search usable for the rest.
        }
      }
    }

    librarySearchCacheRef.current = { key: cacheKey, data }
    setLibraryGlobalSearchData(data)
    return data
  }

  function buildLibrarySearchResults(query, scope, data) {
    const results = []
    const searchData = data || libraryGlobalSearchData || { documents: [], documentPages: [], histories: [], annotations: [], notes: [] }

    if (canSearchScope(scope, 'document')) {
      searchData.documentPages.forEach(({ document, page }) => {
        const snippet = getSearchMatchSnippet([page.text], query)
        if (!snippet) return

        results.push(createSearchResult({
          source: 'library',
          type: 'document',
          document,
          pageNumber: page.pageNumber,
          title: `第 ${page.pageNumber} 页`,
          subtitle: document.fileName,
          snippet,
          query,
        }))
      })
    }

    if (canSearchScope(scope, 'translation')) {
      searchData.histories.forEach(({ document, item }) => appendRecordSearchResult(results, {
        source: 'library',
        type: 'translation',
        document,
        item,
        query,
        title: item.title || HISTORY_TYPE_LABELS[item.type] || '翻译结果',
        fallbackTitle: '翻译结果',
      }))
    }

    if (canSearchScope(scope, 'annotation')) {
      searchData.annotations.forEach(({ document, item }) => appendRecordSearchResult(results, {
        source: 'library',
        type: 'annotation',
        document,
        item,
        query,
        title: '批注',
        fallbackTitle: '批注',
      }))
    }

    if (canSearchScope(scope, 'note')) {
      searchData.notes.forEach(({ document, item }) => appendRecordSearchResult(results, {
        source: 'library',
        type: 'note',
        document,
        item,
        query,
        title: item.title || NOTE_TYPE_LABELS[item.type] || '笔记',
        fallbackTitle: '笔记',
      }))
    }

    return results
  }

  function getSearchTextLayerHitMarkers(query) {
    const viewer = pdfViewerRef.current
    const normalizedQuery = normalizeSearchText(query).toLowerCase()
    if (!viewer || !normalizedQuery) return []

    const viewerRect = viewer.getBoundingClientRect()
    const textSpans = Array.from(viewer.querySelectorAll('.react-pdf__Page__textContent span, .textLayer span'))
    const spanRecords = textSpans
      .map((span, index) => {
        const text = normalizeSearchText(span.textContent)
        const chars = Array.from(text)
        if (!chars.length) return null

        const rect = span.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) return null

        return { index, text, chars, rect }
      })
      .filter(Boolean)

    return getSearchHitRanges(spanRecords, normalizedQuery).slice(0, 24).map((range, index) => {
      const record = spanRecords[range.spanIndex]
      const rect = record.rect
      const charCount = record.chars.length
      const startRatio = range.start / charCount
      const endRatio = range.end / charCount
      const verticalInset = Math.min(2, rect.height * 0.12)
      const left = rect.left - viewerRect.left + viewer.scrollLeft + (rect.width * startRatio)
      const width = rect.width * Math.max(0.01, endRatio - startRatio)

      return {
        id: `${searchHitMarkerRequest?.id || 'hit'}-${record.index}-${range.start}-${range.end}-${index}`,
        left,
        top: rect.top - viewerRect.top + viewer.scrollTop + verticalInset,
        width: Math.max(3, width),
        height: Math.max(8, rect.height - (verticalInset * 2)),
      }
    })
  }

  function requestSearchHitMarker(result) {
    const query = normalizeSearchText(result?.query || searchDialog.query)
    if (!query || !result?.pageNumber) {
      setSearchHitMarkers([])
      setSearchHitMarkerRequest(null)
      return
    }

    setSearchHitMarkers([])
    setSearchHitMarkerRequest({
      id: Date.now(),
      query,
      pageNumber: result.pageNumber,
    })
  }

  function clearSearchHitMarkers() {
    if (!searchHitMarkerRequest && searchHitMarkers.length === 0) return

    setSearchHitMarkerRequest(null)
    setSearchHitMarkers([])
  }

  async function openSearchResult(result) {
    closeSearchDialog()

    if (result.source === 'library' && result.document) {
      const opened = await openLibraryDocument(result.document)
      if (!opened) return
    } else {
      setActiveModule('reader')
    }

    if (result.pageNumber) {
      setPageNumber(result.pageNumber)
      setPageJumpInput(String(result.pageNumber))
    }
    requestSearchHitMarker(result)

    if (result.type === 'translation') {
      const restoredResult = restoreHistoryResult(result.item)
      if (restoredResult) {
        setRightPanelResult(restoredResult)
      }
      setRightPanelVisible(true)
      setRightPanelTab('result')
      return
    }

    if (result.type === 'note') {
      setSelectedNoteId(result.item?.id || '')
      setRightPanelVisible(true)
      setRightPanelTab('notes')
      return
    }

    if (result.type === 'annotation') {
      setActiveAnnotationId(result.item?.id || '')
    }
  }

  function handleSearchDialogKeyDown(event) {
    if (event.key === 'Enter' && searchResults[0]) {
      event.preventDefault()
      void openSearchResult(searchResults[0])
    }

    if (event.key === 'Escape') {
      closeSearchDialog()
    }
  }

  function getVisibleLibraryDocuments() {
    const query = librarySearchMode === 'filename' ? librarySearch.trim().toLowerCase() : ''

    return libraryDocuments
      .filter((document) => (
        selectedLibraryFolderId === 'all' ||
        (selectedLibraryFolderId === 'unfiled' ? !document.folderId : document.folderId === selectedLibraryFolderId)
      ))
      .filter((document) => !query || document.fileName.toLowerCase().includes(query))
      .sort((first, second) => {
        if (librarySort === 'progress') {
          return getLibraryProgressPercent(second) - getLibraryProgressPercent(first)
        }
        if (librarySort === 'notes') {
          return (second.notesCount || 0) - (first.notesCount || 0)
        }
        return (second.lastOpenedAt || second.updatedAt || 0) - (first.lastOpenedAt || first.updatedAt || 0)
      })
  }

  async function importLibraryDocuments() {
    if (!window.electronAPI?.importLibraryPdfs) {
      setLibraryStatus('文献库导入仅在桌面版可用')
      return
    }

    try {
      const library = await window.electronAPI.importLibraryPdfs()
      updateLibraryState(library)
      setLibraryStatus(library?.canceled ? '' : '文献已导入文献库')
    } catch (error) {
      setLibraryStatus(error.message || '导入文献失败')
    }
  }

  function openLibraryFolderDialog(parentId = null, editingFolder = null) {
    setLibraryStatus('')
    setLibraryFolderParentId(editingFolder ? (editingFolder.parentId ?? null) : (parentId ?? null))
    setLibraryFolderEditingId(editingFolder?.id || '')
    setLibraryFolderNameDraft(editingFolder?.name || '')
    setLibraryFolderNameError('')
    setLibraryFolderDialogOpen(true)
  }

  function closeLibraryFolderDialog() {
    setLibraryFolderDialogOpen(false)
    setLibraryFolderParentId(null)
    setLibraryFolderEditingId('')
    setLibraryFolderNameDraft('')
    setLibraryFolderNameError('')
  }

  async function confirmCreateLibraryFolder() {
    const name = libraryFolderNameDraft.trim()

    if (!name) {
      setLibraryFolderNameError('文件夹名称不能为空')
      return
    }

    if (libraryFolders.some((folder) => (
      folder.id !== libraryFolderEditingId &&
      (folder.parentId || null) === (libraryFolderParentId || null) &&
      folder.name.trim().toLowerCase() === name.toLowerCase()
    ))) {
      setLibraryFolderNameError('已存在同名文件夹')
      return
    }

    try {
      const library = libraryFolderEditingId
        ? await window.electronAPI.updateLibraryFolder(libraryFolderEditingId, { name })
        : await window.electronAPI.createLibraryFolder({ name, parentId: libraryFolderParentId })
      updateLibraryState(library)
      closeLibraryFolderDialog()
      setLibraryStatus('')
    } catch (error) {
      setLibraryFolderNameError(error.message || (libraryFolderEditingId ? '重命名失败' : '创建失败'))
    }
  }

  function openLibraryFolderContextMenu(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setLibraryContextMenu(null)
    setLibraryMoveDialog(null)
    setLibraryFolderMoveDialog(null)
    setSelectedLibraryFolderId(folder.id)
    setLibraryFolderContextMenu({
      folderId: folder.id,
      x: Math.max(8, Math.min(event.clientX + 2, window.innerWidth - 168)),
      y: Math.max(8, Math.min(event.clientY + 2, window.innerHeight - 174)),
    })
  }

  function createLibrarySubfolder(event, folder) {
    event.preventDefault()
    event.stopPropagation()
    setLibraryFolderContextMenu(null)
    openLibraryFolderDialog(folder.id)
  }

  function openLibraryFolderMoveDialog(folder, position) {
    if (!folder?.id) return

    setLibraryFolderContextMenu(null)
    setLibraryFolderMoveRootExpanded(true)
    setLibraryFolderMoveExpandedIds(new Set())
    setLibraryFolderMoveDialog({
      folderId: folder.id,
      hasTarget: false,
      targetParentId: null,
      x: position?.x ?? Math.min(window.innerWidth - 280, Math.max(24, window.innerWidth / 2 - 132)),
      y: position?.y ?? Math.min(window.innerHeight - 360, Math.max(72, window.innerHeight / 2 - 160)),
    })
  }

  function toggleLibraryFolderMoveExpanded(folderId) {
    setLibraryFolderMoveExpandedIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(folderId)) nextIds.delete(folderId)
      else nextIds.add(folderId)
      return nextIds
    })
  }

  function selectLibraryFolderMoveTarget(parentId) {
    setLibraryFolderMoveDialog((dialog) => (
      dialog ? { ...dialog, hasTarget: true, targetParentId: parentId } : dialog
    ))
  }

  function confirmLibraryFolderMove() {
    if (!libraryFolderMoveDialog?.hasTarget) return
    void moveLibraryFolder(libraryFolderMoveDialog.folderId, libraryFolderMoveDialog.targetParentId)
  }

  function toggleLibraryDocumentSelection(documentId) {
    setSelectedLibraryDocumentIds((currentIds) => (
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId]
    ))
  }

  function openLibraryMoveDialog(documentIds, currentFolderId = '', position = null) {
    const ids = (Array.isArray(documentIds) ? documentIds : []).filter(Boolean)

    if (!ids.length) return

    setLibraryContextMenu(null)
    setLibraryMoveRootExpanded(true)
    setLibraryMoveExpandedIds(new Set())
    setLibraryMoveDialog({
      documentIds: ids,
      currentFolderId,
      targetFolderId: '',
      hasTarget: false,
      x: position?.x ?? Math.min(window.innerWidth - 260, Math.max(24, window.innerWidth / 2 - 120)),
      y: position?.y ?? Math.min(window.innerHeight - 260, Math.max(72, window.innerHeight / 2 - 120)),
    })
  }

  function toggleLibraryMoveExpanded(folderId) {
    setLibraryMoveExpandedIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(folderId)) nextIds.delete(folderId)
      else nextIds.add(folderId)
      return nextIds
    })
  }

  function selectLibraryMoveTarget(folderId) {
    setLibraryMoveDialog((dialog) => (
      dialog ? { ...dialog, hasTarget: true, targetFolderId: folderId } : dialog
    ))
  }

  function confirmLibraryDocumentMove() {
    if (!libraryMoveDialog?.hasTarget) return
    void moveLibraryDocuments(libraryMoveDialog.documentIds, libraryMoveDialog.targetFolderId)
  }

  async function moveLibraryDocuments(documentIds, folderId) {
    if (!documentIds.length) return

    try {
      const library = await window.electronAPI.moveLibraryDocuments(documentIds, folderId)
      updateLibraryState(library)
      setLibraryContextMenu(null)
      setLibraryMoveDialog(null)
      setLibraryStatus(`已移动到${getLibraryFolderName(folderId)}`)
    } catch (error) {
      setLibraryStatus(error.message || '移动文献失败')
    }
  }

  async function toggleLibraryFolderExpanded(folder) {
    try {
      const library = await window.electronAPI.updateLibraryFolder(folder.id, { expanded: folder.expanded === false })
      updateLibraryState(library)
      setLibraryStatus('')
    } catch (error) {
      setLibraryStatus(error.message || '更新文件夹失败')
    }
  }

  async function reorderLibraryFolder(folderId, targetFolderId, placement) {
    try {
      const library = await window.electronAPI.reorderLibraryFolder(folderId, targetFolderId, placement)
      updateLibraryState(library)
      setLibraryStatus('')
    } catch (error) {
      setLibraryStatus(error.message || '调整文件夹顺序失败')
    }
  }

  async function moveLibraryFolder(folderId, parentId) {
    try {
      const library = await window.electronAPI.moveLibraryFolder(folderId, parentId)
      updateLibraryState(library)
      setLibraryFolderMoveDialog(null)
      setLibraryStatus('')
    } catch (error) {
      setLibraryStatus(error.message || '移动文件夹失败')
    }
  }

  function beginLibraryFolderDrag(event, folder) {
    if (event.target.closest('button')) {
      event.preventDefault()
      return
    }

    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', folder.id)
    setDraggedLibraryFolderId(folder.id)
    setLibraryFolderDropTarget(null)
  }

  function updateLibraryFolderDragTarget(event, folder) {
    const draggedFolder = libraryFolders.find((item) => item.id === draggedLibraryFolderId)
    if (!draggedFolder || draggedFolder.id === folder.id || draggedFolder.parentId !== folder.parentId) return

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const bounds = event.currentTarget.getBoundingClientRect()
    setLibraryFolderDropTarget({
      folderId: folder.id,
      placement: event.clientY >= bounds.top + bounds.height / 2 ? 'after' : 'before',
    })
  }

  function endLibraryFolderDrag() {
    setDraggedLibraryFolderId('')
    setLibraryFolderDropTarget(null)
  }

  function dropLibraryFolder(event, folder) {
    const target = libraryFolderDropTarget
    const draggedFolder = libraryFolders.find((item) => item.id === draggedLibraryFolderId)
    if (!target || target.folderId !== folder.id || !draggedFolder || draggedFolder.parentId !== folder.parentId) {
      endLibraryFolderDrag()
      return
    }

    event.preventDefault()
    const { folderId, placement } = target
    const draggedFolderId = draggedFolder.id
    endLibraryFolderDrag()
    void reorderLibraryFolder(draggedFolderId, folderId, placement)
  }

  async function deleteLibraryFolder(folder) {
    if (!folder?.id) return

    if (!window.electronAPI?.deleteLibraryFolder) {
      setLibraryStatus('\u5220\u9664\u6587\u4ef6\u5939\u4ec5\u5728\u684c\u9762\u7248\u53ef\u7528')
      return
    }

    const removedFolderIds = getLibraryDescendantFolderIds(folder.id)
    const folderDocumentCount = getLibraryFolderDocumentCount(folder.id, true)
    const childFolderCount = Math.max(0, removedFolderIds.size - 1)
    const wasSelectedFolder = removedFolderIds.has(selectedLibraryFolderId)
    const childFolderText = childFolderCount ? `及其 ${childFolderCount} 个子文件夹` : ''
    const confirmMessage = folderDocumentCount
      ? `确定删除项目文件夹 "${folder.name}"${childFolderText}吗？其中 ${folderDocumentCount} 篇文献会移到未分类，不会删除 PDF 文件和已有笔记/批注。`
      : `确定删除项目文件夹 "${folder.name}"${childFolderText}吗？`

    if (!window.confirm(confirmMessage)) return

    try {
      const library = await window.electronAPI.deleteLibraryFolder(folder.id)
      updateLibraryState(library)
      if (wasSelectedFolder) setSelectedLibraryFolderId('unfiled')
      setSelectedLibraryDocumentIds([])
      setLibraryStatus('')
    } catch (error) {
      setLibraryStatus(error.message || '\u5220\u9664\u6587\u4ef6\u5939\u5931\u8d25')
    }
  }

  function deleteLibraryDocuments(documentIds = selectedLibraryDocumentIds) {
    if (!documentIds.length) return
    setLibraryContextMenu(null)
    setLibraryDeleteDialog({ documentIds: [...documentIds] })
  }

  async function renameLibraryDocument(document) {
    const currentName = document?.displayName || document?.fileName || ''
    const displayName = window.prompt('重命名文献', currentName)?.trim()
    if (!displayName || displayName === currentName) return
    try {
      const library = await window.electronAPI.updateLibraryDocument(document.documentId, { displayName })
      updateLibraryState(library)
      setLibraryContextMenu(null)
      setLibraryStatus('文献已重命名')
      await loadExportSettingsData()
    } catch (error) {
      setLibraryStatus(error.message || '重命名文献失败')
    }
  }

  async function confirmDeleteLibraryDocuments(mode) {
    const documentIds = libraryDeleteDialog?.documentIds || []
    if (!documentIds.length) return
    try {
      const library = await window.electronAPI.deleteLiterature(documentIds, mode)
      updateLibraryState(library)
      setSelectedLibraryDocumentIds([])
      setLibraryContextMenu(null)
      setLibraryDeleteDialog(null)
      setLibraryStatus(mode === 'permanent' ? '已删除文献及记录' : '已移入回收箱')
      await loadExportSettingsData()
    } catch (error) {
      setLibraryStatus(error.message || '删除文献失败')
    }
  }

  async function restoreRecycledDocuments(documentIds) {
    try {
      const library = await window.electronAPI.restoreLibraryDocuments(documentIds)
      updateLibraryState(library)
      setHistorySelectedRecycleIds([])
      setExportStatus('已恢复')
      await loadExportSettingsData()
    } catch (error) {
      setExportStatus(error.message || '恢复失败')
    }
  }

  async function permanentlyDeleteRecycledDocuments(documentIds) {
    if (!documentIds.length) return
    setPermanentDeleteDialogIds([...documentIds])
  }

  async function confirmPermanentlyDeleteRecycledDocuments() {
    const documentIds = permanentDeleteDialogIds
    if (!documentIds.length) return
    try {
      const library = await window.electronAPI.permanentlyDeleteLibraryDocuments(documentIds)
      updateLibraryState(library)
      setHistorySelectedRecycleIds([])
      setPermanentDeleteDialogIds([])
      setExportStatus('已永久删除')
      await loadExportSettingsData()
    } catch (error) {
      setExportStatus(error.message || '永久删除失败')
    }
  }

  async function openLibraryDocument(document) {
    if (!document?.filePath) return false

    const existingTab = pdfTabs.find((tab) =>
      tab.documentId === document.documentId ||
      (document.filePath && tab.filePath === document.filePath),
    )

    if (existingTab) {
      setActiveModule('reader')
      activatePdfTab(existingTab.id)
      return true
    }

    if (!window.electronAPI?.openPdfFromPath) {
      setLibraryStatus('当前环境无法从路径打开 PDF')
      return false
    }

    try {
      const pdfFile = await window.electronAPI.openPdfFromPath(document.filePath)
      setActiveModule('reader')
      applyOpenedPdf(pdfFile, {
        ...document,
        id: document.documentId,
        lastPage: document.lastPage || 1,
        totalPages: document.totalPages || null,
        scale: document.scale || zoomPercent,
        lastOpenedAt: document.lastOpenedAt || Date.now(),
      })
      return true
    } catch (error) {
      setLibraryStatus(error.message || '文件不存在或已移动')
      return false
    }
  }

  function openLibraryContextMenu(event, document) {
    event.preventDefault()
    setLibraryContextMenu({
      documentId: document.documentId,
      x: Math.min(event.clientX + 2, window.innerWidth - 220),
      y: Math.min(event.clientY + 2, window.innerHeight - 180),
      folderId: document.folderId || '',
    })
  }

  function normalizeSettings(config = {}) {
    const rawProvider = String(config.provider || '').trim()
    const provider = normalizeProviderKey(rawProvider)
    const providerDefaults = PROVIDERS[provider]

    return {
      provider,
      apiKey: config.apiKey || config.deepseekApiKey || '',
      baseUrl: config.baseUrl || config.deepseekBaseUrl || providerDefaults.baseUrl,
      model: config.model || config.deepseekModel || providerDefaults.model,
      modelSupportsMultimodal:
        typeof config.modelSupportsMultimodal === 'boolean'
          ? config.modelSupportsMultimodal
          : null,
      temperatureMode: config.temperatureMode === 'custom' ? 'custom' : 'auto',
      temperature: Number.isFinite(Number(config.temperature))
        ? clampNumber(Number(config.temperature), 0, 2)
        : DEFAULT_SETTINGS.temperature,
      prompt: config.prompt || DEFAULT_TRANSLATION_PROMPT,
      enableMultimodalTranslation: config.enableMultimodalTranslation === true,
      rightPanelWidth: clampNumber(
        Number(config.rightPanelWidth) || DEFAULT_SETTINGS.rightPanelWidth,
        MIN_RIGHT_PANEL_WIDTH,
        MAX_RIGHT_PANEL_WIDTH,
      ),
      exportDefaultDir: String(config.exportDefaultDir || '').trim(),
    }
  }

  function updateGlossaryState(nextGlossary) {
    setGlossary(nextGlossary)
    setGlossaryStatus(nextGlossary.length ? `已导入 ${nextGlossary.length} 条术语` : '未导入术语库')
  }

  async function loadSettingsData() {
    setSettingsStatus('')

    if (!window.electronAPI) {
      setSettingsForm(DEFAULT_SETTINGS)
      return
    }

    try {
      const config = await window.electronAPI.getConfig()
      const normalizedConfig = normalizeSettings(config)
      setSettingsForm(normalizedConfig)
      setRightPanelWidth(normalizedConfig.rightPanelWidth)
      const savedGlossary = window.electronAPI.getGlossary
        ? await window.electronAPI.getGlossary()
        : []
      updateGlossaryState(savedGlossary)
    } catch (error) {
      setSettingsStatus(`${UI.settingsLoadError}：${error.message}`)
    }
  }

  function switchModule(moduleName) {
    setActiveModule(moduleName)

    if (moduleName === 'settings') {
      setSettingsTab((currentTab) => (currentTab === 'importExport' ? 'model' : currentTab))
      void loadSettingsData()
      return
    }

    if (moduleName === 'importExport') {
      setSettingsTab('importExport')
      void Promise.all([loadSettingsData(), loadExportSettingsData(), refreshLibrary()])
      return
    }

    if (moduleName === 'library') {
      void refreshLibrary()
    }
  }

  function updateSettingsField(field, value) {
    setSettingsForm((currentSettings) => ({
      ...currentSettings,
      [field]: value,
    }))
  }

  function updateSettingsModel(modelId) {
    const normalizedModelId = String(modelId || '')
    const modelMetadata = availableModels.find((model) => model.id === normalizedModelId)

    setSettingsForm((currentSettings) => ({
      ...currentSettings,
      model: normalizedModelId,
      modelSupportsMultimodal:
        typeof modelMetadata?.supportsMultimodal === 'boolean'
          ? modelMetadata.supportsMultimodal
          : null,
    }))
  }

  function updateSettingsProvider(provider) {
    const nextProvider = normalizeProviderKey(provider)

    setSettingsForm((currentSettings) => ({
      ...currentSettings,
      provider: nextProvider,
      baseUrl: PROVIDERS[nextProvider].baseUrl,
      apiKey: '',
      model: '',
      modelSupportsMultimodal: null,
      temperatureMode: 'auto',
      temperature: DEFAULT_SETTINGS.temperature,
      enableMultimodalTranslation:
        currentSettings.enableMultimodalTranslation && PROVIDERS[nextProvider].supportsMultimodal,
    }))
  }

  function resetPrompt() {
    updateSettingsField('prompt', DEFAULT_TRANSLATION_PROMPT)
  }

  async function importGlossary() {
    if (!window.electronAPI?.importGlossary) {
      setGlossaryStatus('术语库导入功能仅在桌面版可用')
      return
    }

    try {
      const result = await window.electronAPI.importGlossary()

      if (result.canceled) return

      updateGlossaryState(result.glossary || [])
      setSettingsStatus(`已导入 ${result.count} 条术语`)
    } catch (error) {
      setGlossaryStatus(error.message || '导入术语库失败')
    }
  }

  async function clearGlossary() {
    if (!window.electronAPI?.clearGlossary) {
      setGlossaryStatus('术语库导入功能仅在桌面版可用')
      return
    }

    try {
      const nextGlossary = await window.electronAPI.clearGlossary()
      updateGlossaryState(nextGlossary || [])
      setIsGlossaryVisible(false)
    } catch (error) {
      setGlossaryStatus(error.message || '清空术语库失败')
    }
  }

  async function saveSettings(event) {
    event.preventDefault()

    if (!window.electronAPI) {
      setSettingsStatus(UI.settingsDesktopOnly)
      return
    }

    if (settingsForm.temperatureMode === 'custom') {
      const temperature = Number(settingsForm.temperature)
      if (
        String(settingsForm.temperature).trim() === '' ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2
      ) {
        setSettingsStatus('Temperature 必须是 0 到 2 之间的数字')
        return
      }
    }

    setIsSavingSettings(true)
    setSettingsStatus('')

    try {
      const savedConfig = await window.electronAPI.saveConfig({
        ...settingsForm,
        provider: normalizeProviderKey(settingsForm.provider),
        enableMultimodalTranslation: settingsSupportMultimodal(settingsForm),
        rightPanelWidth,
      })
      setSettingsForm(normalizeSettings(savedConfig))
      setSettingsStatus(UI.settingsSaved)
    } catch (error) {
      setSettingsStatus(`${UI.settingsSaveError}：${error.message}`)
    } finally {
      setIsSavingSettings(false)
    }
  }

  function handleDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages)
    updateActivePdfTabSnapshot({ totalPages: numPages })

    const restoreRecord = pendingReadingRestoreRef.current

    if (restoreRecord) {
      const restoredPage = clampNumber(Number(restoreRecord.lastPage) || 1, 1, numPages)
      const restoredScale = clampNumber(Number(restoreRecord.scale) || 100, MIN_ZOOM, MAX_ZOOM)
      const restoredWidth = clampNumber(
        Number(restoreRecord.rightPanelWidth) || DEFAULT_SETTINGS.rightPanelWidth,
        MIN_RIGHT_PANEL_WIDTH,
        MAX_RIGHT_PANEL_WIDTH,
      )

      setPageNumber(restoredPage)
      setPageJumpInput(String(restoredPage))
      setZoomPercent(restoredScale)
      setZoomInput(String(restoredScale))
      setRightPanelWidth(restoredWidth)
      setRightPanelVisible(restoreRecord.rightPanelVisible !== false)
      pendingReadingRestoreRef.current = null
      void saveCurrentReadingRecord({
        totalPages: numPages,
        lastPage: restoredPage,
        scale: restoredScale,
        rightPanelWidth: restoredWidth,
        rightPanelVisible: restoreRecord.rightPanelVisible !== false,
      })
    } else {
      setPageNumber((currentPage) => {
        const nextPage = clampNumber(Number(currentPage) || 1, 1, numPages)
        if (nextPage !== currentPage) {
          setPageJumpInput(String(nextPage))
        }
        return nextPage
      })
      void saveCurrentReadingRecord({ totalPages: numPages })
    }
  }

  function handlePageLoadSuccess(page) {
    if (page.originalWidth && page.originalHeight) {
      const nextRatio = page.originalWidth / page.originalHeight

      setPageRatio((currentRatio) => {
        if (Math.abs(currentRatio - nextRatio) < 0.001) {
          return currentRatio
        }

        return nextRatio
      })
    }
  }

  function getRangeTextInsideNode(range, node) {
    try {
      if (!range.intersectsNode(node)) return ''

      const nodeRange = document.createRange()
      nodeRange.selectNodeContents(node)

      const intersectionRange = document.createRange()

      if (range.compareBoundaryPoints(Range.START_TO_START, nodeRange) > 0) {
        intersectionRange.setStart(range.startContainer, range.startOffset)
      } else {
        intersectionRange.setStart(nodeRange.startContainer, nodeRange.startOffset)
      }

      if (range.compareBoundaryPoints(Range.END_TO_END, nodeRange) < 0) {
        intersectionRange.setEnd(range.endContainer, range.endOffset)
      } else {
        intersectionRange.setEnd(nodeRange.endContainer, nodeRange.endOffset)
      }

      return intersectionRange.toString()
    } catch {
      return ''
    }
  }

  function normalizeScriptText(text) {
    const scriptMap = {
      '\u2070': '0',
      '\u00b9': '1',
      '\u00b2': '2',
      '\u00b3': '3',
      '\u2074': '4',
      '\u2075': '5',
      '\u2076': '6',
      '\u2077': '7',
      '\u2078': '8',
      '\u2079': '9',
      '\u207b': '-',
      '\u2080': '0',
      '\u2081': '1',
      '\u2082': '2',
      '\u2083': '3',
      '\u2084': '4',
      '\u2085': '5',
      '\u2086': '6',
      '\u2087': '7',
      '\u2088': '8',
      '\u2089': '9',
      '\u208b': '-',
    }

    return Array.from(text)
      .map((character) => scriptMap[character] || character)
      .join('')
  }

  function median(values) {
    if (!values.length) return 0

    const sortedValues = [...values].sort((firstValue, secondValue) => firstValue - secondValue)
    const middleIndex = Math.floor(sortedValues.length / 2)

    if (sortedValues.length % 2) return sortedValues[middleIndex]

    return (sortedValues[middleIndex - 1] + sortedValues[middleIndex]) / 2
  }

  function getTokenKind(token, lineTokens) {
    const tallestTokenHeight = Math.max(...lineTokens.map((lineToken) => lineToken.height))
    const mainTokens = lineTokens.filter((lineToken) => lineToken.height >= tallestTokenHeight * 0.85)

    if (token.height > tallestTokenHeight * 0.85 || mainTokens.length === 0) {
      return 'normal'
    }

    const mainTop = median(mainTokens.map((lineToken) => lineToken.top))
    const mainBottom = median(mainTokens.map((lineToken) => lineToken.bottom))
    const mainCenter = (mainTop + mainBottom) / 2
    const tokenCenter = (token.top + token.bottom) / 2

    if (token.top < mainTop - tallestTokenHeight * 0.08 || tokenCenter < mainCenter - tallestTokenHeight * 0.18) {
      return 'superscript'
    }

    if (
      token.bottom > mainBottom + tallestTokenHeight * 0.08 ||
      tokenCenter > mainCenter + tallestTokenHeight * 0.18
    ) {
      return 'subscript'
    }

    return 'normal'
  }

  function groupTokensByLine(tokens) {
    const lines = []

    tokens.forEach((token) => {
      const tokenCenter = (token.top + token.bottom) / 2
      const matchingLine = lines.find((line) => {
        const tolerance = Math.max(6, line.maxHeight * 0.55, token.height * 0.8)

        return Math.abs(tokenCenter - line.center) <= tolerance
      })

      if (matchingLine) {
        matchingLine.tokens.push(token)
        matchingLine.top = Math.min(matchingLine.top, token.top)
        matchingLine.bottom = Math.max(matchingLine.bottom, token.bottom)
        matchingLine.maxHeight = Math.max(matchingLine.maxHeight, token.height)
        matchingLine.center = (matchingLine.top + matchingLine.bottom) / 2
        return
      }

      lines.push({
        top: token.top,
        bottom: token.bottom,
        center: tokenCenter,
        maxHeight: token.height,
        tokens: [token],
      })
    })

    return lines.sort((firstLine, secondLine) => firstLine.top - secondLine.top)
  }

  function renderFormattedLine(lineTokens) {
    const sortedTokens = [...lineTokens].sort((firstToken, secondToken) => firstToken.left - secondToken.left)
    const segments = []

    sortedTokens.forEach((token) => {
      const kind = getTokenKind(token, sortedTokens)
      const text = kind === 'normal' ? token.text : normalizeScriptText(token.text)
      const previousSegment = segments[segments.length - 1]
      const gap = previousSegment ? token.left - previousSegment.right : 0
      const shouldMergeScript =
        previousSegment &&
        previousSegment.kind === kind &&
        kind !== 'normal' &&
        gap < Math.max(token.height, previousSegment.height) * 0.8

      if (shouldMergeScript) {
        previousSegment.text += text
        previousSegment.right = Math.max(previousSegment.right, token.right)
        previousSegment.height = Math.max(previousSegment.height, token.height)
        return
      }

      segments.push({
        kind,
        text,
        left: token.left,
        right: token.right,
        height: token.height,
        hasLeadingSpace:
          previousSegment &&
          kind === 'normal' &&
          token.left - previousSegment.right > Math.max(token.height, previousSegment.height) * 0.25,
      })
    })

    return segments
      .map((segment) => {
        const leadingSpace = segment.hasLeadingSpace ? ' ' : ''

        if (segment.kind === 'superscript') {
          return `${leadingSpace}^{${segment.text}}`
        }

        if (segment.kind === 'subscript') {
          return `${leadingSpace}_{${segment.text}}`
        }

        return `${leadingSpace}${segment.text}`
      })
      .join('')
  }

  function getFormattedSelectionText(selection, fallbackText) {
    if (!selection?.rangeCount || !pdfViewerRef.current) {
      return fallbackText
    }

    const range = selection.getRangeAt(0)
    const selectedSpans = Array.from(
      pdfViewerRef.current.querySelectorAll('.textLayer span, .react-pdf__Page__textContent span'),
    )
      .map((span) => {
        const text = getRangeTextInsideNode(range, span).trim()

        if (!text) return null

        const rect = span.getBoundingClientRect()
        const style = window.getComputedStyle(span)
        const fontSize = Number.parseFloat(style.fontSize) || rect.height

        return {
          text,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          height: Math.max(rect.height, fontSize),
        }
      })
      .filter(Boolean)

    if (selectedSpans.length < 2) {
      return fallbackText
    }

    const lines = groupTokensByLine(
      selectedSpans.sort((firstToken, secondToken) => firstToken.top - secondToken.top || firstToken.left - secondToken.left),
    )
    const formattedText = lines.map((line) => renderFormattedLine(line.tokens)).join('\n').trim()

    if (!formattedText || !/[{}_^]/.test(formattedText)) {
      return fallbackText
    }

    return formattedText
  }

  function normalizeSelectionRects(rects, options = {}) {
    const eps = options.eps ?? 1
    const sameLineThreshold = options.sameLineThreshold ?? 4
    const mergeGapThreshold = options.mergeGapThreshold ?? 3

    const validRects = (Array.isArray(rects) ? rects : [])
      .map((rect) => {
        const left = Number(rect.left)
        const top = Number(rect.top)
        const width = Number(rect.width)
        const height = Number(rect.height)

        if (![left, top, width, height].every(Number.isFinite) || width <= eps || height <= eps) {
          return null
        }

        return {
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
        }
      })
      .filter(Boolean)
      .sort((firstRect, secondRect) => firstRect.top - secondRect.top || firstRect.left - secondRect.left)

    const uniqueRects = []

    validRects.forEach((rect) => {
      const duplicate = uniqueRects.some((item) =>
        Math.abs(item.left - rect.left) <= eps &&
        Math.abs(item.top - rect.top) <= eps &&
        Math.abs(item.width - rect.width) <= eps &&
        Math.abs(item.height - rect.height) <= eps,
      )

      if (!duplicate) {
        uniqueRects.push(rect)
      }
    })

    const lines = []

    uniqueRects.forEach((rect) => {
      const rectCenter = rect.top + rect.height / 2
      const line = lines.find((item) => {
        const lineCenter = item.top + (item.bottom - item.top) / 2
        const tolerance = Math.max(sameLineThreshold, Math.min(item.height, rect.height) * 0.45)

        return Math.abs(rectCenter - lineCenter) <= tolerance
      })

      if (line) {
        line.rects.push(rect)
        line.top = Math.min(line.top, rect.top)
        line.bottom = Math.max(line.bottom, rect.bottom)
        line.height = Math.max(line.height, rect.height)
        return
      }

      lines.push({
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        rects: [rect],
      })
    })

    return lines
      .sort((firstLine, secondLine) => firstLine.top - secondLine.top)
      .flatMap((line) => {
        const sortedRects = line.rects.sort((firstRect, secondRect) => firstRect.left - secondRect.left)
        const mergedRects = []

        sortedRects.forEach((rect) => {
          const previous = mergedRects[mergedRects.length - 1]

          if (!previous) {
            mergedRects.push({ ...rect })
            return
          }

          const overlapWidth = Math.min(previous.right, rect.right) - Math.max(previous.left, rect.left)
          const isAdjacent = rect.left <= previous.right + mergeGapThreshold
          const heavilyOverlaps = overlapWidth > Math.min(previous.width, rect.width) * 0.55

          if (isAdjacent || heavilyOverlaps) {
            previous.left = Math.min(previous.left, rect.left)
            previous.top = Math.min(previous.top, rect.top)
            previous.right = Math.max(previous.right, rect.right)
            previous.bottom = Math.max(previous.bottom, rect.bottom)
            previous.width = previous.right - previous.left
            previous.height = previous.bottom - previous.top
            return
          }

          mergedRects.push({ ...rect })
        })

        return mergedRects.map((rect) => ({
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }))
      })
  }

  function arePageRectsNearlyEqual(firstRects = [], secondRects = []) {
    const eps = 0.003

    if (firstRects.length !== secondRects.length) return false

    return firstRects.every((firstRect, index) => {
      const secondRect = secondRects[index]
      if (!secondRect) return false

      return (
        Math.abs(Number(firstRect.x) - Number(secondRect.x)) <= eps &&
        Math.abs(Number(firstRect.y) - Number(secondRect.y)) <= eps &&
        Math.abs(Number(firstRect.width) - Number(secondRect.width)) <= eps &&
        Math.abs(Number(firstRect.height) - Number(secondRect.height)) <= eps
      )
    })
  }

  function hasDuplicateHighlight(selectedHighlightText, rects) {
    return documentAnnotations.some((item) =>
      item.type === 'text-highlight' &&
      item.pageNumber === pageNumber &&
      item.selectedText === selectedHighlightText &&
      arePageRectsNearlyEqual(item.rects || [], rects),
    )
  }

  function getSelectionHighlightRects(selection) {
    if (!selection.rangeCount || !pdfViewerRef.current) {
      return []
    }

    const range = selection.getRangeAt(0)
    const viewerRect = pdfViewerRef.current.getBoundingClientRect()

    const rawRects = Array.from(range.getClientRects())
      .map((rect) => {
        const left = Math.max(rect.left, viewerRect.left)
        const right = Math.min(rect.right, viewerRect.right)
        const top = Math.max(rect.top, viewerRect.top)
        const bottom = Math.min(rect.bottom, viewerRect.bottom)
        const width = right - left
        const height = bottom - top

        if (width <= 0 || height <= 0) return null

        const highlightHeight = Math.max(2, height * 0.68)

        return {
          left: left - viewerRect.left + pdfViewerRef.current.scrollLeft,
          top:
            top -
            viewerRect.top +
            pdfViewerRef.current.scrollTop +
            (height - highlightHeight) / 2,
          width,
          height: highlightHeight,
        }
      })
      .filter(Boolean)

    return normalizeSelectionRects(rawRects)
  }

  function updateSelectionHighlights() {
    if (annotationInteractionSuspendedRef.current) {
      setHighlightRects([])
      setPreviewHighlight(null)
      return
    }

    const selection = window.getSelection()

    if (!selection || selection.isCollapsed) {
      setHighlightRects([])
      setPreviewHighlight(null)
      return
    }

    const nextHighlightRects = getSelectionHighlightRects(selection)
    setHighlightRects(nextHighlightRects)

    if (annotationColor && currentDocument?.documentId && isSelectingRef.current) {
      const selectedText = selection.toString().trim()
      const pageBox = getCurrentPageBox()
      const rects = nextHighlightRects
        .map((rect) => normalizeViewerRectToPage(rect, pageBox))
        .filter(Boolean)

      if (selectedText && rects.length) {
        setPreviewHighlight({
          pageNumber,
          selectedText,
          color: normalizeHighlightColor(annotationColor),
          rects,
        })
        return
      }
    }

    setPreviewHighlight(null)
  }

  function scheduleSelectionHighlightUpdate() {
    if (selectionFrameRef.current) return

    selectionFrameRef.current = requestAnimationFrame(() => {
      selectionFrameRef.current = null
      updateSelectionHighlights()
    })
  }

  function getViewerPoint(event) {
    const viewerRect = pdfViewerRef.current.getBoundingClientRect()

    return {
      x: event.clientX - viewerRect.left + pdfViewerRef.current.scrollLeft,
      y: event.clientY - viewerRect.top + pdfViewerRef.current.scrollTop,
    }
  }

  function getRectFromPoints(startPoint, endPoint) {
    return {
      left: Math.min(startPoint.x, endPoint.x),
      top: Math.min(startPoint.y, endPoint.y),
      width: Math.abs(endPoint.x - startPoint.x),
      height: Math.abs(endPoint.y - startPoint.y),
    }
  }

  function getCurrentPageBox() {
    const pdfViewer = pdfViewerRef.current
    const page = pdfViewer?.querySelector('.react-pdf__Page')

    if (!pdfViewer || !page) return null

    const viewerRect = pdfViewer.getBoundingClientRect()
    const pageRect = page.getBoundingClientRect()

    return {
      left: pageRect.left - viewerRect.left + pdfViewer.scrollLeft,
      top: pageRect.top - viewerRect.top + pdfViewer.scrollTop,
      width: pageRect.width,
      height: pageRect.height,
    }
  }

  function normalizeViewerRectToPage(rect, pageBox = getCurrentPageBox()) {
    if (!pageBox || !rect) return null

    const x = (rect.left - pageBox.left) / pageBox.width
    const y = (rect.top - pageBox.top) / pageBox.height
    const width = rect.width / pageBox.width
    const height = rect.height / pageBox.height

    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null

    return {
      x: clampNumber(x, 0, 1),
      y: clampNumber(y, 0, 1),
      width: clampNumber(width, 0, 1),
      height: clampNumber(height, 0, 1),
    }
  }

  function denormalizePageRect(rect, pageBox = getCurrentPageBox()) {
    if (!pageBox || !rect) return null

    return {
      left: pageBox.left + rect.x * pageBox.width,
      top: pageBox.top + rect.y * pageBox.height,
      width: rect.width * pageBox.width,
      height: rect.height * pageBox.height,
    }
  }

  function normalizeHighlightColor(color) {
    const rawColor = String(color || '').trim()
    const colorByName = HIGHLIGHT_COLORS.find((item) => item.name === rawColor || item.label === rawColor)

    if (colorByName) {
      return colorByName.color
    }

    if (/^#[\da-f]{6}$/i.test(rawColor)) {
      return rawColor.toUpperCase()
    }

    if (/^[\da-f]{6}$/i.test(rawColor)) {
      return `#${rawColor.toUpperCase()}`
    }

    if (/^rgba?\(/i.test(rawColor)) {
      return rawColor
    }

    return DEFAULT_HIGHLIGHT_COLOR
  }

  function hexToRgba(color, opacity = HIGHLIGHT_OPACITY) {
    const normalizedColor = normalizeHighlightColor(color)

    if (/^rgba?\(/i.test(normalizedColor)) {
      return normalizedColor.replace(
        /rgba?\(([^)]+)\)/i,
        (_match, value) => {
          const parts = value.split(',').map((part) => part.trim()).slice(0, 3)
          return `rgba(${parts.join(', ')}, ${opacity})`
        },
      )
    }

    const normalizedHex = normalizedColor.replace('#', '').trim()

    if (!/^[\da-f]{6}$/i.test(normalizedHex)) {
      return `rgba(255, 255, 0, ${opacity})`
    }

    const red = Number.parseInt(normalizedHex.slice(0, 2), 16)
    const green = Number.parseInt(normalizedHex.slice(2, 4), 16)
    const blue = Number.parseInt(normalizedHex.slice(4, 6), 16)

    return `rgba(${red}, ${green}, ${blue}, ${opacity})`
  }

  function getHighlightRgb(color) {
    const rgbaColor = hexToRgba(color, 1)
    const match = rgbaColor.match(/rgba?\(([^)]+)\)/i)

    if (!match) return '255, 255, 0'

    return match[1].split(',').map((part) => part.trim()).slice(0, 3).join(', ')
  }

  function getHighlightStyle(color, options = {}) {
    const normalizedColor = normalizeHighlightColor(color)
    const opacity = options.opacity ?? HIGHLIGHT_COLOR_OPACITY[normalizedColor] ?? HIGHLIGHT_OPACITY
    return {
      '--highlight-rgb': getHighlightRgb(normalizedColor),
      '--highlight-opacity': opacity,
      '--highlight-hover-opacity': HIGHLIGHT_HOVER_OPACITY,
      backgroundColor: `rgba(var(--highlight-rgb), var(--highlight-opacity))`,
    }
  }

  function suppressHighlightTintOnCanvas(canvas) {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return ''

    let imageData

    try {
      imageData = context.getImageData(0, 0, canvas.width, canvas.height)
    } catch {
      return ''
    }

    const { data } = imageData
    let changedPixels = 0

    for (let index = 0; index < data.length; index += 4) {
      const red = data[index]
      const green = data[index + 1]
      const blue = data[index + 2]
      const alpha = data[index + 3]
      if (alpha < 16) continue

      const maxChannel = Math.max(red, green, blue)
      const minChannel = Math.min(red, green, blue)
      const saturation = maxChannel - minChannel
      const brightness = red * 0.299 + green * 0.587 + blue * 0.114
      const isDarkInk = brightness < 105 && maxChannel < 150
      const isLikelyHighlight =
        !isDarkInk &&
        brightness > 135 &&
        saturation > 34 &&
        (
          (red > 185 && green > 165 && blue < 175) ||
          (green > 170 && blue > 150 && red < 210) ||
          (green > 170 && red < 180) ||
          (red > 190 && blue > 165 && green < 190)
        )

      if (!isLikelyHighlight) continue

      data[index] = Math.min(255, Math.round(red * 0.16 + 255 * 0.84))
      data[index + 1] = Math.min(255, Math.round(green * 0.16 + 255 * 0.84))
      data[index + 2] = Math.min(255, Math.round(blue * 0.16 + 255 * 0.84))
      changedPixels += 1
    }

    if (!changedPixels) return ''

    context.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  }

  function cropOcrImage(rect, options = {}) {
    const pdfViewer = pdfViewerRef.current
    const canvas = pdfViewer?.querySelector('.react-pdf__Page canvas')

    if (!pdfViewer || !canvas) {
      throw new Error('未找到 PDF 页面画布。')
    }

    const viewerRect = pdfViewer.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const padding = Math.max(0, Number(options.padding) || 0)
    const rectInViewport = {
      left: viewerRect.left - pdfViewer.scrollLeft + rect.left - padding,
      top: viewerRect.top - pdfViewer.scrollTop + rect.top - padding,
      right: viewerRect.left - pdfViewer.scrollLeft + rect.left + rect.width + padding,
      bottom: viewerRect.top - pdfViewer.scrollTop + rect.top + rect.height + padding,
    }
    const cropRect = {
      left: Math.max(rectInViewport.left, canvasRect.left),
      top: Math.max(rectInViewport.top, canvasRect.top),
      right: Math.min(rectInViewport.right, canvasRect.right),
      bottom: Math.min(rectInViewport.bottom, canvasRect.bottom),
    }
    const cropWidth = cropRect.right - cropRect.left
    const cropHeight = cropRect.bottom - cropRect.top

    if (cropWidth < 8 || cropHeight < 8) {
      throw new Error('框选区域太小，请重新选择。')
    }

    const scaleX = canvas.width / canvasRect.width
    const scaleY = canvas.height / canvasRect.height
    const sourceX = Math.max(0, Math.floor((cropRect.left - canvasRect.left) * scaleX))
    const sourceY = Math.max(0, Math.floor((cropRect.top - canvasRect.top) * scaleY))
    const sourceWidth = Math.min(canvas.width - sourceX, Math.ceil(cropWidth * scaleX))
    const sourceHeight = Math.min(canvas.height - sourceY, Math.ceil(cropHeight * scaleY))
    const outputCanvas = document.createElement('canvas')

    outputCanvas.width = sourceWidth
    outputCanvas.height = sourceHeight
    outputCanvas
      .getContext('2d')
      .drawImage(canvas, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight)
    const image = outputCanvas.toDataURL('image/png')
    const cleanedCanvas = document.createElement('canvas')

    cleanedCanvas.width = outputCanvas.width
    cleanedCanvas.height = outputCanvas.height
    cleanedCanvas.getContext('2d')?.drawImage(outputCanvas, 0, 0)

    return {
      image,
      ocrImage: suppressHighlightTintOnCanvas(cleanedCanvas) || image,
      width: outputCanvas.width,
      height: outputCanvas.height,
      originalImageWidth: outputCanvas.width,
      originalImageHeight: outputCanvas.height,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      scaleX,
      scaleY,
    }
  }

  function cropSelectionRectsImage(rects = []) {
    const pdfViewer = pdfViewerRef.current
    const canvas = pdfViewer?.querySelector('.react-pdf__Page canvas')
    if (!pdfViewer || !canvas || !rects.length) return null

    const viewerRect = pdfViewer.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / Math.max(canvasRect.width, 1)
    const scaleY = canvas.height / Math.max(canvasRect.height, 1)
    const lineCrops = rects
      .map((rect) => {
        const paddingX = Math.max(3, rect.height * 0.3)
        const paddingY = Math.max(3, rect.height * 0.5)
        const viewportRect = {
          left: viewerRect.left - pdfViewer.scrollLeft + rect.left - paddingX,
          top: viewerRect.top - pdfViewer.scrollTop + rect.top - paddingY,
          right: viewerRect.left - pdfViewer.scrollLeft + rect.left + rect.width + paddingX,
          bottom: viewerRect.top - pdfViewer.scrollTop + rect.top + rect.height + paddingY,
        }
        const clippedRect = {
          left: Math.max(viewportRect.left, canvasRect.left),
          top: Math.max(viewportRect.top, canvasRect.top),
          right: Math.min(viewportRect.right, canvasRect.right),
          bottom: Math.min(viewportRect.bottom, canvasRect.bottom),
        }
        if (clippedRect.right - clippedRect.left < 4 || clippedRect.bottom - clippedRect.top < 4) {
          return null
        }

        const sourceX = Math.max(0, Math.floor((clippedRect.left - canvasRect.left) * scaleX))
        const sourceY = Math.max(0, Math.floor((clippedRect.top - canvasRect.top) * scaleY))
        const sourceWidth = Math.min(
          canvas.width - sourceX,
          Math.max(1, Math.ceil((clippedRect.right - clippedRect.left) * scaleX)),
        )
        const sourceHeight = Math.min(
          canvas.height - sourceY,
          Math.max(1, Math.ceil((clippedRect.bottom - clippedRect.top) * scaleY)),
        )

        return { sourceX, sourceY, sourceWidth, sourceHeight }
      })
      .filter(Boolean)

    if (!lineCrops.length) return null

    const gap = 6
    const outputCanvas = document.createElement('canvas')
    outputCanvas.width = Math.max(...lineCrops.map((crop) => crop.sourceWidth))
    outputCanvas.height =
      lineCrops.reduce((height, crop) => height + crop.sourceHeight, 0) +
      gap * Math.max(0, lineCrops.length - 1)
    const context = outputCanvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, outputCanvas.width, outputCanvas.height)

    let targetY = 0
    lineCrops.forEach((crop) => {
      context.drawImage(
        canvas,
        crop.sourceX,
        crop.sourceY,
        crop.sourceWidth,
        crop.sourceHeight,
        0,
        targetY,
        crop.sourceWidth,
        crop.sourceHeight,
      )
      targetY += crop.sourceHeight + gap
    })

    return {
      image: outputCanvas.toDataURL('image/png'),
      width: outputCanvas.width,
      height: outputCanvas.height,
      lineCount: lineCrops.length,
    }
  }

  function getOcrRectIntersectionArea(firstRect, secondRect) {
    const firstRight = firstRect.x + firstRect.width
    const firstBottom = firstRect.y + firstRect.height
    const secondRight = secondRect.x + secondRect.width
    const secondBottom = secondRect.y + secondRect.height

    return Math.max(0, Math.min(firstRight, secondRight) - Math.max(firstRect.x, secondRect.x)) *
      Math.max(0, Math.min(firstBottom, secondBottom) - Math.max(firstRect.y, secondRect.y))
  }

  function getPdfTextLayerOcrBlocks(croppedImage) {
    const pdfViewer = pdfViewerRef.current
    const canvas = pdfViewer?.querySelector('.react-pdf__Page canvas')
    if (!pdfViewer || !canvas) return []

    const canvasRect = canvas.getBoundingClientRect()
    const pageElement = canvas.closest('.react-pdf__Page') || pdfViewer
    const scaleX = Number(croppedImage.scaleX) || canvas.width / Math.max(canvasRect.width, 1)
    const scaleY = Number(croppedImage.scaleY) || canvas.height / Math.max(canvasRect.height, 1)
    const cropRect = {
      x: Number(croppedImage.sourceX) || 0,
      y: Number(croppedImage.sourceY) || 0,
      width: Number(croppedImage.sourceWidth) || croppedImage.width,
      height: Number(croppedImage.sourceHeight) || croppedImage.height,
    }
    const tokens = Array.from(
      pageElement.querySelectorAll('.textLayer span, .react-pdf__Page__textContent span'),
    )
      .map((span) => {
        const text = String(span.textContent || '').replace(/\s+/g, ' ').trim()
        const hasInvalidCharacter = Array.from(text).some((character) => {
          const characterCode = character.charCodeAt(0)
          return (
            character === '\ufffd' ||
            characterCode <= 8 ||
            characterCode === 11 ||
            characterCode === 12 ||
            (characterCode >= 14 && characterCode <= 31)
          )
        })
        if (!text || hasInvalidCharacter) return null

        const rect = span.getBoundingClientRect()
        const tokenRectOnCanvas = {
          x: (rect.left - canvasRect.left) * scaleX,
          y: (rect.top - canvasRect.top) * scaleY,
          width: rect.width * scaleX,
          height: rect.height * scaleY,
        }
        const intersectionArea = getOcrRectIntersectionArea(tokenRectOnCanvas, cropRect)
        const tokenArea = Math.max(tokenRectOnCanvas.width * tokenRectOnCanvas.height, 1)
        if (intersectionArea / tokenArea < 0.42) return null

        const style = window.getComputedStyle(span)
        const renderedFontSize = (Number.parseFloat(style.fontSize) || rect.height) * scaleY
        const left = tokenRectOnCanvas.x - cropRect.x
        const top = tokenRectOnCanvas.y - cropRect.y

        return {
          text,
          left,
          top,
          right: left + tokenRectOnCanvas.width,
          bottom: top + tokenRectOnCanvas.height,
          width: tokenRectOnCanvas.width,
          height: Math.max(tokenRectOnCanvas.height, renderedFontSize),
          fontSize: Math.max(1, renderedFontSize),
        }
      })
      .filter(Boolean)

    const blocks = []

    groupTokensByLine(
      tokens.sort((firstToken, secondToken) => firstToken.top - secondToken.top || firstToken.left - secondToken.left),
    ).forEach((line) => {
      const sortedTokens = line.tokens.sort((firstToken, secondToken) => firstToken.left - secondToken.left)
      const tokenGroups = []

      sortedTokens.forEach((token) => {
        const currentGroup = tokenGroups[tokenGroups.length - 1]
        const previousToken = currentGroup?.[currentGroup.length - 1]
        const gap = previousToken ? token.left - previousToken.right : 0
        const splitGap = Math.max(18, line.maxHeight * 2.1)

        if (!currentGroup || (previousToken && gap > splitGap)) {
          tokenGroups.push([token])
        } else {
          currentGroup.push(token)
        }
      })

      tokenGroups.forEach((group) => {
        const x0 = Math.min(...group.map((token) => token.left))
        const y0 = Math.min(...group.map((token) => token.top))
        const x1 = Math.max(...group.map((token) => token.right))
        const y1 = Math.max(...group.map((token) => token.bottom))
        const formattedText = renderFormattedLine(group)
        const hasFormulaSyntax =
          /\\[A-Za-z]+|[_^]\{|[=<>±×÷→←↔ΔμΩλπσ∑∫√∞≈≠≤≥·′°₀-₉⁰-⁹]/.test(formattedText) ||
          /(?:[A-Za-z]\d|\d[A-Za-z])/.test(formattedText)
        const normalizedFormula = hasFormulaSyntax ? normalizeSimpleInlineLatex(formattedText) : null
        const text = normalizedFormula?.text || formattedText.replace(/\s+/g, ' ').trim()
        if (!text) return
        const x = clampNumber(x0, 0, Math.max(croppedImage.width - 1, 0))
        const y = clampNumber(y0, 0, Math.max(croppedImage.height - 1, 0))

        blocks.push({
          index: blocks.length,
          text,
          sourceText: text,
          x,
          y,
          width: Math.max(1, Math.min(x1 - x0, croppedImage.width - x)),
          height: Math.max(1, Math.min(y1 - y0, croppedImage.height - y)),
          fontSize: median(group.map((token) => token.fontSize)) || Math.max(1, y1 - y0),
          confidence: 100,
          nearEdge: false,
          pdfTextLayer: true,
          pdfTextTokens: group,
          inlineFormulas: getInlineFormulaMetadataFromText(text, 'pdf-text-layer'),
        })
      })
    })

    return blocks.sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
  }

  function getUsefulOcrCharacterCount(text) {
    return (String(text || '').match(/[A-Za-z0-9\u0370-\u03ff]/g) || []).length
  }

  function shouldPreferPdfTextLayer(pdfTextBlocks, tesseractText) {
    const pdfText = pdfTextBlocks.map((block) => block.text).join(' ')
    const pdfCharacters = getUsefulOcrCharacterCount(pdfText)
    const tesseractCharacters = getUsefulOcrCharacterCount(tesseractText)

    if (pdfCharacters < 2) return false
    if (tesseractCharacters < 2) return true

    return pdfCharacters / Math.max(pdfCharacters, tesseractCharacters) >= 0.55
  }

  function isDenseFormulaOrSymbolText(text) {
    const normalizedText = normalizeScientificText(String(text || ''))
    const compactText = normalizedText.replace(/\s+/g, '')
    if (!compactText) return false
    if (isScientificExpressionOnly(normalizedText)) return true

    const normalWords = normalizedText.match(/[A-Za-z][A-Za-z'-]{2,}/g) || []
    const formulaSymbols = normalizedText.match(/[=<>±×÷→←↔^_{}[\]ΔμΩλπσ∑∫√∞≈≠≤≥·′°₀-₉⁰-⁹]/g) || []
    const operators = normalizedText.match(/[=<>±×÷→←↔^_+\-*/∑∫√∞≈≠≤≥·]/g) || []
    const formulaRatio = formulaSymbols.length / Math.max(compactText.length, 1)

    if (formulaSymbols.length >= 4 && formulaRatio >= 0.24 && normalWords.length < 5) return true
    if (operators.length >= 4 && normalWords.length < 6) return true
    if (/\\(?:begin|end|frac|dfrac|tfrac|matrix|cases|sum|prod|int|lim)\b/.test(normalizedText)) return true

    return false
  }

  function hasInlineFormulaClue(word) {
    const text = String(word?.text || '').trim()
    if (!text) return false

    const hasScientificSymbol = /[=<>±×÷→←↔^_{}[\]ΔμΩλπσ∑∫√∞≈≠≤≥·′°₀-₉⁰-⁹]/.test(text)
    const hasMixedLetterNumber = /(?:[A-Za-z]\d|\d[A-Za-z])/.test(text)
    const hasGarbledSymbol =
      /[�|\\~`]/.test(text) ||
      /[^\u0020-\u007e\u0370-\u03ff\u2070-\u209f±×÷→←↔∑∫√∞≈≠≤≥·′°]/.test(text)
    const lowConfidenceWithNonLetter =
      Number(word.confidence) < 55 &&
      /[^A-Za-z.,;:'"!?()-]/.test(text)

    return hasScientificSymbol || hasMixedLetterNumber || hasGarbledSymbol || lowConfidenceWithNonLetter
  }

  function getInlineFormulaMetadataFromText(text, source) {
    return String(text || '')
      .split(/\s+/)
      .map((token) => token.replace(/^[,.;:!?()[\]"']+|[,.;:!?()[\]"']+$/g, ''))
      .filter((token) => token && hasInlineFormulaClue({ text: token, confidence: 100 }))
      .map((token) => {
        const normalized = normalizeSimpleInlineLatex(token)
        return normalized?.text
          ? {
              text: normalized.text,
              latex: normalized.latex,
              source,
            }
          : null
      })
      .filter(Boolean)
      .filter((formula, index, formulas) =>
        formulas.findIndex((candidate) => candidate.text === formula.text) === index)
  }

  function getInlineFormulaCandidates(data, imageSize) {
    const candidates = []
    const words = getAllOcrWords(data)
      .map((word) => normalizeOcrWord(word, imageSize))
      .filter(Boolean)

    groupOcrWordsIntoRows(words).forEach((row) => {
      const sortedWords = row.words.slice().sort((firstWord, secondWord) => firstWord.x0 - secondWord.x0)
      const rowText = sortedWords.map((word) => word.text).join(' ')
      const normalWordIndexes = sortedWords
        .map((word, index) => (/^[A-Za-z][A-Za-z'-]{2,}[,.;:]?$/.test(word.text) ? index : -1))
        .filter((index) => index >= 0)
      if (normalWordIndexes.length < 2 || isDenseFormulaOrSymbolText(rowText)) return

      const suspiciousIndexes = sortedWords
        .map((word, index) => (hasInlineFormulaClue(word) ? index : -1))
        .filter((index) => index >= 0)
      if (!suspiciousIndexes.length || suspiciousIndexes.length > Math.max(4, sortedWords.length * 0.34)) return

      const groups = []
      suspiciousIndexes.forEach((wordIndex) => {
        const currentGroup = groups[groups.length - 1]
        if (!currentGroup || wordIndex > currentGroup[currentGroup.length - 1] + 1) {
          groups.push([wordIndex])
        } else {
          currentGroup.push(wordIndex)
        }
      })

      const rowLeft = Math.min(...sortedWords.map((word) => word.x0))
      const rowRight = Math.max(...sortedWords.map((word) => word.x1))
      const rowWidth = Math.max(rowRight - rowLeft, 1)

      groups.forEach((group) => {
        const firstIndex = group[0]
        const lastIndex = group[group.length - 1]
        const hasNormalBefore = normalWordIndexes.some((index) => index < firstIndex)
        const hasNormalAfter = normalWordIndexes.some((index) => index > lastIndex)
        if ((!hasNormalBefore && !hasNormalAfter) || group.length > 3) return

        const candidateWords = group.map((index) => sortedWords[index])
        const x0 = Math.min(...candidateWords.map((word) => word.x0))
        const y0 = Math.min(...candidateWords.map((word) => word.y0))
        const x1 = Math.max(...candidateWords.map((word) => word.x1))
        const y1 = Math.max(...candidateWords.map((word) => word.y1))
        if ((x1 - x0) / rowWidth > 0.38) return

        candidates.push({
          id: `formula-${candidates.length + 1}`,
          text: candidateWords.map((word) => word.text).join(' ').trim(),
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          confidence:
            candidateWords.reduce((sum, word) => sum + Number(word.confidence || 0), 0) /
            Math.max(candidateWords.length, 1),
        })
      })
    })

    return candidates.slice(0, 12)
  }

  function getPdfTextForFormulaCandidate(candidate, pdfTextBlocks) {
    let bestMatch = null
    let bestRatio = 0

    pdfTextBlocks.forEach((block) => {
      const matchingTokens = (block.pdfTextTokens || []).filter((token) => {
        const tokenRect = {
          x: token.left,
          y: token.top,
          width: token.width,
          height: token.height,
        }
        const intersection = getOcrRectIntersectionArea(candidate, tokenRect)

        return intersection / Math.max(Math.min(candidate.width * candidate.height, token.width * token.height), 1) >= 0.35
      })
      if (!matchingTokens.length) return

      const matchedRect = {
        x: Math.min(...matchingTokens.map((token) => token.left)),
        y: Math.min(...matchingTokens.map((token) => token.top)),
        width:
          Math.max(...matchingTokens.map((token) => token.right)) -
          Math.min(...matchingTokens.map((token) => token.left)),
        height:
          Math.max(...matchingTokens.map((token) => token.bottom)) -
          Math.min(...matchingTokens.map((token) => token.top)),
      }
      const ratio =
        getOcrRectIntersectionArea(candidate, matchedRect) /
        Math.max(candidate.width * candidate.height, 1)
      if (ratio <= bestRatio) return

      bestRatio = ratio
      bestMatch = renderFormattedLine(matchingTokens)
    })

    if (!bestMatch || bestRatio < 0.45) return null
    return normalizeSimpleInlineLatex(bestMatch) || {
      latex: '',
      text: bestMatch.replace(/\s+/g, ' ').trim(),
    }
  }

  function normalizeSimpleInlineLatex(rawLatex) {
    let latex = String(rawLatex || '')
      .replace(/^```(?:latex|tex)?\s*/i, '')
      .replace(/```$/i, '')
      .replace(/^generated[_\s-]*text\s*[:：]\s*/i, '')
      .replace(/^\s*(?:\\\[|\\\(|\$\$?)/, '')
      .replace(/(?:\\\]|\\\)|\$\$?)\s*$/, '')
      .trim()
    latex = latex
      .replace(/\\([A-Za-z]+)\s+\{/g, '\\$1{')
      .replace(/([_^])\s*\{\s*/g, '$1{')
      .replace(/\s+\}/g, '}')
    if (!latex || latex.length > 140 || /[\r\n]/.test(latex)) return null
    if (/\\(?:begin|end|frac|dfrac|tfrac|matrix|cases|sum|prod|int|lim|overset|underset)\b/.test(latex)) {
      return null
    }

    const allowedCommands = new Set([
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'theta', 'lambda', 'mu', 'nu', 'pi', 'rho',
      'sigma', 'tau', 'phi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi',
      'Sigma', 'Phi', 'Psi', 'Omega', 'pm', 'mp', 'times', 'cdot', 'div', 'le', 'leq', 'ge', 'geq',
      'neq', 'approx', 'sim', 'infty', 'to', 'rightarrow', 'leftarrow', 'leftrightarrow', 'degree',
      'prime', 'sqrt', 'mathrm', 'mathbf', 'mathit', 'text',
    ])
    const commands = [...latex.matchAll(/\\([A-Za-z]+)/g)].map((match) => match[1])
    if (commands.some((command) => !allowedCommands.has(command))) return null
    if (commands.length > 6) return null

    const replacements = {
      '\\leftrightarrow': '↔',
      '\\rightarrow': '→',
      '\\leftarrow': '←',
      '\\times': '×',
      '\\cdot': '·',
      '\\approx': '≈',
      '\\infty': '∞',
      '\\degree': '°',
      '\\prime': '′',
      '\\alpha': 'α',
      '\\beta': 'β',
      '\\gamma': 'γ',
      '\\delta': 'δ',
      '\\epsilon': 'ε',
      '\\theta': 'θ',
      '\\lambda': 'λ',
      '\\mu': 'μ',
      '\\nu': 'ν',
      '\\pi': 'π',
      '\\rho': 'ρ',
      '\\sigma': 'σ',
      '\\tau': 'τ',
      '\\phi': 'φ',
      '\\chi': 'χ',
      '\\psi': 'ψ',
      '\\omega': 'ω',
      '\\Gamma': 'Γ',
      '\\Delta': 'Δ',
      '\\Theta': 'Θ',
      '\\Lambda': 'Λ',
      '\\Xi': 'Ξ',
      '\\Pi': 'Π',
      '\\Sigma': 'Σ',
      '\\Phi': 'Φ',
      '\\Psi': 'Ψ',
      '\\Omega': 'Ω',
      '\\pm': '±',
      '\\mp': '∓',
      '\\div': '÷',
      '\\leq': '≤',
      '\\le': '≤',
      '\\geq': '≥',
      '\\ge': '≥',
      '\\neq': '≠',
      '\\sim': '∼',
      '\\to': '→',
    }

    Object.entries(replacements)
      .sort(([firstCommand], [secondCommand]) => secondCommand.length - firstCommand.length)
      .forEach(([command, character]) => {
        latex = latex.replaceAll(command, character)
      })

    for (let iteration = 0; iteration < 3; iteration += 1) {
      latex = latex.replace(/\\(?:mathrm|mathbf|mathit|text)\{([^{}]*)\}/g, '$1')
      latex = latex.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')
    }

    const superscriptMap = {
      0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
      '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
    }
    const subscriptMap = {
      0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
      '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ',
      j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
      u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
    }
    const convertScript = (value, characterMap, marker) => {
      const normalizedValue = String(value || '').trim()
      const characters = Array.from(normalizedValue)
      return characters.every((character) => characterMap[character])
        ? characters.map((character) => characterMap[character]).join('')
        : `${marker}(${normalizedValue})`
    }

    latex = latex
      .replace(/\^\{([^{}]{1,12})\}/g, (_match, value) => convertScript(value, superscriptMap, '^'))
      .replace(/_\{([^{}]{1,12})\}/g, (_match, value) => convertScript(value, subscriptMap, '_'))
      .replace(/\^([A-Za-z0-9+\-=])/g, (_match, value) => convertScript(value, superscriptMap, '^'))
      .replace(/_([A-Za-z0-9+\-=])/g, (_match, value) => convertScript(value, subscriptMap, '_'))
      .replace(/\\[,;! ]/g, ' ')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!latex || /\\[A-Za-z]+/.test(latex) || /[�]/.test(latex)) return null
    const operators = latex.match(/[=<>±×÷→←↔^_+\-*/√∞≈≠≤≥·]/g) || []
    if (latex.length > 56 || operators.length > 4) return null

    return {
      latex: String(rawLatex || '').trim(),
      text: latex,
    }
  }

  async function cropInlineFormulaImage(imageUrl, candidate) {
    const sourceImage = await loadImage(imageUrl)
    const paddingX = Math.max(3, candidate.height * 0.32)
    const paddingY = Math.max(3, candidate.height * 0.26)
    const sourceX = clampNumber(Math.floor(candidate.x - paddingX), 0, sourceImage.naturalWidth - 1)
    const sourceY = clampNumber(Math.floor(candidate.y - paddingY), 0, sourceImage.naturalHeight - 1)
    const sourceRight = clampNumber(
      Math.ceil(candidate.x + candidate.width + paddingX),
      sourceX + 1,
      sourceImage.naturalWidth,
    )
    const sourceBottom = clampNumber(
      Math.ceil(candidate.y + candidate.height + paddingY),
      sourceY + 1,
      sourceImage.naturalHeight,
    )
    const sourceWidth = sourceRight - sourceX
    const sourceHeight = sourceBottom - sourceY
    const scale = clampNumber(72 / Math.max(sourceHeight, 1), 1, 4)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      sourceImage,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height,
    )

    return canvas.toDataURL('image/png')
  }

  async function recognizeInlineFormulaCandidates(data, imageUrl, imageSize, pdfTextBlocks) {
    const candidates = getInlineFormulaCandidates(data, imageSize)
    const corrections = []
    const unresolvedRects = []
    let formulaPipeline = null

    for (const candidate of candidates) {
      const pdfFormula = getPdfTextForFormulaCandidate(candidate, pdfTextBlocks)
      if (pdfFormula?.text) {
        corrections.push({
          ...candidate,
          replacement: pdfFormula.text,
          latex: pdfFormula.latex,
          source: 'pdf-text-layer',
        })
        continue
      }

      try {
        formulaPipeline ||= await getInlineFormulaOcrPipeline()
        const formulaImage = await cropInlineFormulaImage(imageUrl, candidate)
        const output = await formulaPipeline(formulaImage, {
          max_new_tokens: 96,
          num_beams: 2,
        })
        const generatedText = Array.isArray(output)
          ? output[0]?.generated_text || output[0]?.text
          : output?.generated_text || output?.text
        const normalizedFormula = normalizeSimpleInlineLatex(generatedText)

        if (!normalizedFormula?.text) {
          unresolvedRects.push(candidate)
          continue
        }

        corrections.push({
          ...candidate,
          replacement: normalizedFormula.text,
          latex: normalizedFormula.latex,
          source: 'local-formula-ocr',
        })
      } catch (error) {
        console.warn('本地行内公式 OCR 失败，该模块将保持原图且不翻译', {
          text: candidate.text,
          error: error.message,
        })
        unresolvedRects.push(candidate)
      }
    }

    return { corrections, unresolvedRects }
  }

  function applyInlineFormulaCorrections(blocks, formulaResult) {
    const corrections = formulaResult?.corrections || []
    const unresolvedRects = formulaResult?.unresolvedRects || []

    return blocks.map((block) => {
      const sourceLines = getCompareSourceBlocks(block).map((line) => ({ ...line }))
      const inlineFormulas = [...(block.inlineFormulas || [])]
      let skipTranslation = Boolean(block.skipTranslation)

      unresolvedRects.forEach((unresolvedRect) => {
        const overlapsBlock =
          getOcrRectIntersectionArea(block, unresolvedRect) /
          Math.max(unresolvedRect.width * unresolvedRect.height, 1) >= 0.3
        if (overlapsBlock) skipTranslation = true
      })

      corrections.forEach((correction) => {
        let bestLineIndex = -1
        let bestOverlap = 0

        sourceLines.forEach((line, lineIndex) => {
          const overlap =
            getOcrRectIntersectionArea(line, correction) /
            Math.max(correction.width * correction.height, 1)
          if (overlap <= bestOverlap) return
          bestLineIndex = lineIndex
          bestOverlap = overlap
        })

        if (bestLineIndex < 0 || bestOverlap < 0.3) return
        const line = sourceLines[bestLineIndex]
        const escapedText = correction.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nextText = line.text.replace(new RegExp(escapedText, 'i'), correction.replacement)

        if (nextText === line.text && correction.text !== correction.replacement) {
          skipTranslation = true
          return
        }

        line.text = nextText
        line.sourceText = nextText
        inlineFormulas.push({
          text: correction.replacement,
          latex: correction.latex,
          source: correction.source,
          bbox: {
            x: correction.x,
            y: correction.y,
            width: correction.width,
            height: correction.height,
          },
        })
      })

      const mergedBlock = sourceLines.length
        ? mergeOcrBlocks(sourceLines, block.index)
        : block

      return {
        ...block,
        ...mergedBlock,
        inlineFormulas,
        skipTranslation,
      }
    })
  }

  function isNumberedLine(line) {
    return /^\s*(?:\d+[\s.)、-]+|[A-Z][.)、-]+\s*)/.test(line)
  }

  function hasSentenceEnding(line) {
    return /[.!?。！？:：;；]["')\]]*$/.test(line)
  }

  function cleanOcrText(rawText) {
    const lines = rawText
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())

    const paragraphs = []
    let currentParagraph = ''
    let blankLineCount = 0

    lines.forEach((line) => {
      if (!line) {
        blankLineCount += 1
        return
      }

      const startsNumberedItem = isNumberedLine(line)
      const shouldStartNewParagraph =
        !currentParagraph || blankLineCount > 1 || (startsNumberedItem && currentParagraph)

      if (shouldStartNewParagraph) {
        if (currentParagraph) {
          paragraphs.push(currentParagraph)
        }

        currentParagraph = line
      } else if (currentParagraph.endsWith('-') && /^[a-z]/i.test(line)) {
        currentParagraph = `${currentParagraph.slice(0, -1)}${line}`
      } else if (hasSentenceEnding(currentParagraph) && /^[A-Z(]/.test(line) && line.length > 28) {
        paragraphs.push(currentParagraph)
        currentParagraph = line
      } else {
        currentParagraph = `${currentParagraph} ${line}`
      }

      blankLineCount = 0
    })

    if (currentParagraph) {
      paragraphs.push(currentParagraph)
    }

    return paragraphs.join('\n').replace(/[ \t]+/g, ' ').trim()
  }

  function cleanResultText(text) {
    return text
      .replace(/\r/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function normalizeScientificText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\b([A-Z][a-z]?)\s+(\d+)\s*([+-])\b/g, '$1$2$3')
      .replace(/\b([A-Z][a-z]?)\s+([+-]{1,2})\b/g, '$1$2')
      .replace(/\b(CO|H|N|O|S|P)\s+(\d+)\b/g, '$1$2')
      .replace(/\bH\s*2\s*O\b/gi, 'H2O')
      .replace(/\bCO\s*2\b/gi, 'CO2')
      .replace(/\b10\s+(-?\d+)\b/g, '10^$1')
      .replace(/Δ\s*G\s*[′']?\s*°?/g, (match) => match.replace(/\s+/g, ''))
      .replace(/\s*([′°+-])\s*/g, '$1')
      .trim()
  }

  function isScientificExpressionOnly(text) {
    const normalizedText = normalizeScientificText(text)
    const compactText = normalizedText.replace(/\s/g, '')

    if (!compactText) return true

    const chemicalFormulaPattern =
      /^([A-Z][a-z]?\d*){1,8}([+-]|[2-9][+-]|\([a-z]+\))?$/
    const ionPattern = /^[A-Z][a-z]?\d{0,2}[+-]{1,2}$/
    const variablePattern =
      /^(pH|pKa|Km|Vmax|kcat|Ea|ΔG|ΔG′°|ΔH|ΔS|Pi|ATP|ADP|AMP|NADH|NADPH|FAD|FADH2)$/i
    const unitPattern =
      /^(M|mM|μM|uM|nM|mol\/L|kDa|Da|nm|pm|mV|V|kJ\/mol|J·mol\^-?1|J\/mol|s\^-?1|min\^-?1|h\^-?1)$/i
    const numberPattern =
      /^[-+]?\d+(\.\d+)?([x×]\d+)?$|^10\^?\{?-?\d+\}?$|^\d+(\.\d+)?\s*[x×]\s*10\^?\{?-?\d+\}?$/i
    const bondPattern = /^[A-Z][a-z]?[—–-][A-Z][a-z]?$/
    const formulaPattern = /^[A-Za-zΔμ′°0-9+\-*/=()[\]{}^_ .·×]+$/
    const hasOperator = /[=+\-*/^×·()[\]{}]/.test(normalizedText)
    const hasLongEnglishWord = /[A-Za-z]{4,}/.test(normalizedText)

    if (variablePattern.test(compactText)) return true
    if (unitPattern.test(compactText)) return true
    if (numberPattern.test(normalizedText)) return true
    if (bondPattern.test(compactText)) return true
    if (ionPattern.test(compactText)) return true
    if (chemicalFormulaPattern.test(compactText) && !hasLongEnglishWord) return true
    if (formulaPattern.test(normalizedText) && hasOperator && !/\b(the|and|with|for|rate|value|depends|requires)\b/i.test(normalizedText)) {
      return true
    }

    return false
  }

  function isMeaningfulEnglishText(text) {
    const normalizedText = normalizeScientificText(text)

    if (!normalizedText) return false

    const compactText = normalizedText.replace(/\s/g, '')
    const usefulShortTerms = isUsefulShortOcrLabel(normalizedText)
    const usefulAcademicPhrase =
      /\b(enzyme|substrate|product|transition|ground|state|reaction|coordinate|coenzyme|cofactor|metal|ion|ions|precursor|activity|rate|energy|enhancement|carbonic|anhydrase|isomerase|transfer|chemical|group|groups|dietary|heat|light|work|cell|cells|signal|signals|transduction|production|motion|protein|proteins|gene|genes|dna|rna)\b/i

    if (isScientificExpressionOnly(normalizedText) || isDenseFormulaOrSymbolText(normalizedText)) return false
    if (usefulShortTerms) return true
    if (compactText.length < 3) return false

    const latinLetters = normalizedText.match(/[A-Za-z]/g) || []
    const cjkCharacters = normalizedText.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []
    const wordLikeTokens = normalizedText.match(/[A-Za-z][A-Za-z-]{1,}/g) || []
    const noisyCharacters = normalizedText.match(/[|\\/_~`^]+/g) || []
    const usefulCharacters = normalizedText.match(/[A-Za-z0-9]/g) || []
    const letterRatio = latinLetters.length / Math.max(compactText.length, 1)
    const usefulRatio = usefulCharacters.length / Math.max(compactText.length, 1)

    if (latinLetters.length < 2) return false
    if (cjkCharacters.length > latinLetters.length) return false
    if (wordLikeTokens.length === 0 && letterRatio < 0.55) return false
    if (letterRatio < 0.28 || usefulRatio < 0.45) return false
    if (noisyCharacters.length > Math.max(2, compactText.length * 0.18)) return false
    if (/^[\d\s.,;:()[\]{}+\-*/=<>%|\\_]+$/.test(normalizedText)) return false
    if (/^[A-Z]{1,2}[,.;:]*$/.test(normalizedText)) return false
    if (/^[|\\/_\s.,;:'"`-]+$/.test(normalizedText)) return false
    if (!usefulAcademicPhrase.test(normalizedText) && wordLikeTokens.length === 1 && compactText.length < 6) return false

    return true
  }

  function isUsefulShortOcrLabel(text) {
    const normalizedText = normalizeScientificText(text).toLowerCase()

    if (!normalizedText) return false

    return /^(enzyme|product|substrate|coenzyme|cofactor|inhibitor|activator|metal|ion|ions|heat|light|work|cell|cells|signal|signals|transduction|production|light production|heat production|motion|energy|protein|proteins|gene|genes|dna|rna)$/i.test(normalizedText)
  }

  function isLikelyOcrNoiseText(text, confidence = 100, nearEdge = false) {
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim()
    const lowerText = normalizedText.toLowerCase()
    const letters = normalizedText.match(/[A-Za-z]/g) || []
    const usefulCharacters = normalizedText.match(/[A-Za-z0-9]/g) || []
    const symbolCharacters = normalizedText.match(/[|\\/_~`^=<>[\]{}]+/g) || []
    const wordTokens = normalizedText.match(/[A-Za-z]+/g) || []
    const hasKnownShortAbbreviation = /\b(DNA|RNA|ATP|ADP|AMP|NADH|NADPH|FAD|CO2|NH3|H2O)\b/i.test(normalizedText)

    if (!normalizedText) return true
    if (/^(li|dl|iii|lll|ii|ll|l|i)(\s+(li|dl|iii|lll|ii|ll|l|i))*$/.test(lowerText)) return true
    if (
      !hasKnownShortAbbreviation &&
      wordTokens.length >= 2 &&
      wordTokens.every((token) => token.length <= 2) &&
      !isUsefulShortOcrLabel(normalizedText)
    ) {
      return true
    }
    if (letters.length < 2 && normalizedText.length <= 4) return true
    if (usefulCharacters.length / Math.max(normalizedText.length, 1) < 0.42) return true
    if (symbolCharacters.length > Math.max(2, normalizedText.length * 0.24)) return true
    if (/(.)\1{4,}/.test(normalizedText)) return true
    if (isUsefulShortOcrLabel(normalizedText)) return false
    if (!nearEdge && Number.isFinite(confidence) && confidence < 18) return true

    return false
  }

  function shouldTranslateOcrBlock(block) {
    if (!block?.text) return false
    if (block.skipTranslation || isDenseFormulaOrSymbolText(block.text)) return false
    const isNearEdge = block.nearEdge || (block.sourceBlocks || []).some((sourceBlock) => sourceBlock.nearEdge)
    const isShortLabel = isUsefulShortOcrLabel(block.text)
    if (isLikelyOcrNoiseText(block.text, block.confidence, isNearEdge)) return false
    if (Number.isFinite(block.confidence) && block.confidence < (isNearEdge || isShortLabel ? 18 : 35)) return false

    return isMeaningfulEnglishText(block.text)
  }

  function getOcrBlockContentType(block) {
    const text = cleanOcrSourceForTranslation(block?.text || '')
    const declaredType = String(block?.type || '').toLowerCase()
    const sourceTypes = (block?.sourceBlocks || [])
      .map((line) => String(line?.type || '').toLowerCase())
      .filter(Boolean)
    const allSourceLinesAreFormula =
      sourceTypes.length > 0 &&
      sourceTypes.every((type) =>
        type.includes('formula') || type.includes('equation') || type.includes('dense_symbol'),
      )
    if (!text) return 'noise'
    if (
      declaredType.includes('formula') ||
      declaredType.includes('equation') ||
      declaredType.includes('dense_symbol') ||
      allSourceLinesAreFormula ||
      isScientificExpressionOnly(text) ||
      isDenseFormulaOrSymbolText(text)
    ) {
      return 'formula'
    }
    if (shouldTranslateOcrBlock({ ...block, text })) return 'text'
    if (block?.skipTranslation && isMeaningfulEnglishText(text)) return 'text'
    return 'noise'
  }

  function getBlockInlineFormulas(block) {
    const formulas = [
      ...(Array.isArray(block?.inlineFormulas) ? block.inlineFormulas : []),
      ...(Array.isArray(block?.formulaRegions) ? block.formulaRegions : []),
      ...(block?.sourceBlocks || [])
        .flatMap((line) => Array.isArray(line?.formulaRegions) ? line.formulaRegions : []),
      ...(block?.sourceBlocks || [])
        .filter((line) => String(line?.type || '').toLowerCase().includes('inline_formula'))
        .map((line) => ({
          text: line.text,
          latex: line.latex,
          source: 'multimodal',
        })),
      ...getInlineFormulaMetadataFromText(block?.text || '', 'detected-text'),
    ]
    const formulaKeys = new Set()

    return formulas.filter((formula) => {
      const text = String(formula?.text || '').trim()
      if (!text || formulaKeys.has(text)) return false
      formulaKeys.add(text)
      return true
    })
  }

  function isVisualTranslationBlock(block) {
    const declaredType = String(block?.type || '').toLowerCase()
    if (
      declaredType.includes('formula') ||
      declaredType.includes('dense_symbol') ||
      declaredType.includes('noise') ||
      Number(block?.symbolDensity) >= 0.55
    ) {
      return false
    }
    if (
      block?.multimodal &&
      ['text', 'paragraph', 'title', 'label', 'legend'].includes(declaredType)
    ) {
      return Boolean(cleanOcrSourceForTranslation(block.text)) &&
        normalizeMultimodalConfidence(block.confidence) >= 18
    }

    return getOcrBlockContentType(block) === 'text'
  }

  function isVisualTranslationLine(line) {
    const type = String(line?.type || 'text').toLowerCase()
    if (
      type.includes('formula') ||
      type.includes('dense_symbol') ||
      type.includes('noise')
    ) {
      return false
    }

    return !isScientificExpressionOnly(line?.text || '') &&
      !isDenseFormulaOrSymbolText(line?.text || '')
  }

  async function translateOcrBlocksPreservingFormulas(blocks = []) {
    const orderedBlocks = blocks
      .filter(Boolean)
      .slice()
      .sort((firstBlock, secondBlock) =>
        (Number(firstBlock.y) || 0) - (Number(secondBlock.y) || 0) ||
        (Number(firstBlock.x) || 0) - (Number(secondBlock.x) || 0),
      )
    const segments = []

    for (const block of orderedBlocks) {
      const sourceText = cleanOcrSourceForTranslation(block.text)
      const contentType = getOcrBlockContentType(block)
      if (!sourceText || contentType === 'noise') continue

      if (contentType === 'formula') {
        segments.push({
          type: 'formula',
          sourceText,
          outputText: sourceText,
          preserveOriginal: true,
          latex: String(block.latex || '').trim(),
        })
        continue
      }

      const inlineFormulas = getBlockInlineFormulas(block)
      const translation = cleanResultText(
        await translateOcrBlockText(sourceText, inlineFormulas),
      )
      if (isUselessTranslationResult(translation)) {
        throw new Error('模型未返回有效译文')
      }
      segments.push({
        type: 'text',
        sourceText,
        outputText: translation,
        preserveOriginal: false,
        inlineFormulas,
      })
    }

    return {
      segments,
      translation: cleanResultText(segments.map((segment) => segment.outputText).join('\n')),
    }
  }

  function selectionTextNeedsVisualRepair(text) {
    const value = String(text || '').trim()
    if (!value) return false

    const invalidCharacters = Array.from(value).filter((character) => {
      const code = character.charCodeAt(0)
      return character === '�' || (code <= 31 && ![9, 10, 13].includes(code))
    })
    const unusualRuns = value.match(/(?:[|\\~`_^{}<>]|\[|\]){2,}/g) || []
    const formulaClues = value
      .split(/\s+/)
      .filter((token) => hasInlineFormulaClue({ text: token, confidence: 100 }))

    return invalidCharacters.length > 0 || unusualRuns.length > 0 || formulaClues.length > 0
  }

  function isUselessTranslationResult(text) {
    const normalizedText = text.replace(/\s+/g, ' ').trim().toLowerCase()

    if (!normalizedText) return true

    return [
      '请提供需要翻译的英文文本',
      '请提供要翻译的文本',
      '请提供需要翻译',
      '请提供完整句子',
      '请提供完整英文文本',
      '请重新上传',
      '无法翻译',
      '无法进行翻译',
      '无法识别',
      '不是英文',
      '不是英文学术文本',
      'provide the english text',
      'provide the complete',
      'provide complete',
      'please provide',
      'please upload',
      'no translatable text',
      'cannot translate',
      'cannot identify',
      'cannot recognize',
      'unable to translate',
      'unable to recognize',
      'provided text is not english',
      'the provided text is not english',
      'not english academic text',
      '未提供英文文本',
      '该内容不是英文',
      '你提供的内容不是英文学术文本',
    ].some((pattern) => normalizedText.includes(pattern))
  }

  function normalizeOcrBbox(bbox) {
    if (!bbox) return null

    const x0 = Number(bbox.x0)
    const y0 = Number(bbox.y0)
    const x1 = Number(bbox.x1)
    const y1 = Number(bbox.y1)

    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
      return null
    }

    return { x0, y0, x1, y1 }
  }

  function clampOcrBboxToImage(box, imageSize) {
    if (!box || !imageSize?.width || !imageSize?.height) return null

    const edgeTolerance = Math.max(6, Math.min(imageSize.width, imageSize.height) * 0.025)

    if (
      box.x1 < -edgeTolerance ||
      box.y1 < -edgeTolerance ||
      box.x0 > imageSize.width + edgeTolerance ||
      box.y0 > imageSize.height + edgeTolerance
    ) {
      return null
    }

    const x0 = clampNumber(box.x0, 0, imageSize.width)
    const y0 = clampNumber(box.y0, 0, imageSize.height)
    const x1 = clampNumber(box.x1, 0, imageSize.width)
    const y1 = clampNumber(box.y1, 0, imageSize.height)

    if (x1 - x0 <= 1 || y1 - y0 <= 1) return null

    return {
      x0,
      y0,
      x1,
      y1,
      nearEdge:
        box.x0 <= edgeTolerance ||
        box.y0 <= edgeTolerance ||
        box.x1 >= imageSize.width - edgeTolerance ||
        box.y1 >= imageSize.height - edgeTolerance,
    }
  }

  function getBboxFromWords(words = []) {
    const boxes = words.map((word) => normalizeOcrBbox(word.bbox)).filter(Boolean)

    if (!boxes.length) return null

    return {
      x0: Math.min(...boxes.map((box) => box.x0)),
      y0: Math.min(...boxes.map((box) => box.y0)),
      x1: Math.max(...boxes.map((box) => box.x1)),
      y1: Math.max(...boxes.map((box) => box.y1)),
    }
  }

  function getAllOcrWords(data) {
    return (data.blocks || [])
      .flatMap((block) => block.paragraphs || [])
      .flatMap((paragraph) => paragraph.lines || [])
      .flatMap((line) => line.words || [])
  }

  function collectOcrLines(data) {
    if (Array.isArray(data.lines) && data.lines.length) return data.lines

    return (data.blocks || []).flatMap((block) =>
      (block.paragraphs || []).flatMap((paragraph) => paragraph.lines || []),
    )
  }

  function normalizeOcrWord(word, imageSize) {
    const text = (word.text || '').replace(/\s+/g, ' ').trim()
    const box = normalizeOcrBbox(word.bbox)
    const clippedBox = clampOcrBboxToImage(box, imageSize)

    if (!text || !clippedBox) return null
    if (Number.isFinite(word.confidence) && word.confidence < (clippedBox.nearEdge ? 18 : 30)) return null

    return {
      text,
      x0: clippedBox.x0,
      y0: clippedBox.y0,
      x1: clippedBox.x1,
      y1: clippedBox.y1,
      fontSize: Math.max(1, (clippedBox.y1 - clippedBox.y0) * 0.82),
      nearEdge: clippedBox.nearEdge,
      confidence: Number(word.confidence) || 0,
    }
  }

  function groupOcrWordsIntoRows(words) {
    const rows = []

    words
      .slice()
      .sort((firstWord, secondWord) => (firstWord.y0 + firstWord.y1) / 2 - (secondWord.y0 + secondWord.y1) / 2)
      .forEach((word) => {
        const wordCenterY = (word.y0 + word.y1) / 2
        const wordHeight = word.y1 - word.y0
        const matchingRow = rows.find((row) => {
          const tolerance = Math.max(8, row.averageHeight * 0.72, wordHeight * 0.72)

          return Math.abs(row.centerY - wordCenterY) <= tolerance
        })

        if (matchingRow) {
          matchingRow.words.push(word)
          matchingRow.centerY =
            matchingRow.words.reduce((sum, rowWord) => sum + (rowWord.y0 + rowWord.y1) / 2, 0) /
            matchingRow.words.length
          matchingRow.averageHeight =
            matchingRow.words.reduce((sum, rowWord) => sum + rowWord.y1 - rowWord.y0, 0) /
            matchingRow.words.length
        } else {
          rows.push({
            centerY: wordCenterY,
            averageHeight: wordHeight,
            words: [word],
          })
        }
      })

    return rows
  }

  function createBlockFromWords(words, index) {
    const sortedWords = words.slice().sort((firstWord, secondWord) => firstWord.x0 - secondWord.x0)
    const wordHeights = sortedWords.map((word) => word.y1 - word.y0).filter((height) => height > 0)
    const text = sortedWords
      .map((word) => word.text)
      .join(' ')
      .replace(/\s+([,.;:!?%)\]])/g, '$1')
      .replace(/([(])\s+/g, '$1')
      .trim()
    const box = getBboxFromWords(sortedWords.map((word) => ({ bbox: word })))

    if (!text || !box) return null

    return {
      index,
      text,
      x: box.x0,
      y: box.y0,
      width: box.x1 - box.x0,
      height: box.y1 - box.y0,
      fontSize: Math.max(1, (median(wordHeights) || box.y1 - box.y0) * 0.82),
      nearEdge: sortedWords.some((word) => word.nearEdge),
      confidence:
        sortedWords.reduce((sum, word) => sum + (Number(word.confidence) || 0), 0) /
        Math.max(sortedWords.length, 1),
    }
  }

  function getBlockRight(block) {
    return block.x + block.width
  }

  function getBlockBottom(block) {
    return block.y + block.height
  }

  function getBlockSourceLines(block) {
    return (Array.isArray(block?.sourceBlocks) && block.sourceBlocks.length ? block.sourceBlocks : [block])
      .filter(Boolean)
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
  }

  function getFirstSourceLine(block) {
    return getBlockSourceLines(block)[0] || block
  }

  function getLastSourceLine(block) {
    const lines = getBlockSourceLines(block)

    return lines[lines.length - 1] || block
  }

  function getHorizontalOverlapRatio(firstBlock, secondBlock) {
    const overlap = Math.max(
      0,
      Math.min(getBlockRight(firstBlock), getBlockRight(secondBlock)) -
        Math.max(firstBlock.x, secondBlock.x),
    )
    const referenceWidth = Math.max(1, Math.min(firstBlock.width, secondBlock.width))

    return overlap / referenceWidth
  }

  function isNewListOrTableRow(block) {
    const text = block.text.trim()

    return (
      isNumberedLine(text) ||
      /^[-*•·]\s+/.test(text) ||
      /^\(?[A-Za-z0-9]\)\s+/.test(text) ||
      /^[A-Za-z]\.\s+/.test(text) ||
      /^\s*(table|figure|fig\.|scheme|equation)\s+\d+/i.test(text)
    )
  }

  function getWordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length
  }

  function isLikelyContinuationLine(text) {
    return /^(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|produced|transferred)\b/i.test(
      text.trim(),
    )
  }

  function isLikelyFormulaOrTableLine(text) {
    const normalizedText = text.replace(/\s+/g, ' ').trim()
    const letters = normalizedText.match(/[A-Za-z]/g) || []
    const digits = normalizedText.match(/\d/g) || []
    const operators = normalizedText.match(/[=+*/<>→←↔^_()[\]{}|]/g) || []
    const words = normalizedText.match(/[A-Za-z][A-Za-z-]{1,}/g) || []

    if (!normalizedText) return false
    if (operators.length >= Math.max(2, letters.length * 0.45)) return true
    if (digits.length >= 4 && words.length <= 2) return true
    if (/\b(kcat|km|ph|h2o|co2|nad|atp)\b/i.test(normalizedText) && operators.length >= 1) return true

    return false
  }

  function getBlockOrientation(block) {
    return block.height > block.width * 1.35 ? 'vertical' : 'horizontal'
  }

  function isLikelySameTextRegion(previousBlock, nextBlock, options = {}) {
    const lineHeight = Math.max(previousBlock.height, nextBlock.height, 1)
    const verticalGap = nextBlock.y - getBlockBottom(previousBlock)
    const strict = options.strict === true
    const sameX = Math.abs(previousBlock.x - nextBlock.x) < lineHeight * (strict ? 1.35 : 1.8)
    const similarHeight = Math.abs(previousBlock.height - nextBlock.height) < lineHeight * (strict ? 0.55 : 0.7)
    const normalGap = verticalGap >= -lineHeight * 0.3 && verticalGap < lineHeight * (strict ? 1.12 : 1.55)
    const horizontalOverlap = getHorizontalOverlapRatio(previousBlock, nextBlock)
    const widthRatio = Math.min(previousBlock.width, nextBlock.width) / Math.max(previousBlock.width, nextBlock.width, 1)
    const sameOrientation = getBlockOrientation(previousBlock) === getBlockOrientation(nextBlock)

    return (
      normalGap &&
      similarHeight &&
      sameOrientation &&
      (sameX || horizontalOverlap > (strict ? 0.48 : 0.36)) &&
      widthRatio > (strict ? 0.32 : 0.25)
    )
  }

  function isStrongDiagramLineContinuation(previousLine, nextLine, options = {}) {
    const previousText = String(previousLine?.text || '').trim()
    const nextText = String(nextLine?.text || '').trim()
    if (!previousText || !nextText) return false
    if (isNewListOrTableRow(nextLine)) return false
    if (isLikelyFormulaOrTableLine(previousText) || isLikelyFormulaOrTableLine(nextText)) return false

    const boundaryReview = options.boundaryReview === true
    const lineHeight = Math.max(previousLine.height, nextLine.height, 1)
    const verticalGap = nextLine.y - getBlockBottom(previousLine)
    const horizontalOverlap = getHorizontalOverlapRatio(previousLine, nextLine)
    const leftOffset = Math.abs(previousLine.x - nextLine.x)
    const previousFontSize = Math.max(1, Number(previousLine.fontSize) || previousLine.height * 0.82)
    const nextFontSize = Math.max(1, Number(nextLine.fontSize) || nextLine.height * 0.82)
    const fontRatio = Math.min(previousFontSize, nextFontSize) / Math.max(previousFontSize, nextFontSize)
    const previousWords = getWordCount(previousText)
    const nextWords = getWordCount(nextText)
    const previousEndsOpen =
      /[-,(（/:：]$/.test(previousText) ||
      /\b(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|using|via)$/i.test(previousText)
    const nextContinues = /^[a-z(（]/.test(nextText) || isLikelyContinuationLine(nextText)
    const bodyWrap = previousWords >= 6 && nextWords >= 3 && !hasSentenceEnding(previousText)
    const bothShort = previousWords <= 4 && nextWords <= 4
    const nextStartsLikeIndependentLabel = /^[A-Z0-9][A-Za-z0-9\s-]{1,}$/.test(nextText) && nextWords <= 6
    const maximumGap = lineHeight * (boundaryReview ? 0.72 : 0.95)
    const minimumOverlap = boundaryReview ? 0.68 : 0.56
    const maximumLeftOffset = lineHeight * (boundaryReview ? 0.72 : 0.95)
    const minimumFontRatio = boundaryReview ? 0.78 : 0.7

    if (verticalGap < -lineHeight * 0.25 || verticalGap > maximumGap) return false
    if (fontRatio < minimumFontRatio) return false
    if (horizontalOverlap < minimumOverlap && leftOffset > maximumLeftOffset) return false
    if (hasSentenceEnding(previousText) && !/[:：]$/.test(previousText)) return false
    if (nextStartsLikeIndependentLabel && !previousEndsOpen) return false
    if (bothShort && !previousEndsOpen && !nextContinues) return false

    return previousEndsOpen || nextContinues || bodyWrap
  }

  function shouldMergeWrappedLine(previousBlock, nextBlock, options = {}) {
    if (!previousBlock || !nextBlock) return false
    const previousLine = getLastSourceLine(previousBlock)
    const nextLine = getFirstSourceLine(nextBlock)
    const strict = options.strict === true
    const diagram = options.diagram === true

    if (isNewListOrTableRow(nextLine) && !diagram) return false
    if (isLikelyFormulaOrTableLine(previousLine.text) || isLikelyFormulaOrTableLine(nextLine.text)) return false
    if (!isLikelySameTextRegion(previousLine, nextLine, options)) return false
    if (diagram) return isStrongDiagramLineContinuation(previousLine, nextLine, options)

    const previousText = previousLine.text.trim()
    const nextText = nextLine.text.trim()
    const previousWords = getWordCount(previousText)
    const nextWords = getWordCount(nextText)
    const lineHeight = Math.max(previousLine.height, nextLine.height, 1)
    const verticalGap = nextLine.y - getBlockBottom(previousLine)
    const nextStartsLikeHeading = /^[A-Z][A-Za-z\s-]{2,}$/.test(nextText) && nextWords <= 6
    const previousEndsOpen =
      /[-,(]$/.test(previousText) ||
      /\b(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|using|via)$/i.test(previousText)
    const nextContinues = /^[a-z(]/.test(nextText) || isLikelyContinuationLine(nextText)
    const previousLooksLikeHeading =
      previousWords <= 8 &&
      nextWords >= 6 &&
      previousLine.width < nextLine.width * 0.75 &&
      /^[A-Z0-9]/.test(previousText)
    const bodyWrap = previousWords >= 5 && nextWords >= 2 && (/^[a-z(]/.test(nextText) || previousWords >= 8)
    const titleWrap = previousWords >= 2 && nextWords >= 2 && (previousEndsOpen || nextContinues)
    const continuousBody = previousWords >= 5 && nextWords >= 3 && !previousLooksLikeHeading

    if (hasSentenceEnding(previousText)) return false
    if (nextStartsLikeHeading && !previousEndsOpen) return false
    if (previousLooksLikeHeading && !previousEndsOpen) return false
    if (strict && verticalGap > lineHeight * 0.72 && !previousEndsOpen && !nextContinues) {
      return false
    }

    if (strict) {
      return previousEndsOpen || nextContinues || bodyWrap || titleWrap || (continuousBody && previousWords >= 7)
    }

    return previousEndsOpen || nextContinues || bodyWrap || titleWrap || continuousBody
  }

  function mergeOcrBlocks(blocks, index) {
    const sourceBlocks = blocks.flatMap((block) => block.sourceBlocks || [block])
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
    const x0 = Math.min(...sourceBlocks.map((block) => block.x))
    const y0 = Math.min(...sourceBlocks.map((block) => block.y))
    const x1 = Math.max(...sourceBlocks.map((block) => getBlockRight(block)))
    const y1 = Math.max(...sourceBlocks.map((block) => getBlockBottom(block)))
    const text = sourceBlocks
      .map((block) => block.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    return {
      index,
      text,
      x: x0,
      y: y0,
      width: x1 - x0,
      height: y1 - y0,
      fontSize: median(sourceBlocks.map((block) => Number(block.fontSize)).filter(Number.isFinite)) ||
        Math.max(1, median(sourceBlocks.map((block) => block.height)) * 0.82),
      nearEdge: sourceBlocks.some((block) => block.nearEdge),
      confidence:
        sourceBlocks.reduce((sum, block) => sum + (Number(block.confidence) || 0), 0) /
        Math.max(sourceBlocks.length, 1),
      inlineFormulas: sourceBlocks
        .flatMap((block) => block.inlineFormulas || [])
        .filter((formula, formulaIndex, formulas) =>
          formulas.findIndex((candidate) =>
            candidate.text === formula.text &&
            candidate.source === formula.source) === formulaIndex),
      skipTranslation: sourceBlocks.some((block) => block.skipTranslation),
      pdfTextLayer: sourceBlocks.every((block) => block.pdfTextLayer),
      sourceBlocks,
    }
  }

  function scoreMergeCandidate(previousBlock, nextBlock) {
    const previousLine = getLastSourceLine(previousBlock)
    const nextLine = getFirstSourceLine(nextBlock)
    const lineHeight = Math.max(previousLine.height, nextLine.height, 1)
    const verticalGap = Math.max(0, nextLine.y - getBlockBottom(previousLine))
    const xDistance = Math.abs(previousLine.x - nextLine.x) / lineHeight
    const overlapPenalty = 1 - getHorizontalOverlapRatio(previousLine, nextLine)
    const widthRatio = Math.min(previousLine.width, nextLine.width) / Math.max(previousLine.width, nextLine.width, 1)

    return verticalGap / lineHeight + xDistance * 0.28 + overlapPenalty * 0.75 + (1 - widthRatio) * 0.2
  }

  function findMergeTargetIndex(mergedBlocks, currentBlock, options = {}) {
    const lastIndex = mergedBlocks.length - 1

    if (lastIndex < 0) return -1

    if (options.strict !== true) {
      return shouldMergeWrappedLine(mergedBlocks[lastIndex], currentBlock, options) ? lastIndex : -1
    }

    let bestIndex = -1
    let bestScore = Infinity
    const lookbackLimit = 10

    for (let index = lastIndex; index >= 0 && lastIndex - index < lookbackLimit; index -= 1) {
      const candidate = mergedBlocks[index]

      if (!shouldMergeWrappedLine(candidate, currentBlock, options)) continue

      const score = scoreMergeCandidate(candidate, currentBlock)

      if (score < bestScore) {
        bestScore = score
        bestIndex = index
      }
    }

    return bestIndex
  }

  function mergeWrappedLinesIntoBlocks(blocks, options = {}) {
    const sortedBlocks = blocks
      .slice()
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
    const mergedBlocks = []

    sortedBlocks.forEach((block) => {
      const currentBlock = {
        ...block,
        sourceBlocks: block.sourceBlocks || [block],
      }
      const mergeTargetIndex = findMergeTargetIndex(mergedBlocks, currentBlock, options)

      if (mergeTargetIndex >= 0) {
        const targetBlock = mergedBlocks[mergeTargetIndex]
        mergedBlocks[mergeTargetIndex] = mergeOcrBlocks([targetBlock, currentBlock], targetBlock.index)
        return
      }

      mergedBlocks.push(currentBlock)
    })

    return mergedBlocks.map((block, index) => ({
      ...block,
      index,
    }))
  }

  function buildOcrBlocks(data, imageSize) {
    const words = getAllOcrWords(data)
      .map((word) => normalizeOcrWord(word, imageSize))
      .filter(Boolean)
    const rows = groupOcrWordsIntoRows(words)
    let blockIndex = 0
    const blocks = []

    rows.forEach((row) => {
      const sortedWords = row.words.slice().sort((firstWord, secondWord) => firstWord.x0 - secondWord.x0)
      const averageHeight = row.averageHeight || 12
      const averageWordWidth =
        sortedWords.reduce((sum, word) => sum + word.x1 - word.x0, 0) / Math.max(sortedWords.length, 1)
      const gapThreshold = Math.max(averageHeight * 2.1, averageWordWidth * 0.9, 20)
      let currentWords = []

      sortedWords.forEach((word) => {
        const previousWord = currentWords[currentWords.length - 1]
        const gap = previousWord ? word.x0 - previousWord.x1 : 0

        if (previousWord && gap > gapThreshold) {
          const block = createBlockFromWords(currentWords, blockIndex)
          if (block) {
            blocks.push(block)
            blockIndex += 1
          }
          currentWords = [word]
        } else {
          currentWords.push(word)
        }
      })

      const block = createBlockFromWords(currentWords, blockIndex)
      if (block) {
        blocks.push(block)
        blockIndex += 1
      }
    })

    return blocks
  }

  function getLineOcrBlocks(data, imageSize) {
    return collectOcrLines(data)
      .map((line, index) => {
        const text = cleanOcrText(line.text || '')
        const box = normalizeOcrBbox(line.bbox) || getBboxFromWords(line.words)
        const clippedBox = clampOcrBboxToImage(box, imageSize)

        if (!text || !clippedBox) return null

        const x0 = clippedBox.x0
        const y0 = clippedBox.y0
        const x1 = clippedBox.x1
        const y1 = clippedBox.y1

        return {
          index,
          text,
          x: x0,
          y: y0,
          width: x1 - x0,
          height: y1 - y0,
          fontSize: Math.max(
            1,
            Number(line.fontSize || line.font_size || line.font?.size) || (y1 - y0) * 0.82,
          ),
          nearEdge: clippedBox.nearEdge,
          confidence: Number(line.confidence) || 0,
        }
      })
      .filter(Boolean)
  }

  function getOcrTextBlocks(data, imageSize, options = {}) {
    const blocks = buildOcrBlocks(data, imageSize)
    const visualBlocks = blocks.length ? blocks : getLineOcrBlocks(data, imageSize)
    const nextBlocks = mergeWrappedLinesIntoBlocks(visualBlocks, options)

    console.log('OCR 图解模式文本块', {
      count: nextBlocks.length,
      visualCount: visualBlocks.length,
      imageSize,
      sample: nextBlocks.slice(0, 5).map((block) => ({
        text: block.text,
        fontSize: block.fontSize,
        bbox: {
          x0: block.x,
          y0: block.y,
          x1: block.x + block.width,
          y1: block.y + block.height,
        },
      })),
    })

    return options.diagram ? nextBlocks : nextBlocks.slice(0, 100)
  }

  function loadImage(imageUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image()

      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('结果图生成失败'))
      image.src = imageUrl
    })
  }

  function wrapCanvasText(context, text, maxWidth) {
    const characters = Array.from(text)
    const lines = []
    let currentLine = ''

    characters.forEach((character) => {
      const nextLine = `${currentLine}${character}`

      if (currentLine && context.measureText(nextLine).width > maxWidth) {
        lines.push(currentLine)
        currentLine = character
      } else {
        currentLine = nextLine
      }
    })

    if (currentLine) {
      lines.push(currentLine)
    }

    return lines.length ? lines : [text]
  }

  function getCompareSourceBlocks(block) {
    return (Array.isArray(block.sourceBlocks) && block.sourceBlocks.length ? block.sourceBlocks : [block])
      .map((sourceBlock) => ({
        ...sourceBlock,
        width: Math.max(1, Number(sourceBlock.width) || 1),
        height: Math.max(1, Number(sourceBlock.height) || 1),
        fontSize: Math.max(
          1,
          Number(sourceBlock.fontSize || sourceBlock.font_size || sourceBlock.font?.size) ||
            Math.max(1, Number(sourceBlock.height) || 1) * 0.82,
        ),
      }))
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
  }

  function getCompareLineWeight(line) {
    const sourceText = String(line.text || line.sourceText || '').replace(/\s+/g, ' ').trim()
    const textUnits = (sourceText.match(/[A-Za-z0-9\u3400-\u9fff]/g) || []).length
    return {
      textUnits: Math.max(1, textUnits),
      width: Math.max(1, Number(line.width) || 1),
    }
  }

  function findCompareTranslationCut(characters, idealCut, minimumCut, maximumCut) {
    const lowerBound = Math.max(minimumCut, Math.floor(idealCut - Math.max(4, idealCut * 0.28)))
    const upperBound = Math.min(maximumCut, Math.ceil(idealCut + Math.max(4, idealCut * 0.28)))
    let bestCut = clampNumber(Math.round(idealCut), minimumCut, maximumCut)
    let bestScore = Infinity

    for (let cut = lowerBound; cut <= upperBound; cut += 1) {
      const previousCharacter = characters[cut - 1] || ''
      const nextCharacter = characters[cut] || ''
      const isStrongBoundary = /[。！？!?；;]/.test(previousCharacter)
      const isSoftBoundary = /[，、,:：]/.test(previousCharacter)
      const isSpaceBoundary = /\s/.test(previousCharacter) || /\s/.test(nextCharacter)
      const boundaryBonus = isStrongBoundary ? 5 : isSoftBoundary ? 3 : isSpaceBoundary ? 1.5 : 0
      const score = Math.abs(cut - idealCut) - boundaryBonus

      if (score < bestScore) {
        bestCut = cut
        bestScore = score
      }
    }

    return bestCut
  }

  function splitCompareTranslationAcrossLines(translation, sourceLines) {
    const normalizedTranslation = String(translation || '').replace(/\s+/g, ' ').trim()
    if (!sourceLines.length) return []
    if (sourceLines.length === 1) return [normalizedTranslation]

    const characters = Array.from(normalizedTranslation)
    if (!characters.length) return sourceLines.map(() => '')

    const lineMetrics = sourceLines.map(getCompareLineWeight)
    const totalTextUnits = lineMetrics.reduce((sum, metrics) => sum + metrics.textUnits, 0)
    const totalWidth = lineMetrics.reduce((sum, metrics) => sum + metrics.width, 0)
    const weights = lineMetrics.map((metrics) =>
      0.65 * (metrics.textUnits / Math.max(totalTextUnits, 1)) +
      0.35 * (metrics.width / Math.max(totalWidth, 1)),
    )
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
    const parts = []
    let cursor = 0
    let consumedWeight = 0

    for (let index = 0; index < sourceLines.length - 1; index += 1) {
      consumedWeight += weights[index]
      const remainingLines = sourceLines.length - index - 1
      const idealCut = characters.length * (consumedWeight / Math.max(totalWeight, 1))
      const minimumCut = Math.min(characters.length, cursor + (cursor < characters.length ? 1 : 0))
      const maximumCut = Math.max(minimumCut, characters.length - remainingLines)
      const cut = findCompareTranslationCut(characters, idealCut, minimumCut, maximumCut)

      parts.push(characters.slice(cursor, cut).join('').trim())
      cursor = cut
    }

    parts.push(characters.slice(cursor).join('').trim())
    return sourceLines.map((_line, index) => parts[index] || '')
  }

  function getCompareLineAssignments(block) {
    const sourceLines = getCompareSourceBlocks(block)
      .filter((line) => isVisualTranslationLine(line))
    const translations = splitCompareTranslationAcrossLines(block.translation, sourceLines)

    return sourceLines.map((line, index) => ({
      ...line,
      translation: translations[index] || '',
    }))
  }

  function isShortCompareModule(block) {
    const sourceText = cleanOcrSourceForTranslation(block?.text || '')
    const words = sourceText.match(/[A-Za-z][A-Za-z'-]*/g) || []

    return words.length <= 8 || sourceText.length <= 48
  }

  function assessCompareTranslation(block) {
    const sourceText = cleanOcrSourceForTranslation(block?.text || '')
    const translation = cleanResultText(block?.translation || '')
    if (block?.visualLayoutIssue) {
      return { valid: false, reason: block.visualLayoutIssue }
    }
    if (!translation || isUselessTranslationResult(translation)) {
      return { valid: false, reason: 'empty' }
    }
    if (translation.toLowerCase() === sourceText.toLowerCase()) {
      return { valid: false, reason: 'untranslated' }
    }
    if (hasWeirdDiagramTranslationStack(translation, block)) {
      return { valid: false, reason: 'stacked' }
    }
    if (isShortCompareModule(block)) return { valid: true, reason: '' }

    const sourceWords = sourceText.match(/[A-Za-z][A-Za-z'-]*/g) || []
    const targetCjkCharacters = translation.match(/[\u3400-\u9fff]/g) || []
    const targetLatinTokens = translation.match(/[A-Za-z0-9]+/g) || []
    const targetUnits = targetCjkCharacters.length + targetLatinTokens.length
    const minimumTargetUnits = Math.max(8, Math.ceil(sourceWords.length * 0.58))
    const sourceLooksOpen =
      /^[a-z]/.test(sourceText) ||
      /[-,;:(]$/.test(sourceText) ||
      /\b(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|using|via)$/i.test(sourceText)
    const translationLooksOpen =
      /(?:的|和|与|或|及|以及|在|从|向|对|为|由|通过|由于|因为|如果|当|将|被|使|而|但|且|并|从而|以便)[，,;；:]?$/.test(
        translation,
      )
    const sourceEndsSentence = /[.!?]["')\]]*$/.test(sourceText)
    const translationEndsSentence = /[。！？!?]["')\]]*$/.test(translation)

    if (targetUnits < minimumTargetUnits) return { valid: false, reason: 'missing-content' }
    if (
      targetLatinTokens.length >= Math.max(5, Math.ceil(sourceWords.length * 0.45)) &&
      targetCjkCharacters.length < Math.max(4, sourceWords.length * 0.5)
    ) {
      return { valid: false, reason: 'untranslated-residue' }
    }
    if (translationLooksOpen) return { valid: false, reason: 'open-translation' }
    if (sourceLooksOpen && sourceWords.length >= 10) {
      return { valid: false, reason: 'open-source-boundary' }
    }
    if (sourceEndsSentence && !translationEndsSentence && targetUnits < sourceWords.length * 0.9) {
      return { valid: false, reason: 'truncated-sentence' }
    }

    return { valid: true, reason: '' }
  }

  function getVerticalOverlapRatio(firstBlock, secondBlock) {
    const overlap = Math.max(
      0,
      Math.min(getBlockBottom(firstBlock), getBlockBottom(secondBlock)) -
        Math.max(firstBlock.y, secondBlock.y),
    )
    const referenceHeight = Math.max(1, Math.min(firstBlock.height, secondBlock.height))

    return overlap / referenceHeight
  }

  function getCompareModuleMergeScore(firstBlock, secondBlock, attempt) {
    const referenceHeight = Math.max(
      median(getCompareSourceBlocks(firstBlock).map((line) => line.height)),
      median(getCompareSourceBlocks(secondBlock).map((line) => line.height)),
      1,
    )
    const verticalGap = Math.max(
      0,
      Math.max(firstBlock.y, secondBlock.y) -
        Math.min(getBlockBottom(firstBlock), getBlockBottom(secondBlock)),
    )
    const horizontalGap = Math.max(
      0,
      Math.max(firstBlock.x, secondBlock.x) -
        Math.min(getBlockRight(firstBlock), getBlockRight(secondBlock)),
    )
    const horizontalOverlap = getHorizontalOverlapRatio(firstBlock, secondBlock)
    const verticalOverlap = getVerticalOverlapRatio(firstBlock, secondBlock)
    const verticalNeighbor =
      verticalGap <= referenceHeight * (attempt === 1 ? 1.8 : 3.4) &&
      horizontalOverlap >= (attempt === 1 ? 0.42 : 0.24)
    const horizontalNeighbor =
      horizontalGap <= referenceHeight * (attempt === 1 ? 4.2 : 7.5) &&
      verticalOverlap >= (attempt === 1 ? 0.5 : 0.3)

    if (!verticalNeighbor && !horizontalNeighbor) return null

    const verticalScore = verticalGap / referenceHeight + (1 - horizontalOverlap) * 1.15
    const horizontalScore = horizontalGap / referenceHeight + (1 - verticalOverlap) * 1.35 + 0.25

    return Math.min(
      verticalNeighbor ? verticalScore : Infinity,
      horizontalNeighbor ? horizontalScore : Infinity,
    )
  }

  function findCompareBoundaryCandidateIndex(blocks, blockIndex, attempt, consumedIndexes) {
    let bestIndex = -1
    let bestScore = Infinity

    blocks.forEach((candidate, candidateIndex) => {
      if (candidateIndex === blockIndex || consumedIndexes.has(candidateIndex)) return
      const score = getCompareModuleMergeScore(blocks[blockIndex], candidate, attempt)
      if (score === null || score >= bestScore) return

      bestIndex = candidateIndex
      bestScore = score
    })

    return bestIndex
  }

  function splitCompareBlockByStrictBoundaries(block, boundaryReview = false) {
    const sourceLines = getCompareSourceBlocks(block)
    if (sourceLines.length <= 1) {
      return [{ ...block, sourceBlocks: sourceLines }]
    }

    const lineGroups = []
    sourceLines.forEach((line) => {
      const currentGroup = lineGroups[lineGroups.length - 1]
      if (!currentGroup?.length) {
        lineGroups.push([line])
        return
      }

      const currentBlock = mergeOcrBlocks(currentGroup, Number(block.index) || 0)
      if (
        shouldMergeWrappedLine(currentBlock, line, {
          strict: true,
          boundaryReview,
        })
      ) {
        currentGroup.push(line)
      } else {
        lineGroups.push([line])
      }
    })

    if (lineGroups.length === 1) {
      return [{ ...block, sourceBlocks: sourceLines }]
    }

    return lineGroups.map((lines, groupIndex) => {
      const splitBlock = mergeOcrBlocks(lines, (Number(block.index) || 0) + groupIndex / 1000)
      return {
        ...splitBlock,
        moduleId: `${block.moduleId || `m${Number(block.index) + 1 || 1}`}-c${groupIndex + 1}`,
        sourceText: splitBlock.text,
        translation: '',
        formulaRegions: (block.formulaRegions || []).filter((region) =>
          getRectOverlapArea(region, splitBlock) > 0,
        ),
        multimodal: Boolean(block.multimodal),
        compareBoundaryRetries: block.compareBoundaryRetries || 0,
      }
    })
  }

  function mergeCompareModuleBlocks(firstBlock, secondBlock, attempt) {
    const uniqueLines = []
    const lineKeys = new Set()

    ;[...getCompareSourceBlocks(firstBlock), ...getCompareSourceBlocks(secondBlock)]
      .sort((firstLine, secondLine) => firstLine.y - secondLine.y || firstLine.x - secondLine.x)
      .forEach((line) => {
        const lineKey = [
          Math.round(line.x),
          Math.round(line.y),
          Math.round(line.width),
          Math.round(line.height),
          line.text,
        ].join('|')
        if (lineKeys.has(lineKey)) return
        lineKeys.add(lineKey)
        uniqueLines.push(line)
      })

    const merged = mergeOcrBlocks(uniqueLines, Math.min(firstBlock.index, secondBlock.index))

    return {
      ...merged,
      sourceText: merged.text,
      translation: '',
      formulaRegions: [
        ...(firstBlock.formulaRegions || []),
        ...(secondBlock.formulaRegions || []),
      ],
      multimodal: Boolean(firstBlock.multimodal || secondBlock.multimodal),
      compareBoundaryRetries: attempt,
    }
  }

  async function translateCompareModule(block, force = false) {
    const sourceText = cleanOcrSourceForTranslation(block.text)
    const existingTranslation = cleanResultText(block.translation || '')

    if (!force && existingTranslation && !isUselessTranslationResult(existingTranslation)) {
      return {
        ...block,
        sourceText,
        translation: existingTranslation,
      }
    }

    try {
      const translation = cleanResultText(
        await translateOcrBlockText(sourceText, getBlockInlineFormulas(block)),
      )
      if (isUselessTranslationResult(translation)) {
        return getOcrTranslationFallback(block, sourceText, 'empty-translation')
      }

      return {
        ...block,
        sourceText,
        translation,
      }
    } catch (error) {
      return getOcrTranslationFallback(block, sourceText, error.message)
    }
  }

  async function translateCompareBlocks(blocks, reviewOptions = {}) {
    const strictBlocks = blocks
      .filter((item) => isVisualTranslationBlock(item))
      .slice(0, 120)
      .flatMap((block) => splitCompareBlockByStrictBoundaries(block))
    let workingBlocks = await mapWithConcurrency(
      strictBlocks,
      3,
      (block) => translateCompareModule(block),
    )

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const assessments = workingBlocks.map(assessCompareTranslation)
      const incompleteIndexes = assessments
        .map((assessment, index) => (!assessment.valid ? index : -1))
        .filter((index) => index >= 0)
      if (!incompleteIndexes.length) break

      const consumedIndexes = new Set()
      const revisedBlocks = []

      for (const blockIndex of incompleteIndexes) {
        if (consumedIndexes.has(blockIndex)) continue

        const block = workingBlocks[blockIndex]
        const assessment = assessments[blockIndex]
        consumedIndexes.add(blockIndex)
        if (reviewOptions.multimodal) {
          const reviewedBlocks = await reviewVisualModuleBoundary({
            mode: 'compare',
            image: reviewOptions.image,
            imageSize: reviewOptions.imageSize,
            block,
            blocks: workingBlocks,
            attempt,
            reason: assessment.reason,
          })
          const reviewedTextBlocks = reviewedBlocks.filter(isVisualTranslationBlock)
          if (reviewedTextBlocks.length) {
            const translatedReviewedBlocks = await mapWithConcurrency(
              reviewedTextBlocks,
              3,
              (reviewedBlock) => translateCompareModule({
                ...reviewedBlock,
                compareBoundaryRetries: attempt,
              }, true),
            )
            revisedBlocks.push(...translatedReviewedBlocks)
            continue
          }
        }

        const splitBlocks = splitCompareBlockByStrictBoundaries(block, true)
        if (splitBlocks.length > 1) {
          const translatedSplitBlocks = await mapWithConcurrency(
            splitBlocks,
            3,
            (splitBlock) => translateCompareModule({
              ...splitBlock,
              compareBoundaryRetries: attempt,
            }, true),
          )
          revisedBlocks.push(...translatedSplitBlocks)
          continue
        }

        const candidateIndex = findCompareBoundaryCandidateIndex(
          workingBlocks,
          blockIndex,
          attempt,
          consumedIndexes,
        )

        if (candidateIndex >= 0) {
          consumedIndexes.add(candidateIndex)
          const mergedBlock = mergeCompareModuleBlocks(
            workingBlocks[blockIndex],
            workingBlocks[candidateIndex],
            attempt,
          )
          revisedBlocks.push(await translateCompareModule(mergedBlock, true))
        } else {
          revisedBlocks.push(await translateCompareModule({
            ...workingBlocks[blockIndex],
            compareBoundaryRetries: attempt,
          }, true))
        }
      }

      workingBlocks = workingBlocks
        .filter((_block, index) => !consumedIndexes.has(index))
        .concat(revisedBlocks)
        .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
    }

    return workingBlocks.map((block) => {
      const assessment = assessCompareTranslation(block)
      if (assessment.valid) {
        return {
          ...block,
          translationFallback: false,
          translationError: '',
        }
      }
      return getOcrTranslationFallback(
        block,
        cleanOcrSourceForTranslation(block.text),
        block.translationError || assessment.reason,
      )
    })
  }

  function getCompareCanvasFont(fontSize) {
    return `${fontSize}px "Microsoft YaHei", Arial, sans-serif`
  }

  function getPaddedLineBox(segment, canvasWidth, canvasHeight) {
    const paddingX = clampNumber(segment.height * 0.18, 3, 6)
    const paddingY = clampNumber(segment.height * 0.1, 2, 4)
    const x = clampNumber(segment.x - paddingX, 0, canvasWidth - 1)
    const y = clampNumber(segment.y - paddingY, 0, canvasHeight - 1)

    return {
      x,
      y,
      width: Math.max(8, Math.min(segment.width + paddingX * 2, canvasWidth - x)),
      height: Math.max(6, Math.min(segment.height + paddingY * 2, canvasHeight - y)),
      paddingX,
      paddingY,
    }
  }

  function drawDebugLayoutBoxes(context, blocks, canvasWidth, canvasHeight) {
    if (!MULTIMODAL_OCR_DEBUG) return

    context.save()
    context.lineWidth = 1.5
    blocks.forEach((block) => {
      context.strokeStyle = 'rgba(37, 99, 235, 0.9)'
      context.strokeRect(block.x, block.y, Math.min(block.width, canvasWidth - block.x), Math.min(block.height, canvasHeight - block.y))
      context.strokeStyle = 'rgba(220, 38, 38, 0.92)'
      getCompareSourceBlocks(block).forEach((line) => {
        context.strokeRect(line.x, line.y, Math.min(line.width, canvasWidth - line.x), Math.min(line.height, canvasHeight - line.y))
      })
    })
    context.restore()
  }

  function getRectOverlapArea(firstRect, secondRect) {
    const left = Math.max(firstRect.x, secondRect.x)
    const right = Math.min(firstRect.x + firstRect.width, secondRect.x + secondRect.width)
    const top = Math.max(firstRect.y, secondRect.y)
    const bottom = Math.min(firstRect.y + firstRect.height, secondRect.y + secondRect.height)

    return Math.max(0, right - left) * Math.max(0, bottom - top)
  }

  function getRectCenter(rect) {
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    }
  }

  function getRectDistance(firstRect, secondRect) {
    const firstCenter = getRectCenter(firstRect)
    const secondCenter = getRectCenter(secondRect)

    return Math.hypot(firstCenter.x - secondCenter.x, firstCenter.y - secondCenter.y)
  }

  function cleanOcrSourceForTranslation(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\baccompusn\b/gi, 'accomplish')
  }

  function splitOcrTextForTranslation(text, maxLength = 1200) {
    const normalizedText = String(text || '').replace(/\s+/g, ' ').trim()
    const sentences = normalizedText.match(/[^.!?。！？]+[.!?。！？]?/g) || [normalizedText]
    const chunks = []
    let currentChunk = ''

    sentences.forEach((sentence) => {
      const nextChunk = `${currentChunk}${currentChunk ? ' ' : ''}${sentence.trim()}`.trim()

      if (currentChunk && nextChunk.length > maxLength) {
        chunks.push(currentChunk)
        currentChunk = sentence.trim()
        return
      }

      currentChunk = nextChunk
    })

    if (currentChunk) chunks.push(currentChunk)

    return chunks.length ? chunks : [normalizedText]
  }

  function protectOcrFormulaTokens(text) {
    const tokens = []
    const protectedText = String(text || '').replace(
      /\b(?:DNA|RNA|ATP|ADP|AMP|NADH|NADPH|FADH2|FAD|CO[₂2]|NH[₃3]|H[₂2]O|HPO[₄4](?:[²2]?[⁻-])?)\b/gi,
      (match) => {
        const index = tokens.length
        tokens.push(match)
        return `@@OCRF${index}@@`
      },
    )

    return { protectedText, tokens }
  }

  function restoreOcrFormulaTokens(text, tokens) {
    return String(text || '').replace(/@@\s*OCRF\s*(\d+)\s*@@/gi, (_match, index) => tokens[Number(index)] || _match)
  }

  function protectInlineFormulaTokens(text, formulas = []) {
    const tokens = []
    let protectedText = String(text || '')

    formulas
      .map((formula) => String(formula?.text || '').trim())
      .filter(Boolean)
      .sort((firstFormula, secondFormula) => secondFormula.length - firstFormula.length)
      .forEach((formula) => {
        if (!protectedText.includes(formula)) return
        const tokenIndex = tokens.length
        tokens.push(formula)
        protectedText = protectedText.replaceAll(formula, `@@OCRX${tokenIndex}@@`)
      })

    return { protectedText, tokens }
  }

  function restoreInlineFormulaTokens(text, tokens) {
    return String(text || '').replace(/@@\s*OCRX\s*(\d+)\s*@@/gi, (_match, index) => tokens[Number(index)] || _match)
  }

  async function translateOcrBlockText(text, inlineFormulas = []) {
    const inlineProtectedResult = protectInlineFormulaTokens(text, inlineFormulas)
    const protectedResult = protectOcrFormulaTokens(inlineProtectedResult.protectedText)
    const chunks = splitOcrTextForTranslation(protectedResult.protectedText)
    const translations = []

    for (const chunk of chunks) {
      try {
        const translation = cleanResultText(await requestTranslation(chunk))
        if (isUselessTranslationResult(translation)) {
          throw new Error('模型未返回有效译文')
        }
        translations.push(translation)
      } catch (error) {
        console.warn('OCR 模块分段翻译失败', {
          textLength: chunk.length,
          error: error.message,
        })
        throw new Error(error.message || '翻译失败', { cause: error })
      }
    }

    const formulaRestoredText = restoreOcrFormulaTokens(
      translations.join('\n').trim(),
      protectedResult.tokens,
    )

    return restoreInlineFormulaTokens(formulaRestoredText, inlineProtectedResult.tokens)
  }

  function getSelectionWordSimilarity(firstText, secondText) {
    const firstWords = (String(firstText || '').toLowerCase().match(/[a-z]{2,}/g) || [])
    const secondWords = new Set(String(secondText || '').toLowerCase().match(/[a-z]{2,}/g) || [])
    if (!firstWords.length) return secondWords.size ? 0 : 1

    const matchedWords = firstWords.filter((word) => secondWords.has(word))
    return matchedWords.length / firstWords.length
  }

  function applyFormulaCorrectionsToText(text, corrections = []) {
    let correctedText = String(text || '')

    corrections.forEach((correction) => {
      const sourceText = String(correction?.text || '').trim()
      const replacement = String(correction?.replacement || '').trim()
      if (!sourceText || !replacement) return

      const escapedText = sourceText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      correctedText = correctedText.replace(new RegExp(escapedText, 'i'), replacement)
    })

    return cleanOcrSourceForTranslation(correctedText)
  }

  async function recognizeSelectionWithLocalFormulaOcr(text, capture) {
    const originalText = cleanOcrSourceForTranslation(text)
    const detectedFormulas = getInlineFormulaMetadataFromText(originalText, 'selection-text')
    if (!capture?.image || !selectionTextNeedsVisualRepair(originalText)) {
      return {
        text: originalText,
        inlineFormulas: detectedFormulas,
        unresolved: false,
      }
    }

    if (isDenseFormulaOrSymbolText(originalText) || isScientificExpressionOnly(originalText)) {
      try {
        const formulaPipeline = await getInlineFormulaOcrPipeline()
        const output = await formulaPipeline(capture.image, {
          max_new_tokens: 128,
          num_beams: 2,
        })
        const generatedText = Array.isArray(output)
          ? output[0]?.generated_text || output[0]?.text
          : output?.generated_text || output?.text
        const normalizedFormula = normalizeSimpleInlineLatex(generatedText)

        if (normalizedFormula?.text) {
          return {
            text: normalizedFormula.text,
            inlineFormulas: [{
              text: normalizedFormula.text,
              latex: normalizedFormula.latex,
              source: 'local-formula-ocr',
            }],
            unresolved: false,
          }
        }
      } catch (error) {
        console.warn('划词公式 OCR 失败，保留原公式', {
          error: error.message,
        })
      }

      return {
        text: originalText,
        inlineFormulas: detectedFormulas,
        unresolved: selectionTextNeedsVisualRepair(originalText),
      }
    }

    let worker = null

    try {
      worker = await createWorker('eng', 1, {
        workerPath: `${TESSERACT_ASSET_BASE}/worker.min.js`,
        corePath: `${TESSERACT_ASSET_BASE}/core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${TESSERACT_ASSET_BASE}/lang`,
        cacheMethod: 'none',
      })
      const { data } = await worker.recognize(capture.image, {}, { text: true, blocks: true })
      const recognizedText = cleanOcrText(data.text || '')
      const formulaResult = await recognizeInlineFormulaCandidates(
        data,
        capture.image,
        capture,
        [],
      )
      const correctedText = applyFormulaCorrectionsToText(recognizedText, formulaResult.corrections)
      const canUseRecognizedText =
        correctedText &&
        formulaResult.corrections.length > 0 &&
        getSelectionWordSimilarity(originalText, correctedText) >= 0.55
      const inlineFormulas = formulaResult.corrections.map((correction) => ({
        text: correction.replacement,
        latex: correction.latex,
        source: correction.source,
      }))

      return {
        text: canUseRecognizedText ? correctedText : originalText,
        inlineFormulas: inlineFormulas.length ? inlineFormulas : detectedFormulas,
        unresolved:
          formulaResult.unresolvedRects.length > 0 ||
          (selectionTextNeedsVisualRepair(originalText) && formulaResult.corrections.length === 0) ||
          (/�/.test(originalText) && !canUseRecognizedText),
      }
    } catch (error) {
      console.warn('划词局部 OCR 失败，保留 PDF 文本层结果', {
        error: error.message,
      })
      return {
        text: originalText,
        inlineFormulas: detectedFormulas,
        unresolved: selectionTextNeedsVisualRepair(originalText),
      }
    } finally {
      if (worker) await worker.terminate()
    }
  }

  function getMultimodalRecognitionText(blocks = []) {
    return cleanOcrText(
      blocks
        .slice()
        .sort((firstBlock, secondBlock) =>
          (Number(firstBlock.y) || 0) - (Number(secondBlock.y) || 0) ||
          (Number(firstBlock.x) || 0) - (Number(secondBlock.x) || 0),
        )
        .map((block) => block.text)
        .filter(Boolean)
        .join('\n'),
    )
  }

  function getMultimodalRecognitionFormulas(blocks = []) {
    return blocks.flatMap((block) => {
      const blockType = String(block.type || '').toLowerCase()
      const formulas = []

      if (blockType.includes('formula') && block.text) {
        formulas.push({
          text: block.text,
          latex: block.latex,
          source: 'multimodal',
        })
      }
      ;(block.formulaRegions || []).forEach((region) => {
        if (!region.text) return
        formulas.push({
          text: region.text,
          latex: region.latex,
          source: region.source || 'multimodal',
        })
      })
      ;(block.sourceBlocks || []).forEach((line) => {
        const lineType = String(line.type || '').toLowerCase()
        ;(line.formulaRegions || []).forEach((region) => {
          if (!region.text) return
          formulas.push({
            text: region.text,
            latex: region.latex,
            source: region.source || 'multimodal',
          })
        })
        if (!lineType.includes('formula') || !line.text) return
        formulas.push({
          text: line.text,
          latex: line.latex,
          source: 'multimodal',
        })
      })

      return formulas
    })
  }

  function getRecognitionInvalidCharacterCount(text) {
    return Array.from(String(text || '')).filter((character) => {
      const code = character.charCodeAt(0)
      return character === '�' || (code <= 31 && ![9, 10, 13].includes(code))
    }).length
  }

  function shouldPreferMultimodalRecognition(localBlocks = [], multimodalBlocks = []) {
    const localText = cleanOcrText(localBlocks.map((block) => block.text).filter(Boolean).join('\n'))
    const multimodalText = getMultimodalRecognitionText(multimodalBlocks)
    if (!multimodalText) return false
    if (!localText) return true

    const localInvalidCount = getRecognitionInvalidCharacterCount(localText)
    const multimodalInvalidCount = getRecognitionInvalidCharacterCount(multimodalText)
    if (multimodalInvalidCount > localInvalidCount) return false
    if (localInvalidCount > multimodalInvalidCount) return true

    const localUsefulCount = getUsefulOcrCharacterCount(localText)
    const multimodalUsefulCount = getUsefulOcrCharacterCount(multimodalText)
    const wordSimilarity = getSelectionWordSimilarity(localText, multimodalText)
    const multimodalHasFormulaMetadata = multimodalBlocks.some((block) =>
      getOcrBlockContentType(block) === 'formula' ||
      getBlockInlineFormulas(block).length > 0,
    )
    const localHasFormulaMetadata = localBlocks.some((block) =>
      getOcrBlockContentType(block) === 'formula' ||
      getBlockInlineFormulas(block).length > 0,
    )

    if (multimodalHasFormulaMetadata && !localHasFormulaMetadata) {
      return multimodalUsefulCount >= Math.max(1, localUsefulCount * 0.55)
    }

    return (
      multimodalUsefulCount >= Math.max(1, localUsefulCount * 0.75) &&
      wordSimilarity >= 0.5
    )
  }

  async function prepareSelectionTranslation(text, capture) {
    const originalText = cleanOcrSourceForTranslation(text)
    let result = await recognizeSelectionWithLocalFormulaOcr(originalText, capture)

    if (
      capture?.image &&
      settingsSupportMultimodal(settingsFormRef.current) &&
      (result.unresolved || /�/.test(originalText))
    ) {
      try {
        const blocks = await requestMultimodalTextRecognition(
          capture.image,
          capture,
          'selection',
        )
        const multimodalText = getMultimodalRecognitionText(blocks)
        const canUseMultimodalText =
          multimodalText &&
          (
            /�/.test(result.text) ||
            getSelectionWordSimilarity(originalText, multimodalText) >= 0.55
          )

        if (canUseMultimodalText) {
          result = {
            text: multimodalText,
            inlineFormulas: [
              ...getMultimodalRecognitionFormulas(blocks),
              ...getInlineFormulaMetadataFromText(multimodalText, 'multimodal-selection'),
            ],
            unresolved: false,
          }
        }
      } catch (error) {
        console.warn('划词多模态纠错失败，使用本地识别结果', {
          error: error.message,
        })
      }
    }

    const sourceText = cleanOcrSourceForTranslation(result.text || originalText)
    const formulaOnly =
      isScientificExpressionOnly(sourceText) ||
      isDenseFormulaOrSymbolText(sourceText)
    if (formulaOnly) {
      return {
        sourceText,
        translation: sourceText,
        inlineFormulas: result.inlineFormulas,
        preserveOriginal: true,
      }
    }

    return {
      sourceText,
      translation: await translateOcrBlockText(sourceText, result.inlineFormulas),
      inlineFormulas: result.inlineFormulas,
      preserveOriginal: false,
    }
  }

  prepareSelectionTranslationRef.current = prepareSelectionTranslation

  function getOcrTranslationFallback(block, sourceText, reason) {
    return {
      ...block,
      sourceText,
      translation: '',
      translationFallback: true,
      translationError: reason || '翻译失败',
    }
  }

  function clampPlacementRect(candidate, width, height, imageWidth, imageHeight, padding) {
    const safeWidth = Math.min(width, Math.max(40, imageWidth - padding * 2))
    const safeHeight = Math.min(height, Math.max(24, imageHeight - padding * 2))

    return {
      x: Math.min(Math.max(padding, candidate.x), imageWidth - safeWidth - padding),
      y: Math.min(Math.max(padding, candidate.y), imageHeight - safeHeight - padding),
      width: safeWidth,
      height: safeHeight,
      type: candidate.type,
      priority: candidate.priority,
    }
  }

  function getPlacementCandidates(block, labelWidth, labelHeight, imageWidth, imageHeight) {
    const gap = Math.max(6, block.height * 0.45)
    const nudge = Math.max(12, block.height * 1.15)
    const centerY = block.y + block.height / 2 - labelHeight / 2
    const centerX = block.x + block.width / 2 - labelWidth / 2
    const candidates = [
      { type: 'right', priority: 0, x: block.x + block.width + gap, y: centerY },
      { type: 'left', priority: 1, x: block.x - labelWidth - gap, y: centerY },
      { type: 'bottom', priority: 2, x: block.x, y: block.y + block.height + gap },
      { type: 'top', priority: 3, x: block.x, y: block.y - labelHeight - gap },
      { type: 'right-top', priority: 4, x: block.x + block.width + gap, y: block.y - labelHeight - gap },
      { type: 'right-bottom', priority: 4, x: block.x + block.width + gap, y: block.y + block.height + gap },
      { type: 'bottom-right', priority: 5, x: block.x + nudge, y: block.y + block.height + gap },
      { type: 'bottom-left', priority: 5, x: block.x - nudge, y: block.y + block.height + gap },
      { type: 'top-right', priority: 6, x: block.x + nudge, y: block.y - labelHeight - gap },
      { type: 'top-left', priority: 6, x: block.x - nudge, y: block.y - labelHeight - gap },
      { type: 'left-top', priority: 7, x: block.x - labelWidth - gap, y: block.y - labelHeight - gap },
      { type: 'left-bottom', priority: 7, x: block.x - labelWidth - gap, y: block.y + block.height + gap },
      { type: 'center-bottom', priority: 8, x: centerX, y: block.y + block.height + nudge },
      { type: 'center-top', priority: 8, x: centerX, y: block.y - labelHeight - nudge },
    ]
    const searchRadius = Math.min(
      Math.max(imageWidth * 0.35, imageHeight * 0.28, block.width * 2.5, 140),
      Math.max(imageWidth, imageHeight) * 0.62,
    )
    const minX = Math.max(8, block.x - searchRadius * 0.35)
    const maxX = Math.min(imageWidth - labelWidth - 8, block.x + block.width + searchRadius)
    const minY = Math.max(8, block.y - searchRadius * 0.55)
    const maxY = Math.min(imageHeight - labelHeight - 8, block.y + block.height + searchRadius * 0.55)
    const stepX = Math.max(28, labelWidth * 0.55)
    const stepY = Math.max(24, labelHeight * 0.7)

    for (let x = block.x + block.width + gap; x <= maxX; x += stepX) {
      candidates.push({ type: 'nearby-right-space', priority: 9, x, y: centerY })
      candidates.push({ type: 'nearby-right-space', priority: 9, x, y: block.y + block.height + gap })
      candidates.push({ type: 'nearby-right-space', priority: 10, x, y: block.y - labelHeight - gap })
    }

    for (let y = minY; y <= maxY; y += stepY) {
      candidates.push({ type: 'nearby-space', priority: 11, x: block.x + block.width + gap, y })
      candidates.push({ type: 'nearby-space', priority: 12, x: centerX, y })
    }

    for (let x = minX; x <= maxX; x += stepX) {
      for (let y = minY; y <= maxY; y += stepY) {
        candidates.push({ type: 'nearby-grid', priority: 13, x, y })
      }
    }

    return candidates
  }

  function getImageBlankScore(context, rect, imageWidth, imageHeight) {
    const sampleX = Math.max(0, Math.floor(rect.x))
    const sampleY = Math.max(0, Math.floor(rect.y))
    const sampleWidth = Math.max(1, Math.min(Math.floor(rect.width), imageWidth - sampleX))
    const sampleHeight = Math.max(1, Math.min(Math.floor(rect.height), imageHeight - sampleY))

    if (!sampleWidth || !sampleHeight) return 0

    try {
      const imageData = context.getImageData(sampleX, sampleY, sampleWidth, sampleHeight).data
      const pixelStep = Math.max(1, Math.floor((sampleWidth * sampleHeight) / 160))
      let previousBrightness = null
      let brightnessTotal = 0
      let edgeTotal = 0
      let samples = 0

      for (let pixelIndex = 0; pixelIndex < sampleWidth * sampleHeight; pixelIndex += pixelStep) {
        const dataIndex = pixelIndex * 4
        const brightness =
          (imageData[dataIndex] * 0.299 + imageData[dataIndex + 1] * 0.587 + imageData[dataIndex + 2] * 0.114) /
          255

        brightnessTotal += brightness
        if (previousBrightness !== null) {
          edgeTotal += Math.abs(brightness - previousBrightness)
        }
        previousBrightness = brightness
        samples += 1
      }

      const averageBrightness = brightnessTotal / Math.max(samples, 1)
      const edgeDensity = edgeTotal / Math.max(samples - 1, 1)
      const whiteBonus = averageBrightness > 0.82 ? 0.25 : 0

      return clampNumber(averageBrightness - edgeDensity * 2.2 + whiteBonus, 0, 1)
    } catch {
      return 0.45
    }
  }

  function getPathSegments(points = []) {
    return points.slice(1).map((point, index) => ({
      start: points[index],
      end: point,
    }))
  }

  function getPointOrientation(firstPoint, secondPoint, thirdPoint) {
    return (
      (secondPoint.y - firstPoint.y) * (thirdPoint.x - secondPoint.x) -
      (secondPoint.x - firstPoint.x) * (thirdPoint.y - secondPoint.y)
    )
  }

  function doLineSegmentsIntersect(firstSegment, secondSegment) {
    const firstOrientation = getPointOrientation(
      firstSegment.start,
      firstSegment.end,
      secondSegment.start,
    )
    const secondOrientation = getPointOrientation(
      firstSegment.start,
      firstSegment.end,
      secondSegment.end,
    )
    const thirdOrientation = getPointOrientation(
      secondSegment.start,
      secondSegment.end,
      firstSegment.start,
    )
    const fourthOrientation = getPointOrientation(
      secondSegment.start,
      secondSegment.end,
      firstSegment.end,
    )

    return (
      ((firstOrientation > 0 && secondOrientation < 0) ||
        (firstOrientation < 0 && secondOrientation > 0)) &&
      ((thirdOrientation > 0 && fourthOrientation < 0) ||
        (thirdOrientation < 0 && fourthOrientation > 0))
    )
  }

  function doesLineSegmentCrossRect(segment, rect) {
    const edges = [
      [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }],
      [{ x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }],
      [{ x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }],
      [{ x: rect.x, y: rect.y + rect.height }, { x: rect.x, y: rect.y }],
    ]

    return edges.some(([start, end]) =>
      doLineSegmentsIntersect(segment, { start, end }),
    )
  }

  function scoreConnectorPath(points, obstacleRects, existingPaths) {
    const segments = getPathSegments(points)
    const obstacleCount = obstacleRects.reduce(
      (count, rect) =>
        count + (segments.some((segment) => doesLineSegmentCrossRect(segment, rect)) ? 1 : 0),
      0,
    )
    const crossingCount = existingPaths.reduce(
      (count, path) =>
        count + getPathSegments(path).filter((existingSegment) =>
          segments.some((segment) => doLineSegmentsIntersect(segment, existingSegment)),
        ).length,
      0,
    )
    const length = segments.reduce(
      (sum, segment) =>
        sum + Math.hypot(
          segment.end.x - segment.start.x,
          segment.end.y - segment.start.y,
        ),
      0,
    )

    return obstacleCount * 8 + crossingCount * 3 + length * 0.002
  }

  function getDiagramConnectorPath(sourceRect, translationRect, obstacleRects, existingPaths) {
    const connector = getDiagramConnectorPoints(sourceRect, translationRect)
    const directPath = [connector.start, connector.end]
    if (scoreConnectorPath(directPath, obstacleRects, existingPaths) < 1) {
      return directPath
    }

    const horizontalFirst = [
      connector.start,
      { x: connector.end.x, y: connector.start.y },
      connector.end,
    ]
    const verticalFirst = [
      connector.start,
      { x: connector.start.x, y: connector.end.y },
      connector.end,
    ]

    return [directPath, horizontalFirst, verticalFirst]
      .map((points) => ({
        points,
        score: scoreConnectorPath(points, obstacleRects, existingPaths),
      }))
      .sort((firstPath, secondPath) => firstPath.score - secondPath.score)[0].points
  }

  function scorePlacementCandidate(
    rect,
    block,
    placedRects,
    sourceRects,
    placedConnectorPaths,
    context,
    imageWidth,
    imageHeight,
  ) {
    const rectArea = rect.width * rect.height
    const sourceOverlap = sourceRects.reduce((sum, sourceRect) => sum + getRectOverlapArea(rect, sourceRect), 0)
    const placedOverlap = placedRects.reduce((sum, placedRect) => sum + getRectOverlapArea(rect, placedRect), 0)
    const sourceOverlapRatio = sourceOverlap / Math.max(rectArea, 1)
    const placedOverlapRatio = placedOverlap / Math.max(rectArea, 1)
    const distance = getRectDistance(rect, block)
    const maxUsefulDistance = Math.max(80, Math.min(imageWidth, imageHeight) * 0.42)
    const distanceScore = clampNumber(1 - distance / maxUsefulDistance, 0, 1)
    const blankScore = getImageBlankScore(context, rect, imageWidth, imageHeight)
    const isRightSide = rect.x >= block.x + block.width * 0.72
    const isLeftSide = rect.x + rect.width <= block.x + block.width * 0.28
    const rightSpace =
      imageWidth - (block.x + block.width) > rect.width * 1.05 && Math.abs(getRectCenter(rect).y - getRectCenter(block).y) < block.height * 3
    const leftSpace = block.x > rect.width * 1.05 && Math.abs(getRectCenter(rect).y - getRectCenter(block).y) < block.height * 3
    const sideBonus = isRightSide && rightSpace ? 0.24 : isLeftSide && leftSpace ? 0.16 : 0
    const candidatePriorityPenalty = rect.priority * 0.035
    const connector = getDiagramConnectorPoints(block, rect)
    const connectorCrossings = placedConnectorPaths.reduce(
      (count, path) =>
        count + getPathSegments(path).filter((segment) =>
          doLineSegmentsIntersect(
            { start: connector.start, end: connector.end },
            segment,
          ),
        ).length,
      0,
    )

    return (
      blankScore * 0.42 +
      distanceScore * 0.34 +
      sideBonus -
      sourceOverlapRatio * 4.8 -
      placedOverlapRatio * 7.2 -
      connectorCrossings * 0.85 -
      candidatePriorityPenalty
    )
  }

  function drawRoundedRect(context, x, y, width, height, radius) {
    const nextRadius = Math.min(radius, width / 2, height / 2)

    context.beginPath()
    context.moveTo(x + nextRadius, y)
    context.lineTo(x + width - nextRadius, y)
    context.quadraticCurveTo(x + width, y, x + width, y + nextRadius)
    context.lineTo(x + width, y + height - nextRadius)
    context.quadraticCurveTo(x + width, y + height, x + width - nextRadius, y + height)
    context.lineTo(x + nextRadius, y + height)
    context.quadraticCurveTo(x, y + height, x, y + height - nextRadius)
    context.lineTo(x, y + nextRadius)
    context.quadraticCurveTo(x, y, x + nextRadius, y)
    context.closePath()
  }

  function getOverlayStyleForMode(mode) {
    if (mode === 'compare') {
      return {
        background: 'rgba(250, 250, 250, 0.95)',
        border: 'rgba(120, 130, 150, 0.52)',
        shadow: 'rgba(15, 23, 42, 0.22)',
        text: '#111827',
        shadowBlur: 5,
        shadowOffsetY: 1.5,
      }
    }

    return {
      background: 'rgba(255, 255, 255, 0.86)',
      border: 'rgba(37, 99, 235, 0.45)',
      shadow: 'rgba(15, 23, 42, 0.24)',
      text: '#0f172a',
      shadowBlur: 6,
      shadowOffsetY: 2,
    }
  }

  function chooseDiagramLabelRect(
    block,
    labelWidth,
    labelHeight,
    imageWidth,
    imageHeight,
    placedRects,
    sourceRects,
    placedConnectorPaths,
    context,
  ) {
    const padding = 8
    const safeWidth = Math.min(labelWidth, Math.max(40, imageWidth - padding * 2))
    const safeHeight = Math.min(labelHeight, Math.max(24, imageHeight - padding * 2))
    const scoredCandidates = getPlacementCandidates(block, safeWidth, safeHeight, imageWidth, imageHeight)
      .map((candidate) =>
        clampPlacementRect(candidate, safeWidth, safeHeight, imageWidth, imageHeight, padding),
      )
      .map((rect) => ({
        rect,
        score: scorePlacementCandidate(
          rect,
          block,
          placedRects,
          sourceRects,
          placedConnectorPaths,
          context,
          imageWidth,
          imageHeight,
        ),
      }))

    scoredCandidates.sort((firstCandidate, secondCandidate) => secondCandidate.score - firstCandidate.score)
    return scoredCandidates[0].rect
  }

  function getDiagramSourceRects(blocks) {
    return blocks.flatMap((block) => getCompareSourceBlocks(block)).map((block) => ({
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
    }))
  }

  function getDiagramLabelPlan(context, block, imageWidth, imageHeight) {
    const sourceLines = getCompareSourceBlocks(block)
    const sourceLineHeights = sourceLines.map((line) => line.height).filter((height) => height > 0)
    const baseLineHeight = median(sourceLineHeights) || block.height || 14
    const maxFontSize = clampNumber(Math.floor(baseLineHeight * 0.86), 12, 20)
    const minFontSize = 10
    const maxLabelWidth = Math.min(
      imageWidth - 16,
      Math.max(96, Math.min(imageWidth * 0.46, Math.max(block.width * 1.75, 130))),
    )
    const horizontalPadding = 8
    const verticalPadding = 5
    let fallback = null

    for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
      context.font = getCompareCanvasFont(fontSize)
      const lineHeight = fontSize * 1.28
      const lines = wrapCanvasText(context, block.translation, maxLabelWidth - horizontalPadding * 2)
      const textWidth = Math.min(
        maxLabelWidth,
        Math.max(...lines.map((line) => context.measureText(line).width), 24) + horizontalPadding * 2,
      )
      const textHeight = lines.length * lineHeight + verticalPadding * 2

      fallback = {
        lines,
        fontSize,
        lineHeight,
        width: textWidth,
        height: textHeight,
        horizontalPadding,
        verticalPadding,
      }

      if (textHeight <= imageHeight - 16) return fallback
    }

    return fallback
  }

  function splitDiagramBlockByStrictBoundaries(block, boundaryReview = false) {
    const sourceLines = getCompareSourceBlocks(block)
    if (sourceLines.length <= 1) {
      return [{
        ...block,
        sourceBlocks: sourceLines,
      }]
    }

    const lineGroups = []

    sourceLines.forEach((line) => {
      const currentGroup = lineGroups[lineGroups.length - 1]
      if (!currentGroup?.length) {
        lineGroups.push([line])
        return
      }

      const currentBlock = mergeOcrBlocks(currentGroup, Number(block.index) || 0)
      if (
        shouldMergeWrappedLine(currentBlock, line, {
          strict: true,
          diagram: true,
          boundaryReview,
        })
      ) {
        currentGroup.push(line)
        return
      }

      lineGroups.push([line])
    })

    if (lineGroups.length === 1) {
      return [{
        ...block,
        sourceBlocks: sourceLines,
      }]
    }

    return lineGroups.map((lines, groupIndex) => {
      const splitBlock = mergeOcrBlocks(lines, (Number(block.index) || 0) + groupIndex / 1000)

      return {
        ...splitBlock,
        moduleId: `${block.moduleId || `m${Number(block.index) + 1 || 1}`}-s${groupIndex + 1}`,
        sourceText: splitBlock.text,
        translation: '',
        formulaRegions: (block.formulaRegions || []).filter((region) =>
          getRectOverlapArea(region, splitBlock) > 0,
        ),
        multimodal: Boolean(block.multimodal),
        diagramBoundarySplit: true,
      }
    })
  }

  function getDiagramTranslationUnits(text) {
    const cjkCharacters = String(text || '').match(/[\u3400-\u9fff]/g) || []
    const latinTokens = String(text || '').match(/[A-Za-z0-9]+/g) || []

    return cjkCharacters.length + latinTokens.length
  }

  function hasWeirdDiagramTranslationStack(translation, block) {
    const normalizedTranslation = cleanResultText(translation || '').trim()
    if (!normalizedTranslation) return true

    const compactTranslation = normalizedTranslation.replace(/\s+/g, '')
    const sourceLines = getCompareSourceBlocks(block)
    const sentenceParts = normalizedTranslation
      .split(/[\n。！？!?；;]+/)
      .map((part) => part.replace(/[\s，、,:：]/g, '').trim())
      .filter((part) => part.length >= 2)
    const seenParts = new Set()
    const hasRepeatedPart = sentenceParts.some((part) => {
      const key = part.toLowerCase()
      if (seenParts.has(key)) return true
      seenParts.add(key)
      return false
    })
    const lineCount = normalizedTranslation.split(/\n+/).filter((line) => line.trim()).length
    const sourceText = cleanOcrSourceForTranslation(block?.text || '')
    const sourceWords = sourceText.match(/[A-Za-z][A-Za-z'-]*/g) || []
    const targetUnits = getDiagramTranslationUnits(normalizedTranslation)

    if (getRecognitionInvalidCharacterCount(normalizedTranslation) > 0) return true
    if (/(.)\1{4,}/u.test(compactTranslation)) return true
    if (/(.{2,12})(?:\1){2,}/u.test(compactTranslation)) return true
    if (hasRepeatedPart) return true
    if (lineCount > Math.max(3, sourceLines.length * 2 + 1)) return true
    if (targetUnits > Math.max(70, sourceWords.length * 5.5)) return true

    return false
  }

  function assessDiagramTranslation(block) {
    const sourceText = cleanOcrSourceForTranslation(block?.text || '')
    const translation = cleanResultText(block?.translation || '')
    const sourceWords = sourceText.match(/[A-Za-z][A-Za-z'-]*/g) || []
    const isShort = sourceWords.length <= 8 || sourceText.length <= 48

    if (block?.visualLayoutIssue) {
      return {
        valid: false,
        isShort,
        needsExpansion: false,
        reason: block.visualLayoutIssue,
      }
    }
    if (!translation || isUselessTranslationResult(translation)) {
      return { valid: false, isShort, needsExpansion: !isShort, reason: 'empty' }
    }
    if (translation.toLowerCase() === sourceText.toLowerCase()) {
      const canRemainUntranslated =
        isLikelyFormulaOrTableLine(sourceText) ||
        /^(?:[A-Z0-9]{1,12}|pH)$/.test(sourceText)
      if (canRemainUntranslated) {
        return { valid: true, isShort, needsExpansion: false, reason: '' }
      }
      return { valid: false, isShort, needsExpansion: !isShort, reason: 'untranslated' }
    }
    if (hasWeirdDiagramTranslationStack(translation, block)) {
      return { valid: false, isShort, needsExpansion: false, reason: 'stacked' }
    }

    const targetUnits = getDiagramTranslationUnits(translation)
    if (isShort) {
      return { valid: true, isShort, needsExpansion: false, reason: '' }
    }

    const minimumTargetUnits = Math.max(8, Math.ceil(sourceWords.length * 0.58))
    const targetCjkCharacters = translation.match(/[\u3400-\u9fff]/g) || []
    const targetLatinTokens = translation.match(/[A-Za-z0-9]+/g) || []
    const sourceLooksOpen =
      /^[a-z]/.test(sourceText) ||
      /[-,;:(（]$/.test(sourceText) ||
      /\b(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|using|via)$/i.test(sourceText)
    const translationLooksOpen =
      /(?:的|和|与|或|及|以及|在|从|向|对|为|由|通过|由于|因为|如果|当|将|被|使|而|但|且|并|从而|以便)[，,;；:]?$/.test(
        translation,
      )
    const sourceEndsSentence = /[.!?]["')\]]*$/.test(sourceText)
    const translationEndsSentence = /[。！？!?]["')\]]*$/.test(translation)

    if (targetUnits < minimumTargetUnits) {
      return { valid: false, isShort, needsExpansion: true, reason: 'missing-content' }
    }
    if (
      targetLatinTokens.length >= Math.max(5, Math.ceil(sourceWords.length * 0.45)) &&
      targetCjkCharacters.length < Math.max(4, sourceWords.length * 0.5)
    ) {
      return { valid: false, isShort, needsExpansion: false, reason: 'untranslated-residue' }
    }
    if (sourceLooksOpen || translationLooksOpen) {
      return { valid: false, isShort, needsExpansion: true, reason: 'open-boundary' }
    }
    if (sourceEndsSentence && !translationEndsSentence && targetUnits < sourceWords.length * 0.9) {
      return { valid: false, isShort, needsExpansion: true, reason: 'truncated-sentence' }
    }

    return { valid: true, isShort, needsExpansion: false, reason: '' }
  }

  function getDiagramBoundaryMergeScore(firstBlock, secondBlock, attempt) {
    const firstComesFirst =
      firstBlock.y < secondBlock.y ||
      (Math.abs(firstBlock.y - secondBlock.y) < Math.max(firstBlock.height, secondBlock.height) * 0.45 &&
        firstBlock.x <= secondBlock.x)
    const previousBlock = firstComesFirst ? firstBlock : secondBlock
    const nextBlock = firstComesFirst ? secondBlock : firstBlock
    const previousLine = getLastSourceLine(previousBlock)
    const nextLine = getFirstSourceLine(nextBlock)
    const previousText = String(previousLine.text || '').trim()
    const nextText = String(nextLine.text || '').trim()
    const previousWords = getWordCount(previousText)
    const nextWords = getWordCount(nextText)
    const previousEndsOpen =
      /[-,(（/:：]$/.test(previousText) ||
      /\b(of|by|for|with|from|to|in|on|at|and|or|the|a|an|into|under|over|between|within|using|via)$/i.test(previousText)
    const nextContinues = /^[a-z(（]/.test(nextText) || isLikelyContinuationLine(nextText)
    const longBodyContinuation =
      previousWords >= (attempt === 1 ? 7 : 6) &&
      nextWords >= 3 &&
      !hasSentenceEnding(previousText)

    if (hasSentenceEnding(previousText) && !/[:：]$/.test(previousText)) return null
    if (previousWords <= 4 && nextWords <= 4 && /^[A-Z0-9]/.test(nextText) && !previousEndsOpen) return null
    if (!previousEndsOpen && !nextContinues && !longBodyContinuation) return null

    const geometricScore = getCompareModuleMergeScore(firstBlock, secondBlock, attempt)
    if (geometricScore === null) return null

    return geometricScore +
      (previousEndsOpen ? 0 : 0.2) +
      (nextContinues ? 0 : 0.2)
  }

  function findDiagramBoundaryCandidateIndex(blocks, blockIndex, attempt, consumedIndexes) {
    let bestIndex = -1
    let bestScore = Infinity

    blocks.forEach((candidate, candidateIndex) => {
      if (candidateIndex === blockIndex || consumedIndexes.has(candidateIndex)) return
      const score = getDiagramBoundaryMergeScore(blocks[blockIndex], candidate, attempt)
      if (score === null || score >= bestScore) return

      bestIndex = candidateIndex
      bestScore = score
    })

    return bestIndex
  }

  function mergeDiagramModuleBlocks(firstBlock, secondBlock, attempt) {
    const uniqueLines = []
    const lineKeys = new Set()

    ;[...getCompareSourceBlocks(firstBlock), ...getCompareSourceBlocks(secondBlock)]
      .sort((firstLine, secondLine) => firstLine.y - secondLine.y || firstLine.x - secondLine.x)
      .forEach((line) => {
        const lineKey = [
          Math.round(line.x),
          Math.round(line.y),
          Math.round(line.width),
          Math.round(line.height),
          line.text,
        ].join('|')
        if (lineKeys.has(lineKey)) return
        lineKeys.add(lineKey)
        uniqueLines.push(line)
      })

    const merged = mergeOcrBlocks(uniqueLines, Math.min(firstBlock.index, secondBlock.index))

    return {
      ...merged,
      sourceText: merged.text,
      translation: '',
      formulaRegions: [
        ...(firstBlock.formulaRegions || []),
        ...(secondBlock.formulaRegions || []),
      ],
      multimodal: Boolean(firstBlock.multimodal || secondBlock.multimodal),
      diagramBoundaryRetries: attempt,
    }
  }

  async function translateDiagramModule(block, force = false) {
    const sourceText = cleanOcrSourceForTranslation(block.text)
    const existingTranslation = cleanResultText(block.translation || '')

    if (!force && existingTranslation && !isUselessTranslationResult(existingTranslation)) {
      return {
        ...block,
        sourceText,
        translation: existingTranslation,
      }
    }

    try {
      const translation = cleanResultText(
        await translateOcrBlockText(sourceText, getBlockInlineFormulas(block)),
      )
      if (isUselessTranslationResult(translation)) {
        return getOcrTranslationFallback(block, sourceText, 'empty-translation')
      }

      return {
        ...block,
        sourceText,
        translation,
        translationFallback: false,
        translationError: '',
      }
    } catch (error) {
      console.warn('OCR 图解模式单模块翻译失败，保留原图区域', {
        text: block.text,
        error: error.message,
      })
      return getOcrTranslationFallback(block, sourceText, error.message)
    }
  }

  async function translateDiagramBlocks(blocks, reviewOptions = {}) {
    const strictBlocks = blocks
      .filter((item) => isVisualTranslationBlock(item))
      .flatMap((block) => splitDiagramBlockByStrictBoundaries(block))
    let workingBlocks = await mapWithConcurrency(
      strictBlocks,
      3,
      (block) => translateDiagramModule(block),
    )

    console.log('OCR 图解模块翻译统计', {
      inputCount: blocks.length,
      strictModuleCount: strictBlocks.length,
      skippedCount: Math.max(0, blocks.length - strictBlocks.length),
      moduleTextLengths: strictBlocks.slice(0, 20).map((block) => block.text.length),
    })

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const assessments = workingBlocks.map(assessDiagramTranslation)
      const invalidIndexes = assessments
        .map((assessment, index) => (!assessment.valid ? index : -1))
        .filter((index) => index >= 0)
      if (!invalidIndexes.length) break

      const consumedIndexes = new Set()
      const revisedBlocks = []

      for (const blockIndex of invalidIndexes) {
        if (consumedIndexes.has(blockIndex)) continue

        const block = workingBlocks[blockIndex]
        const assessment = assessments[blockIndex]
        const splitBlocks = splitDiagramBlockByStrictBoundaries(block, true)
        consumedIndexes.add(blockIndex)

        if (reviewOptions.multimodal) {
          const reviewedBlocks = await reviewVisualModuleBoundary({
            mode: 'diagram',
            image: reviewOptions.image,
            imageSize: reviewOptions.imageSize,
            block,
            blocks: workingBlocks,
            attempt,
            reason: assessment.reason,
          })
          const reviewedTextBlocks = reviewedBlocks.filter(isVisualTranslationBlock)
          if (reviewedTextBlocks.length) {
            const translatedReviewedBlocks = await mapWithConcurrency(
              reviewedTextBlocks,
              3,
              (reviewedBlock) => translateDiagramModule({
                ...reviewedBlock,
                diagramBoundaryRetries: attempt,
              }, true),
            )
            revisedBlocks.push(...translatedReviewedBlocks)
            continue
          }
        }

        if (splitBlocks.length > 1) {
          for (const splitBlock of splitBlocks) {
            revisedBlocks.push(await translateDiagramModule({
              ...splitBlock,
              diagramBoundaryRetries: attempt,
            }, true))
          }
          continue
        }

        const candidateIndex = assessment.needsExpansion
          ? findDiagramBoundaryCandidateIndex(workingBlocks, blockIndex, attempt, consumedIndexes)
          : -1

        if (candidateIndex >= 0) {
          consumedIndexes.add(candidateIndex)
          const mergedBlock = mergeDiagramModuleBlocks(block, workingBlocks[candidateIndex], attempt)
          revisedBlocks.push(await translateDiagramModule(mergedBlock, true))
        } else {
          revisedBlocks.push(await translateDiagramModule({
            ...block,
            diagramBoundaryRetries: attempt,
            diagramComplianceReason: assessment.reason,
          }, true))
        }
      }

      workingBlocks = workingBlocks
        .filter((_block, index) => !consumedIndexes.has(index))
        .concat(revisedBlocks)
        .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
    }

    console.log('OCR 图解模块合规复检', {
      moduleCount: workingBlocks.length,
      modules: workingBlocks.slice(0, 30).map((block) => ({
        text: block.text,
        assessment: assessDiagramTranslation(block),
        boundaryRetries: block.diagramBoundaryRetries || 0,
      })),
    })

    const completedBlocks = workingBlocks.map((block) => {
      const assessment = assessDiagramTranslation(block)
      if (assessment.valid) {
        return {
          ...block,
          translationFallback: false,
          translationError: '',
        }
      }
      return getOcrTranslationFallback(
        block,
        cleanOcrSourceForTranslation(block.text),
        block.translationError || assessment.reason,
      )
    })

    return completedBlocks.map((block, index) => ({
      ...block,
      index,
    }))
  }

  function normalizeMultimodalCoordinate(value, total) {
    const number = Number(value)
    if (!Number.isFinite(number)) return null
    if (number >= 0 && number <= 1 && total > 1) return number * total
    return number
  }

  function normalizeMultimodalRect(item = {}, imageSize = {}) {
    const imageWidth = Number(imageSize.width) || 0
    const imageHeight = Number(imageSize.height) || 0
    const bbox = Array.isArray(item.bbox)
      ? { x: item.bbox[0], y: item.bbox[1], width: item.bbox[2], height: item.bbox[3] }
      : item.bbox || item.box || item.boundingBox || item.rect || item
    const rawX = bbox.x ?? bbox.left ?? bbox.x0
    const rawY = bbox.y ?? bbox.top ?? bbox.y0
    const rawWidth = bbox.width ?? (Number.isFinite(Number(bbox.x1)) && Number.isFinite(Number(rawX)) ? Number(bbox.x1) - Number(rawX) : undefined)
    const rawHeight = bbox.height ?? (Number.isFinite(Number(bbox.y1)) && Number.isFinite(Number(rawY)) ? Number(bbox.y1) - Number(rawY) : undefined)
    const x = normalizeMultimodalCoordinate(rawX, imageWidth)
    const y = normalizeMultimodalCoordinate(rawY, imageHeight)
    const width = normalizeMultimodalCoordinate(rawWidth, imageWidth)
    const height = normalizeMultimodalCoordinate(rawHeight, imageHeight)

    if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null
    const nextX = clampNumber(x, 0, Math.max(imageWidth - 1, 0))
    const nextY = clampNumber(y, 0, Math.max(imageHeight - 1, 0))

    return {
      x: nextX,
      y: nextY,
      width: Math.max(1, Math.min(width, Math.max(imageWidth - nextX, 1))),
      height: Math.max(1, Math.min(height, Math.max(imageHeight - nextY, 1))),
    }
  }

  function getMultimodalTextValue(item = {}, fields = []) {
    for (const field of fields) {
      const value = item[field]
      if (value === null || value === undefined) continue
      const text = String(value).trim()
      if (text) return text
    }

    return ''
  }

  function normalizeMultimodalConfidence(value, fallback = 100) {
    const confidence = Number(value)
    return Number.isFinite(confidence)
      ? clampNumber(confidence, 0, 100)
      : fallback
  }

  function normalizeMultimodalFormulaRegions(item = {}, imageSize = {}) {
    const regions = Array.isArray(item.formulaRegions)
      ? item.formulaRegions
      : Array.isArray(item.formula_regions)
        ? item.formula_regions
        : Array.isArray(item.inlineFormulas)
          ? item.inlineFormulas
          : []

    return regions
      .map((region, index) => {
        const rect = normalizeMultimodalRect(region, imageSize)
        const text = cleanOcrSourceForTranslation(
          getMultimodalTextValue(region, ['original', 'text', 'sourceText', 'formula']),
        )
        if (!rect || !text) return null

        return {
          id: region.id || region.formulaId || `formula-${index + 1}`,
          type: String(region.type || 'inline_formula'),
          text,
          latex: String(region.latex || region.tex || '').trim(),
          confidence: normalizeMultimodalConfidence(region.confidence),
          ...rect,
        }
      })
      .filter(Boolean)
  }

  function getMultimodalUnionRect(rects) {
    if (!rects.length) return null

    const x0 = Math.min(...rects.map((rect) => rect.x))
    const y0 = Math.min(...rects.map((rect) => rect.y))
    const x1 = Math.max(...rects.map((rect) => rect.x + rect.width))
    const y1 = Math.max(...rects.map((rect) => rect.y + rect.height))

    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  function normalizeMultimodalTranslationBlocks(rawBlocks = [], imageSize = {}, options = {}) {
    return (Array.isArray(rawBlocks) ? rawBlocks : [])
      .map((block, index) => {
        const sourceBlocks = (Array.isArray(block?.sourceBlocks) && block.sourceBlocks.length
          ? block.sourceBlocks
          : Array.isArray(block?.lines)
            ? block.lines
            : []
        )
          .map((line, lineIndex) => {
            const rect = normalizeMultimodalRect(line, imageSize)
            const text = cleanOcrSourceForTranslation(getMultimodalTextValue(line, ['original', 'text', 'sourceText', 'originalText', 'lineText']))
            const translation = cleanResultText(getMultimodalTextValue(line, ['translation', 'translatedText', 'targetText', 'result']))
            if (!rect || !text) return null

            return {
              index: lineIndex,
              lineId: line.lineId || line.id || `${index}-${lineIndex}`,
              type: String(line.type || line.contentType || 'text'),
              text,
              sourceText: text,
              translation: isUselessTranslationResult(translation) ? '' : translation,
              latex: String(line.latex || line.tex || '').trim(),
              symbolDensity: Math.max(0, Math.min(1, Number(line.symbolDensity || line.symbol_density) || 0)),
              formulaRegions: normalizeMultimodalFormulaRegions(line, imageSize),
              ...rect,
              fontSize: Math.max(
                1,
                Number(line.fontSize || line.font_size || line.font?.size) || rect.height * 0.82,
              ),
              confidence: normalizeMultimodalConfidence(line.confidence),
            }
          })
          .filter(Boolean)
        const formulaRegions = [
          ...normalizeMultimodalFormulaRegions(block, imageSize),
          ...sourceBlocks.flatMap((line) => line.formulaRegions || []),
        ].filter((region, regionIndex, regions) =>
          regions.findIndex((candidate) =>
            candidate.text === region.text &&
            Math.abs(candidate.x - region.x) < 2 &&
            Math.abs(candidate.y - region.y) < 2,
          ) === regionIndex,
        )
        const rect = normalizeMultimodalRect(block, imageSize) || getMultimodalUnionRect(sourceBlocks)
        const text = cleanOcrSourceForTranslation(
          getMultimodalTextValue(block, ['original', 'text', 'sourceText', 'originalText', 'moduleText']) ||
          sourceBlocks.map((line) => line.text).join(' '),
        )
        const translation = cleanResultText(
          getMultimodalTextValue(block, ['translation', 'translatedText', 'targetText', 'result']) ||
          sourceBlocks.map((line) => line.translation).filter(Boolean).join('\n'),
        )

        const requireTranslation = options.requireTranslation !== false
        if (
          !rect ||
          !text ||
          (requireTranslation && (!translation || isUselessTranslationResult(translation)))
        ) {
          return null
        }

        return {
          index,
          moduleId: block.moduleId || block.id || `m${index + 1}`,
          type: String(block.type || block.contentType || 'text'),
          text,
          sourceText: text,
          translation: isUselessTranslationResult(translation) ? '' : translation,
          latex: String(block.latex || block.tex || '').trim(),
          symbolDensity: Math.max(0, Math.min(1, Number(block.symbolDensity || block.symbol_density) || 0)),
          formulaRegions,
          ...rect,
          confidence: normalizeMultimodalConfidence(block.confidence),
          sourceBlocks: sourceBlocks.length
            ? sourceBlocks
            : [{
                index: 0,
                text,
                ...rect,
                fontSize: Math.max(1, Number(block.fontSize || block.font_size) || rect.height * 0.82),
                confidence: Number(block.confidence) || 100,
              }],
          multimodal: true,
        }
      })
      .filter(Boolean)
      .slice(0, options.mode === 'diagram' && Array.isArray(rawBlocks) ? rawBlocks.length : 120)
  }

  function getVisualRectArea(rect) {
    return Math.max(0, Number(rect?.width) || 0) * Math.max(0, Number(rect?.height) || 0)
  }

  function getVisualRectOverlapRatio(firstRect, secondRect) {
    return getRectOverlapArea(firstRect, secondRect) /
      Math.max(1, Math.min(getVisualRectArea(firstRect), getVisualRectArea(secondRect)))
  }

  function validateMultimodalVisualBlocks(blocks = [], imageSize = {}, mode = 'compare') {
    const imageWidth = Number(imageSize.originalImageWidth || imageSize.width) || 0
    const imageHeight = Number(imageSize.originalImageHeight || imageSize.height) || 0
    const normalizedBlocks = []
    const duplicateKeys = new Set()

    blocks
      .slice()
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
      .forEach((block) => {
        const text = cleanOcrSourceForTranslation(block.text)
        const sourceBlocks = getCompareSourceBlocks(block)
        const lineRect = getMultimodalUnionRect(sourceBlocks)
        if (!text || !lineRect || !imageWidth || !imageHeight) return

        const textKey = text.toLowerCase().replace(/\s+/g, ' ')
        const duplicate = normalizedBlocks.some((candidate) =>
          candidate.text.toLowerCase().replace(/\s+/g, ' ') === textKey &&
          getVisualRectOverlapRatio(candidate, block) >= 0.72,
        )
        if (duplicate || duplicateKeys.has(`${textKey}|${Math.round(block.x)}|${Math.round(block.y)}`)) {
          return
        }
        duplicateKeys.add(`${textKey}|${Math.round(block.x)}|${Math.round(block.y)}`)

        const blockRight = block.x + block.width
        const blockBottom = block.y + block.height
        const lineRight = lineRect.x + lineRect.width
        const lineBottom = lineRect.y + lineRect.height
        const missesLineBounds =
          lineRect.x < block.x - 2 ||
          lineRect.y < block.y - 2 ||
          lineRight > blockRight + 2 ||
          lineBottom > blockBottom + 2
        const x = clampNumber(Math.min(block.x, lineRect.x), 0, Math.max(imageWidth - 1, 0))
        const y = clampNumber(Math.min(block.y, lineRect.y), 0, Math.max(imageHeight - 1, 0))
        const right = clampNumber(Math.max(blockRight, lineRight), x + 1, imageWidth)
        const bottom = clampNumber(Math.max(blockBottom, lineBottom), y + 1, imageHeight)

        normalizedBlocks.push({
          ...block,
          text,
          x,
          y,
          width: right - x,
          height: bottom - y,
          sourceBlocks,
          visualLayoutIssue: missesLineBounds ? 'line-coverage' : '',
        })
      })

    const consolidatedBlocks = []
    normalizedBlocks.forEach((block) => {
      const previousBlock = consolidatedBlocks[consolidatedBlocks.length - 1]
      if (
        previousBlock &&
        isVisualTranslationBlock(previousBlock) &&
        isVisualTranslationBlock(block) &&
        shouldMergeWrappedLine(previousBlock, block, {
          strict: true,
          diagram: mode === 'diagram',
        })
      ) {
        const mergedBlock = mergeOcrBlocks([previousBlock, block], previousBlock.index)
        consolidatedBlocks[consolidatedBlocks.length - 1] = {
          ...mergedBlock,
          moduleId: previousBlock.moduleId,
          type: previousBlock.type,
          formulaRegions: [
            ...(previousBlock.formulaRegions || []),
            ...(block.formulaRegions || []),
          ],
          multimodal: true,
          visualLayoutIssue:
            previousBlock.visualLayoutIssue || block.visualLayoutIssue || '',
        }
        return
      }
      consolidatedBlocks.push(block)
    })

    consolidatedBlocks.forEach((block, blockIndex) => {
      consolidatedBlocks.forEach((candidate, candidateIndex) => {
        if (candidateIndex <= blockIndex) return
        const overlapRatio = getVisualRectOverlapRatio(block, candidate)
        if (overlapRatio < 0.58) return

        block.visualLayoutIssue ||= 'module-overlap'
        candidate.visualLayoutIssue ||= 'module-overlap'
      })
    })

    debugMultimodalOcr('local layout validation', {
      mode,
      inputCount: blocks.length,
      outputCount: consolidatedBlocks.length,
      duplicateCount: Math.max(0, blocks.length - normalizedBlocks.length),
      issueCount: consolidatedBlocks.filter((block) => block.visualLayoutIssue).length,
      issues: consolidatedBlocks
        .filter((block) => block.visualLayoutIssue)
        .slice(0, 20)
        .map((block) => ({
          moduleId: block.moduleId,
          issue: block.visualLayoutIssue,
          bbox: {
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
          },
        })),
    })

    return consolidatedBlocks
  }

  async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length)
    let nextIndex = 0

    async function runWorker() {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index], index)
      }
    }

    await Promise.all(
      Array.from(
        { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
        () => runWorker(),
      ),
    )
    return results
  }

  async function enrichVisualInlineFormulas(blocks = [], imageUrl) {
    const formulaTargets = blocks.flatMap((block, blockIndex) =>
      (isVisualTranslationBlock(block) && Array.isArray(block.formulaRegions)
        ? block.formulaRegions
        : [])
        .filter((region) => String(region.type || '').toLowerCase().includes('inline'))
        .map((region, regionIndex) => ({ blockIndex, regionIndex, region })),
    ).slice(0, 12)
    if (!formulaTargets.length || !imageUrl) return blocks

    let formulaPipeline
    try {
      formulaPipeline = await getInlineFormulaOcrPipeline()
    } catch (error) {
      console.warn('多模态行内公式的本地公式 OCR 加载失败，保留视觉识别结果', {
        error: error.message,
      })
      return blocks
    }

    const nextBlocks = blocks.map((block) => ({
      ...block,
      formulaRegions: (block.formulaRegions || []).map((region) => ({ ...region })),
    }))

    for (const target of formulaTargets) {
      try {
        const formulaImage = await cropInlineFormulaImage(imageUrl, target.region)
        const output = await formulaPipeline(formulaImage, {
          max_new_tokens: 128,
          num_beams: 2,
        })
        const generatedText = Array.isArray(output)
          ? output[0]?.generated_text || output[0]?.text
          : output?.generated_text || output?.text
        const normalizedFormula = normalizeSimpleInlineLatex(generatedText)
        if (!normalizedFormula?.text) continue

        const block = nextBlocks[target.blockIndex]
        const region = block.formulaRegions[target.regionIndex]
        block.text = applyFormulaCorrectionsToText(block.text, [{
          text: region.text,
          replacement: normalizedFormula.text,
        }])
        block.formulaRegions[target.regionIndex] = {
          ...region,
          text: normalizedFormula.text,
          latex: normalizedFormula.latex,
          source: 'local-formula-ocr',
        }
      } catch (error) {
        console.warn('多模态行内公式的本地公式 OCR 失败，保留原符号', {
          error: error.message,
        })
      }
    }

    return nextBlocks
  }

  async function requestMultimodalVisualLayout(image, imageSize, mode, reviewContext = null) {
    const payload = {
      image,
      mode,
      imageWidth: imageSize.originalImageWidth || imageSize.width,
      imageHeight: imageSize.originalImageHeight || imageSize.height,
      reviewContext,
    }
    const isDiagramMode = mode === 'diagram'
    debugMultimodalOcr('request image', {
      mode,
      originalImageWidth: payload.imageWidth,
      originalImageHeight: payload.imageHeight,
      imageSize,
    })
    const data = window.electronAPI?.translateImageDiagram && window.electronAPI?.translateImageOCR
      ? await (isDiagramMode
          ? window.electronAPI.translateImageDiagram(payload)
          : window.electronAPI.translateImageOCR(payload))
      : await requestBackendJson(isDiagramMode ? '/ai/translate-image-diagram' : '/ai/translate-image-ocr', payload)

    if (data.layout?.validation?.sizeMismatch) {
      throw new Error('多模态模型返回的图片尺寸与原图不一致')
    }
    const blocks = normalizeMultimodalTranslationBlocks(data.blocks || [], imageSize, {
      mode,
      requireTranslation: false,
    })
    if (!blocks.length) throw new Error('多模态识别未返回可用文字模块')

    debugMultimodalOcr('provider layout', {
      raw: data.raw,
      layout: data.layout,
      normalizedBlocks: blocks,
      lineBboxes: blocks.flatMap((block) => block.sourceBlocks || []).map((line) => ({
        text: line.text,
        translation: line.translation,
        x: line.x,
        y: line.y,
        width: line.width,
        height: line.height,
        fontSize: line.fontSize,
      })),
    })

    return {
      blocks,
      layout: data.layout || null,
    }
  }

  async function cropVisualBoundaryReviewImage(imageUrl, block, attempt) {
    const sourceImage = await loadImage(imageUrl)
    const paddingRatio = attempt === 1 ? 0.15 : 0.32
    const paddingX = Math.max(12, block.width * paddingRatio)
    const paddingY = Math.max(12, block.height * paddingRatio)
    const sourceX = clampNumber(Math.floor(block.x - paddingX), 0, sourceImage.naturalWidth - 1)
    const sourceY = clampNumber(Math.floor(block.y - paddingY), 0, sourceImage.naturalHeight - 1)
    const sourceRight = clampNumber(
      Math.ceil(block.x + block.width + paddingX),
      sourceX + 1,
      sourceImage.naturalWidth,
    )
    const sourceBottom = clampNumber(
      Math.ceil(block.y + block.height + paddingY),
      sourceY + 1,
      sourceImage.naturalHeight,
    )
    const canvas = document.createElement('canvas')
    canvas.width = sourceRight - sourceX
    canvas.height = sourceBottom - sourceY
    canvas.getContext('2d').drawImage(
      sourceImage,
      sourceX,
      sourceY,
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    )

    return {
      image: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      originalImageWidth: canvas.width,
      originalImageHeight: canvas.height,
      offsetX: sourceX,
      offsetY: sourceY,
    }
  }

  function getReviewRelativeModule(block, crop) {
    const x = clampNumber(block.x - crop.offsetX, 0, Math.max(crop.width - 1, 0))
    const y = clampNumber(block.y - crop.offsetY, 0, Math.max(crop.height - 1, 0))
    const right = clampNumber(
      block.x + block.width - crop.offsetX,
      x + 1,
      crop.width,
    )
    const bottom = clampNumber(
      block.y + block.height - crop.offsetY,
      y + 1,
      crop.height,
    )

    return {
      moduleId: block.moduleId,
      type: block.type,
      bbox: {
        x,
        y,
        width: right - x,
        height: bottom - y,
      },
    }
  }

  function offsetReviewedVisualBlock(block, crop) {
    const offsetRect = (rect) => ({
      ...rect,
      x: rect.x + crop.offsetX,
      y: rect.y + crop.offsetY,
    })

    return {
      ...offsetRect(block),
      sourceBlocks: getCompareSourceBlocks(block).map(offsetRect),
      formulaRegions: (block.formulaRegions || []).map(offsetRect),
      visualLayoutIssue: block.visualLayoutIssue || '',
      multimodalBoundaryReview: true,
    }
  }

  async function reviewVisualModuleBoundary({
    mode,
    image,
    imageSize,
    block,
    blocks,
    attempt,
    reason,
  }) {
    if (!image || !imageSize || !block) return []

    try {
      const crop = await cropVisualBoundaryReviewImage(image, block, attempt)
      const cropRect = {
        x: crop.offsetX,
        y: crop.offsetY,
        width: crop.width,
        height: crop.height,
      }
      const neighborModules = blocks
        .filter((candidate) =>
          candidate !== block &&
          getRectOverlapArea(candidate, cropRect) > 0,
        )
        .sort((firstBlock, secondBlock) =>
          getRectDistance(firstBlock, block) - getRectDistance(secondBlock, block),
        )
        .slice(0, 8)
        .map((candidate) => getReviewRelativeModule(candidate, crop))
      const reviewContext = {
        attempt,
        reason,
        targetModule: getReviewRelativeModule(block, crop),
        neighborModules,
      }
      const result = await requestMultimodalVisualLayout(
        crop.image,
        crop,
        mode,
        reviewContext,
      )
      const reviewedCropBlocks = validateMultimodalVisualBlocks(result.blocks, crop, mode)
      const enrichedCropBlocks = await enrichVisualInlineFormulas(reviewedCropBlocks, crop.image)
      const reviewedBlocks = enrichedCropBlocks
        .map((candidate) => offsetReviewedVisualBlock(candidate, crop))
        .filter((candidate) => {
          const expandedTarget = {
            x: block.x - block.width * 0.4,
            y: block.y - block.height * 0.4,
            width: block.width * 1.8,
            height: block.height * 1.8,
          }
          return getRectOverlapArea(candidate, expandedTarget) > 0
        })

      debugMultimodalOcr('boundary review result', {
        mode,
        attempt,
        reason,
        sourceModuleId: block.moduleId,
        reviewedCount: reviewedBlocks.length,
        crop: {
          x: crop.offsetX,
          y: crop.offsetY,
          width: crop.width,
          height: crop.height,
        },
      })
      return reviewedBlocks
    } catch (error) {
      console.warn('多模态模块边界复核失败，保留本地回退流程', {
        mode,
        attempt,
        reason,
        error: error.message,
      })
      return []
    }
  }

  async function requestMultimodalTextRecognition(image, imageSize, mode) {
    const payload = {
      image,
      mode,
      imageWidth: imageSize.originalImageWidth || imageSize.width,
      imageHeight: imageSize.originalImageHeight || imageSize.height,
    }
    const data = window.electronAPI?.translateImageOCR
      ? await window.electronAPI.translateImageOCR(payload)
      : await requestBackendJson('/ai/translate-image-ocr', payload)
    const blocks = normalizeMultimodalTranslationBlocks(data.blocks || [], imageSize, {
      mode,
      requireTranslation: false,
    })

    if (!blocks.length) throw new Error('多模态模型未返回可用文字')
    return blocks
  }

  async function finishVisualOcrResult({
    mode,
    image,
    recognitionImage,
    croppedImage,
    translatedBlocks,
    sourceBlocks,
    ocrSelectionRect,
    fallbackNotice = '',
  }) {
    const successfulBlocks = translatedBlocks.filter((block) => {
      const translation = cleanResultText(block.translation || '')
      return !block.translationFallback &&
        translation &&
        !isUselessTranslationResult(translation)
    })
    const failedBlocks = translatedBlocks.filter((block) => block.translationFallback)
    if (!successfulBlocks.length && failedBlocks.length) {
      throw new Error(failedBlocks[0].translationError || '翻译失败')
    }
    const resultNotice = [
      fallbackNotice,
      failedBlocks.length ? `${failedBlocks.length} 个模块翻译失败` : '',
    ].filter(Boolean).join('；')

    if (mode === 'compare') {
      const translatedImage = await createCompareResultImage(recognitionImage, croppedImage, successfulBlocks)
      const layout = getCompareLayoutByAspectRatio(croppedImage.width, croppedImage.height)
      const nextCompareResult = {
        originalImage: image,
        translatedImage,
        layout,
      }

      setSuccessfulRightPanelResult({
        type: 'ocr-compare',
        title: resultNotice ? `对照模式结果（${resultNotice}）` : '对照模式结果',
        compareOriginalImage: image,
        compareTranslatedImage: translatedImage,
        compareLayout: layout,
        ocrSelectionRect,
        timestamp: Date.now(),
      })
      setCompareResult(nextCompareResult)
      setCompareOriginalZoom(1)
      setCompareTranslatedZoom(1)
      setIsCompareModalFullscreen(false)
      setOcrResult(null)
      return
    }

    const resultImage = await createDiagramResultImage(
      recognitionImage,
      croppedImage,
      successfulBlocks,
      sourceBlocks || translatedBlocks,
    )

    setSuccessfulRightPanelResult({
      type: 'ocr-diagram',
      title: resultNotice ? `图解模式结果（${resultNotice}）` : '图解模式结果',
      screenshotDataUrl: recognitionImage,
      diagramResultImage: resultImage,
      ocrSelectionRect,
      timestamp: Date.now(),
    })
    setDiagramResult({ image: resultImage })
    setDiagramZoom(1)
    setIsDiagramModalFullscreen(false)
    setOcrResult(null)
  }

  function getRectBoundaryPoint(rect, targetPoint) {
    const center = {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    }
    const deltaX = targetPoint.x - center.x
    const deltaY = targetPoint.y - center.y
    const halfWidth = Math.max(rect.width / 2, 0.5)
    const halfHeight = Math.max(rect.height / 2, 0.5)

    if (Math.abs(deltaX) < 0.001 && Math.abs(deltaY) < 0.001) {
      return {
        x: center.x + halfWidth,
        y: center.y,
      }
    }

    const scale = 1 / Math.max(
      Math.abs(deltaX) / halfWidth,
      Math.abs(deltaY) / halfHeight,
    )

    return {
      x: center.x + deltaX * scale,
      y: center.y + deltaY * scale,
    }
  }

  function getDiagramConnectorPoints(sourceRect, translationRect) {
    const sourceCenter = {
      x: sourceRect.x + sourceRect.width / 2,
      y: sourceRect.y + sourceRect.height / 2,
    }
    const translationCenter = {
      x: translationRect.x + translationRect.width / 2,
      y: translationRect.y + translationRect.height / 2,
    }

    return {
      start: getRectBoundaryPoint(sourceRect, translationCenter),
      end: getRectBoundaryPoint(translationRect, sourceCenter),
    }
  }

  async function createDiagramResultImage(imageUrl, imageSize, translatedBlocks, sourceBlocks = translatedBlocks) {
    const sourceImage = await loadImage(imageUrl)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const placedRects = []
    const placedConnectorPaths = []

    canvas.width = imageSize.originalImageWidth || imageSize.width || sourceImage.naturalWidth
    canvas.height = imageSize.originalImageHeight || imageSize.height || sourceImage.naturalHeight
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height)
    const sourceRects = getDiagramSourceRects(sourceBlocks)

    debugMultimodalOcr('diagram canvas', {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      originalImageWidth: imageSize.originalImageWidth || imageSize.width,
      originalImageHeight: imageSize.originalImageHeight || imageSize.height,
      scaleX: canvas.width / Math.max(imageSize.originalImageWidth || imageSize.width || canvas.width, 1),
      scaleY: canvas.height / Math.max(imageSize.originalImageHeight || imageSize.height || canvas.height, 1),
    })

    translatedBlocks.forEach((block) => {
      const plan = getDiagramLabelPlan(context, block, canvas.width, canvas.height)
      if (!plan?.lines?.length) return

      const rect = chooseDiagramLabelRect(
        block,
        plan.width,
        plan.height,
        canvas.width,
        canvas.height,
        placedRects,
        sourceRects,
        placedConnectorPaths,
        context,
      )

      debugMultimodalOcr('diagram label draw', {
        text: block.text,
        translation: block.translation,
        source: {
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height,
        },
        draw: rect,
        fontSize: plan.fontSize,
        lines: plan.lines.length,
      })

      const overlayStyle = getOverlayStyleForMode('diagram')
      const connectorObstacles = [
        ...sourceRects.filter((sourceRect) =>
          getVisualRectOverlapRatio(sourceRect, block) < 0.72,
        ),
        ...placedRects,
      ]
      const connectorPath = getDiagramConnectorPath(
        block,
        rect,
        connectorObstacles,
        placedConnectorPaths,
      )
      placedRects.push(rect)
      placedConnectorPaths.push(connectorPath)
      context.save()
      context.strokeStyle = 'rgba(37, 99, 235, 0.5)'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(connectorPath[0].x, connectorPath[0].y)
      connectorPath.slice(1).forEach((point) => {
        context.lineTo(point.x, point.y)
      })
      context.stroke()
      context.shadowColor = overlayStyle.shadow
      context.shadowBlur = overlayStyle.shadowBlur
      context.shadowOffsetY = overlayStyle.shadowOffsetY
      drawRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 5)
      context.fillStyle = overlayStyle.background
      context.fill()
      context.shadowColor = 'transparent'
      context.lineWidth = 1
      context.strokeStyle = overlayStyle.border
      context.stroke()
      context.fillStyle = overlayStyle.text
      context.textBaseline = 'top'
      context.font = getCompareCanvasFont(plan.fontSize)
      plan.lines.forEach((line, index) => {
        context.fillText(
          line,
          rect.x + plan.horizontalPadding,
          rect.y + plan.verticalPadding + index * plan.lineHeight,
        )
      })
      context.restore()

      debugMultimodalOcr('diagram connector draw', {
        text: block.text,
        start: connectorPath[0],
        end: connectorPath[connectorPath.length - 1],
        bends: connectorPath.slice(1, -1),
        sourceRect: {
          x: block.x,
          y: block.y,
          width: block.width,
          height: block.height,
        },
        translationRect: rect,
      })
    })

    drawDebugLayoutBoxes(context, translatedBlocks, canvas.width, canvas.height)

    return canvas.toDataURL('image/png')
  }

  function drawCompareTranslationLine(context, line, canvasWidth, canvasHeight) {
    const backgroundBox = getPaddedLineBox(line, canvasWidth, canvasHeight)
    const textBox = {
      x: backgroundBox.x + backgroundBox.paddingX,
      y: backgroundBox.y + backgroundBox.paddingY,
      width: Math.max(6, backgroundBox.width - backgroundBox.paddingX * 2),
      height: Math.max(6, backgroundBox.height - backgroundBox.paddingY * 2),
    }
    const originalFontSize = Math.max(1, Number(line.fontSize) || line.height * 0.82)
    const initialTranslationFontSize = clampNumber(
      Math.min(originalFontSize * 0.88, textBox.height * 0.82),
      1,
      24,
    )
    const minimumTranslationFontSize = Math.max(1, originalFontSize * 0.65)
    const translation = cleanResultText(line.translation || '').replace(/\s*\n+\s*/g, ' ')
    let translationFontSize = initialTranslationFontSize

    context.save()
    context.fillStyle = '#ffffff'
    context.fillRect(backgroundBox.x, backgroundBox.y, backgroundBox.width, backgroundBox.height)
    if (translation) {
      context.font = getCompareCanvasFont(translationFontSize)
      while (
        translationFontSize > minimumTranslationFontSize &&
        context.measureText(translation).width > textBox.width
      ) {
        translationFontSize = Math.max(
          minimumTranslationFontSize,
          translationFontSize - 0.5,
        )
        context.font = getCompareCanvasFont(translationFontSize)
      }
      context.font = getCompareCanvasFont(translationFontSize)
      context.textBaseline = 'top'
      context.fillStyle = '#111827'
      const textY = textBox.y + Math.max(0, (textBox.height - translationFontSize * 1.12) / 2)
      context.fillText(translation, textBox.x, textY, textBox.width)
    }
    context.restore()

    return {
      backgroundBox,
      originalFontSize,
      translationFontSize,
    }
  }

  async function createCompareResultImage(imageUrl, imageSize, translatedBlocks) {
    const sourceImage = await loadImage(imageUrl)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = imageSize.originalImageWidth || imageSize.width || sourceImage.naturalWidth
    canvas.height = imageSize.originalImageHeight || imageSize.height || sourceImage.naturalHeight
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height)

    debugMultimodalOcr('compare canvas', {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      originalImageWidth: imageSize.originalImageWidth || imageSize.width,
      originalImageHeight: imageSize.originalImageHeight || imageSize.height,
      scaleX: canvas.width / Math.max(imageSize.originalImageWidth || imageSize.width || canvas.width, 1),
      scaleY: canvas.height / Math.max(imageSize.originalImageHeight || imageSize.height || canvas.height, 1),
    })

    translatedBlocks.forEach((block) => {
      if (block.translationFallback || !cleanResultText(block.translation || '')) return
      getCompareLineAssignments(block).forEach((line) => {
        const drawResult = drawCompareTranslationLine(context, line, canvas.width, canvas.height)

        debugMultimodalOcr('compare line draw', {
          text: line.text,
          translation: line.translation,
          bbox: { x: line.x, y: line.y, width: line.width, height: line.height },
          backgroundBox: drawResult.backgroundBox,
          originalFontSize: drawResult.originalFontSize,
          translationFontSize: drawResult.translationFontSize,
          boundaryRetries: block.compareBoundaryRetries || 0,
        })
      })
    })

    drawDebugLayoutBoxes(context, translatedBlocks, canvas.width, canvas.height)

    return canvas.toDataURL('image/png')
  }

  function getCompareLayoutByAspectRatio(width, height) {
    const aspectRatio = width / Math.max(height, 1)

    return aspectRatio >= 1.4 ? 'vertical' : 'horizontal'
  }

  async function runOcrTranslation(rect, mode = 'sidebar') {
    let worker = null
    let multimodalFallbackNotice = ''

    try {
      clearOcrCaptureUi()
      const pageBox = getCurrentPageBox()
      const ocrSelectionRect = {
        rect: normalizeViewerRectToPage(rect, pageBox),
        pageWidth: pageBox?.width || 1,
        pageHeight: pageBox?.height || 1,
      }
      const shouldPadCapture = mode === 'diagram' || mode === 'compare'
      const croppedImage = cropOcrImage(rect, {
        padding: shouldPadCapture ? clampNumber(Math.max(rect.width, rect.height) * 0.05, 14, 40) : 0,
      })
      const { image } = croppedImage
      const recognitionImage = croppedImage.ocrImage || image
      debugMultimodalOcr('cropped original image', {
        mode,
        width: croppedImage.width,
        height: croppedImage.height,
        originalImageWidth: croppedImage.originalImageWidth,
        originalImageHeight: croppedImage.originalImageHeight,
        sourceX: croppedImage.sourceX,
        sourceY: croppedImage.sourceY,
        sourceWidth: croppedImage.sourceWidth,
        sourceHeight: croppedImage.sourceHeight,
        scaleX: croppedImage.scaleX,
        scaleY: croppedImage.scaleY,
      })
      setOcrResult({
        status: mode === 'diagram' ? 'diagram-recognizing' : mode === 'compare' ? 'compare-recognizing' : 'recognizing',
        mode,
        image,
        text: '',
        translation: '',
        error: '',
      })

      if (
        MULTIMODAL_VISUAL_OCR_ENABLED &&
        (mode === 'diagram' || mode === 'compare') &&
        settingsSupportMultimodal(settingsFormRef.current)
      ) {
        try {
          setOcrResult({
            status: mode === 'diagram' ? 'diagram-translating' : 'compare-translating',
            mode,
            image,
            text: '',
            translation: '',
            error: '',
          })
          const multimodalLayout = await requestMultimodalVisualLayout(image, croppedImage, mode)
          const validatedBlocks = validateMultimodalVisualBlocks(
            multimodalLayout.blocks,
            croppedImage,
            mode,
          )
          const multimodalBlocks = await enrichVisualInlineFormulas(validatedBlocks, image)
          const translatedBlocks = mode === 'compare'
            ? await translateCompareBlocks(multimodalBlocks, {
                multimodal: true,
                image,
                imageSize: croppedImage,
              })
            : await translateDiagramBlocks(multimodalBlocks, {
                multimodal: true,
                image,
                imageSize: croppedImage,
              })

          debugMultimodalOcr('multimodal result', {
            mode,
            blockCount: translatedBlocks.length,
            sample: translatedBlocks.slice(0, 5).map((block) => ({
              text: block.text,
              translation: block.translation,
              x: block.x,
              y: block.y,
              width: block.width,
              height: block.height,
            })),
          })

          await finishVisualOcrResult({
            mode,
            image,
            recognitionImage: image,
            croppedImage,
            translatedBlocks,
            sourceBlocks: multimodalBlocks,
            ocrSelectionRect,
          })
          return
        } catch (error) {
          console.warn('多模态图解/对照模式失败，回退到原 OCR 流程', {
            mode,
            error: error.message,
          })
          multimodalFallbackNotice = '多模态识别失败，已回退到普通 OCR 流程。'
          setOcrResult({
            status: mode === 'diagram' ? 'diagram-recognizing' : 'compare-recognizing',
            mode,
            image: recognitionImage,
            text: '',
            translation: '',
            error: multimodalFallbackNotice,
          })
        }
      }

      const multimodalTextRecognitionPromise =
        mode === 'sidebar' &&
        settingsSupportMultimodal(settingsFormRef.current)
          ? requestMultimodalTextRecognition(image, croppedImage, 'text')
              .catch((error) => {
                console.warn('OCR 文本多模态纠错失败，继续使用本地识别结果', {
                  error: error.message,
                })
                return []
              })
          : Promise.resolve([])

      worker = await createWorker('eng', 1, {
        workerPath: `${TESSERACT_ASSET_BASE}/worker.min.js`,
        corePath: `${TESSERACT_ASSET_BASE}/core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${TESSERACT_ASSET_BASE}/lang`,
        cacheMethod: 'none',
      })
      const { data } = await worker.recognize(recognitionImage, {}, { text: true, blocks: true })
      const tesseractText = cleanOcrText(data.text || '')
      const pdfTextBlocks = getPdfTextLayerOcrBlocks(croppedImage)
      const usePdfTextLayer = shouldPreferPdfTextLayer(pdfTextBlocks, tesseractText)
      const blockOptions = {
        strict: mode === 'compare' || mode === 'diagram',
        diagram: mode === 'diagram',
      }
      let textBlocks = usePdfTextLayer
        ? mergeWrappedLinesIntoBlocks(pdfTextBlocks, blockOptions)
        : getOcrTextBlocks(data, croppedImage, blockOptions)
      let formulaResult = { corrections: [], unresolvedRects: [] }

      if (!usePdfTextLayer && textBlocks.length) {
        formulaResult = await recognizeInlineFormulaCandidates(
          data,
          recognitionImage,
          croppedImage,
          pdfTextBlocks,
        )
        textBlocks = applyInlineFormulaCorrections(textBlocks, formulaResult)
      }

      const multimodalTextBlocks = await multimodalTextRecognitionPromise
      if (shouldPreferMultimodalRecognition(textBlocks, multimodalTextBlocks)) {
        textBlocks = multimodalTextBlocks
      }

      const recognizedText = textBlocks.length
        ? textBlocks.map((block) => block.text).join('\n')
        : tesseractText

      if (!recognizedText) {
        setOcrResult({
          status: 'error',
          mode,
          image: recognitionImage,
          text: '',
          translation: '',
          error: '未识别到文字',
        })
        return
      }

      setOcrResult({
        status: mode === 'diagram' ? 'diagram-translating' : mode === 'compare' ? 'compare-translating' : 'translating',
        mode,
        image: recognitionImage,
        text: recognizedText,
        translation: '',
        error: '',
      })

      if (mode === 'diagram' || mode === 'compare') {
        const validTextBlocks = textBlocks.filter((block) => isVisualTranslationBlock(block))

        console.log('OCR 模块流程统计', {
          mode,
          source: usePdfTextLayer ? 'pdf-text-layer' : 'tesseract',
          rawLineCount: collectOcrLines(data).length,
          mergedModuleCount: textBlocks.length,
          validModuleCount: validTextBlocks.length,
          formulaCorrectionCount: formulaResult.corrections.length,
          unresolvedFormulaCount: formulaResult.unresolvedRects.length,
          skippedDenseFormulaCount: textBlocks.filter((block) => isDenseFormulaOrSymbolText(block.text)).length,
          moduleTextLengths: validTextBlocks.slice(0, 20).map((block) => block.text.length),
        })

        if (!validTextBlocks.length) {
          throw new Error('未识别到可翻译的英文文本')
        }

        const translatedBlocks = mode === 'compare'
          ? await translateCompareBlocks(validTextBlocks)
          : await translateDiagramBlocks(validTextBlocks)

        if (!translatedBlocks.length) {
          throw new Error('未识别到可翻译的英文文本')
        }

        if (mode === 'compare') {
          await finishVisualOcrResult({
            mode,
            image,
            recognitionImage,
            croppedImage,
            translatedBlocks,
            sourceBlocks: textBlocks,
            ocrSelectionRect,
            fallbackNotice: multimodalFallbackNotice,
          })
          return
        }

        await finishVisualOcrResult({
          mode,
          image,
          recognitionImage,
          croppedImage,
          translatedBlocks,
          sourceBlocks: textBlocks,
          ocrSelectionRect,
          fallbackNotice: multimodalFallbackNotice,
        })
        return
      }

      const {
        segments: translatedSegments,
        translation: nextTranslation,
      } = await translateOcrBlocksPreservingFormulas(textBlocks)
      if (!translatedSegments.length || isUselessTranslationResult(nextTranslation)) {
        setOcrResult({
          status: 'error',
          mode,
          image: recognitionImage,
          text: recognizedText,
          translation: '',
          error: '未识别到可展示的英文文本或公式',
        })
        return
      }

      setSuccessfulRightPanelResult({
        type: 'ocr-text',
        title: '文本模式结果',
        screenshotDataUrl: recognitionImage,
        ocrText: recognizedText,
        translation: nextTranslation,
        translationSegments: translatedSegments,
        ocrSelectionRect,
        timestamp: Date.now(),
      })
      setOcrResult(null)
    } catch (error) {
      setOcrResult((currentResult) => ({
        status: 'error',
        mode,
        image: currentResult?.image || '',
        text: currentResult?.text || '',
        translation: currentResult?.translation || '',
        error: error.message || '区域 OCR 失败',
      }))
    } finally {
      if (worker) {
        await worker.terminate()
      }
    }
  }
  function handleOcrSelectionStart(event) {
    if (!pdfViewerRef.current) return

    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    clearRightPanelResult()
    const startPoint = getViewerPoint(event)
    ocrStartPointRef.current = startPoint
    setIsOcrDragging(true)
    setOcrRect({ ...startPoint, left: startPoint.x, top: startPoint.y, width: 0, height: 0 })
  }

  function handleOcrSelectionMove(event) {
    if (!isOcrDragging || !ocrStartPointRef.current || !pdfViewerRef.current) return

    event.preventDefault()
    setOcrRect(getRectFromPoints(ocrStartPointRef.current, getViewerPoint(event)))
  }

  function handleOcrSelectionEnd(event) {
    if (!isOcrDragging || !ocrStartPointRef.current || !pdfViewerRef.current) return

    event.preventDefault()
    const finalRect = getRectFromPoints(ocrStartPointRef.current, getViewerPoint(event))
    clearOcrSelection()
    setIsOcrMode(false)

    if (finalRect.width < 8 || finalRect.height < 8) return

    runOcrTranslation(finalRect, ocrModeType)
  }

  function handleSelectionStart(event) {
    if (isInteractiveElement(event.target)) return

    annotationInteractionSuspendedRef.current = false

    if (isOcrMode) {
      handleOcrSelectionStart(event)
      return
    }

    isSelectingRef.current = true
    setOcrResult(null)
    setHighlightRects([])
    setPreviewHighlight(null)
  }

  function handleSelectionMove(event) {
    if (isInteractiveElement(event.target)) return

    if (annotationInteractionSuspendedRef.current) return

    if (isOcrMode) {
      handleOcrSelectionMove(event)
      return
    }

    if (!isSelectingRef.current) return

    scheduleSelectionHighlightUpdate()
  }

  async function handleTextSelection(event) {
    if (annotationInteractionSuspendedRef.current) {
      releasePdfTextSelection()
      return
    }

    if (event?.target && isInteractiveElement(event.target)) {
      releasePdfTextSelection()
      return
    }

    if (isOcrMode || isOcrDragging) {
      handleOcrSelectionEnd(event)
      return
    }

    isSelectingRef.current = false

    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }

    const selection = window.getSelection()
    const selectionText = selection?.toString().trim() || ''
    const formattedText = getFormattedSelectionText(selection, selectionText)
    const text = formattedText.trim()

    if (!text || text.length <= 1) {
      releasePdfTextSelection()
      clearTranslation()
      return
    }

    const nextHighlightRects = getSelectionHighlightRects(selection)

    if (nextHighlightRects.length === 0) {
      releasePdfTextSelection()
      return
    }

    if (annotationColor && currentDocument?.documentId) {
      const pageBox = getCurrentPageBox()
      const rects = nextHighlightRects
        .map((rect) => normalizeViewerRectToPage(rect, pageBox))
        .filter(Boolean)

      // Release the native PDF selection before persistence begins. The saved
      // highlight can render while the IPC/PDF write is still pending, so a
      // delayed cleanup here would race with opening its note dialog.
      releasePdfTextSelection()
      const selectionInteractionVersion = ++selectionInteractionVersionRef.current

      if (rects.length && !hasDuplicateHighlight(text, rects)) {
        const now = Date.now()
        const selectedHighlightColor = normalizeHighlightColor(annotationColor)
        const highlightId = `${now}-${Math.random().toString(36).slice(2, 9)}`
        const annotation = {
          id: highlightId,
          highlightId,
          documentId: currentDocument.documentId,
          filePath: currentDocument.filePath,
          fileName: currentDocument.fileName,
          type: 'text-highlight',
          pageNumber,
          selectedText: text,
          color: selectedHighlightColor,
          rects,
          pageWidth: pageBox?.width || 1,
          pageHeight: pageBox?.height || 1,
          createdAt: now,
          updatedAt: now,
        }

        const savedAnnotation = await addAnnotation(annotation)
        await maybeEmbedHighlightInPdf(savedAnnotation || annotation)
        if (selectionInteractionVersionRef.current === selectionInteractionVersion) {
          setActiveAnnotationId(annotation.id)
          setAnnotationStatus('')
        }
      } else if (rects.length) {
        setAnnotationStatus('已存在相同高亮')
      }

      return
    }

    setHighlightRects(nextHighlightRects)
    const nextSelectionCapture = cropSelectionRectsImage(nextHighlightRects)

    if (text) {
      setRightPanelResult(null)
      setOcrResult(null)
      setDiagramResult(null)
      setDiagramZoom(1)
      setCompareResult(null)
      setCompareOriginalZoom(1)
      setCompareTranslatedZoom(1)
      setImagePreview(null)
      setImagePreviewZoom(1)
      setIsImagePreviewFullscreen(false)
      lastTranslatedTextRef.current = ''
      setSelectionCapture(nextSelectionCapture)
      setSelectedText(text)
    }
  }

  useEffect(() => {
    function handleDocumentMouseMove(event) {
      if (isInteractiveElement(event.target)) return

      if (isOcrDragging) {
        handleOcrSelectionMove(event)
        return
      }

      if (!isSelectingRef.current) return

      scheduleSelectionHighlightUpdate()
    }

    function handleDocumentMouseUp(event) {
      if (getTextEntryElement(event.target)) {
        suspendPdfTextSelection()
        return
      }

      if (isInteractiveElement(event.target)) {
        releasePdfTextSelection()
        return
      }

      if (isOcrDragging) {
        handleOcrSelectionEnd(event)
        return
      }

      if (!isSelectingRef.current) return

      handleTextSelection()
    }

    document.addEventListener('mousemove', handleDocumentMouseMove)
    document.addEventListener('mouseup', handleDocumentMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleDocumentMouseMove)
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  })

  async function toggleFullscreen() {
    if (!appRef.current) return

    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else {
      await appRef.current.requestFullscreen()
    }
  }

  function clampNumber(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  async function saveRightPanelWidth(width) {
    if (!window.electronAPI?.saveConfig) return

    try {
      const currentConfig = window.electronAPI.getConfig
        ? await window.electronAPI.getConfig()
        : settingsFormRef.current
      await window.electronAPI.saveConfig({
        ...currentConfig,
        rightPanelWidth: width,
      })
    } catch {
      // Resizing should never interrupt reading if layout persistence fails.
    }
  }

  function startPanelResize(event) {
    event.preventDefault()
    panelResizeStartRef.current = {
      startX: event.clientX,
      startWidth: rightPanelWidth,
    }
    setIsResizingPanel(true)
  }

  useEffect(() => {
    if (!isResizingPanel) return

    function handlePanelResizeMove(event) {
      if (!panelResizeStartRef.current) return

      const deltaX = event.clientX - panelResizeStartRef.current.startX
      const maxWidth = Math.min(
        MAX_RIGHT_PANEL_WIDTH,
        Math.max(MIN_RIGHT_PANEL_WIDTH, window.innerWidth - 520),
      )
      const rawWidth = panelResizeStartRef.current.startWidth - deltaX
      const nextWidth = Math.min(maxWidth, Math.max(MIN_RIGHT_PANEL_WIDTH, rawWidth))
      setRightPanelWidth((currentWidth) => {
        if (Math.abs(currentWidth - nextWidth) < 1) {
          return currentWidth
        }

        return nextWidth
      })
    }

    function handlePanelResizeEnd() {
      setIsResizingPanel(false)
      panelResizeStartRef.current = null
      saveRightPanelWidth(rightPanelWidthRef.current)
    }

    document.body.classList.add('resizing-panel')
    document.addEventListener('mousemove', handlePanelResizeMove)
    document.addEventListener('mouseup', handlePanelResizeEnd)

    return () => {
      document.body.classList.remove('resizing-panel')
      document.removeEventListener('mousemove', handlePanelResizeMove)
      document.removeEventListener('mouseup', handlePanelResizeEnd)
    }
  }, [isResizingPanel])

  function applyZoom(nextZoom) {
    const parsedZoom = Number.parseInt(nextZoom, 10)

    if (Number.isNaN(parsedZoom)) {
      setZoomInput(String(zoomPercent))
      return
    }

    const clampedZoom = clampNumber(parsedZoom, MIN_ZOOM, MAX_ZOOM)
    setZoomPercent(clampedZoom)
    setZoomInput(String(clampedZoom))
    clearTranslation()
  }

  function changeZoom(delta) {
    applyZoom(zoomPercent + delta)
  }

  function toggleOcrMode() {
    if (isOcrMode) {
      setIsOcrMode(false)
      setIsOcrMenuOpen(false)
      clearOcrSelection()
      return
    }

    setIsOcrMenuOpen((isOpen) => !isOpen)
  }

  function startOcrMode(mode) {
    setOcrModeType(mode)
    setIsOcrMode(true)
    setIsOcrMenuOpen(false)
    clearTranslation()
    setHighlightRects([])
    setOcrResult(null)
    setDiagramResult(null)
    setCompareResult(null)
    setImagePreview(null)
  }

  function handleZoomInputKeyDown(event) {
    if (event.key === 'Enter') {
      event.currentTarget.blur()
      applyZoom(zoomInput)
    }
  }

  function goToPreviousPage() {
    setPageNumber((currentPage) => Math.max(currentPage - 1, 1))
    clearTranslation()
  }

  function goToNextPage() {
    if (!numPages) return

    setPageNumber((currentPage) => Math.min(currentPage + 1, numPages))
    clearTranslation()
  }

  function jumpToPage(inputValue = pageJumpInput) {
    if (!numPages) return

    const parsedPage = Number.parseInt(String(inputValue).trim(), 10)

    if (Number.isNaN(parsedPage)) {
      setPageJumpInput(String(pageNumber))
      return
    }

    const nextPage = clampNumber(parsedPage, 1, numPages)
    setPageNumber(nextPage)
    setPageJumpInput(String(nextPage))
    clearTranslation()
  }

  function handlePageJumpKeyDown(event) {
    if (event.key === 'Enter') {
      event.preventDefault()
      jumpToPage(event.currentTarget.value)
      event.currentTarget.blur()
    }
  }

  async function copyTranslation() {
    const textToCopy = rightPanelResult?.translation || (translationStatus === 'success' ? translation : '')

    if (!textToCopy) return

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = textToCopy
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.append(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }

      setCopyStatus('已复制')
    } catch {
      setCopyStatus('复制失败')
    }
  }

  function canCopyTranslation() {
    return Boolean(rightPanelResult?.translation || (translationStatus === 'success' && translation))
  }

  function hasRightPanelContent() {
    return Boolean(rightPanelResult || ocrResult || translationStatus !== 'idle')
  }

  function openDiagramResultModal(result = rightPanelResult) {
    if (!result?.diagramResultImage) return

    setDiagramResult({ image: result.diagramResultImage })
    setDiagramZoom(1)
    setIsDiagramModalFullscreen(false)
  }

  function openCompareResultModal(result = rightPanelResult) {
    if (!result?.compareTranslatedImage) return

    setCompareResult({
      originalImage: result.compareOriginalImage,
      translatedImage: result.compareTranslatedImage,
      layout: result.compareLayout || 'horizontal',
    })
    setCompareOriginalZoom(1)
    setCompareTranslatedZoom(1)
    setIsCompareModalFullscreen(false)
  }

  function openImagePreviewModal(image, title = '框选区域截图', options = {}) {
    if (!image) return

    setImagePreview({ image, title })
    setImagePreviewZoom(1)
    setIsImagePreviewFullscreen(Boolean(options.fullscreen))
  }

  async function retranslateOcrText() {
    if (rightPanelResult?.type !== 'ocr-text') {
      setOcrRetranslateError('当前结果不是文本 OCR 结果')
      return
    }

    if (!currentDocument?.documentId) {
      setOcrRetranslateError('请先打开 PDF 后再重新翻译')
      return
    }

    const nextOcrText = editableOcrText.trim()

    if (!nextOcrText) {
      setOcrRetranslateError('请输入需要翻译的 OCR 文本')
      return
    }

    setOcrRetranslateStatus('loading')
    setOcrRetranslateError('')

    try {
      const nextTranslation = cleanResultText(await requestTranslation(nextOcrText))
      const nextResult = {
        ...rightPanelResult,
        ocrText: nextOcrText,
        translation: nextTranslation,
        timestamp: Date.now(),
      }

      setSuccessfulRightPanelResult(nextResult)
      setEditableOcrText(nextOcrText)
      setOcrRetranslateStatus('success')
    } catch (error) {
      setOcrRetranslateStatus('error')
      setOcrRetranslateError(error.message || UI.translateError)
    }
  }

  function getPanelText() {
    if (translationStatus === 'loading') return UI.loadingTranslation
    if (translationStatus === 'error') return translation
    if (translationStatus === 'success') return translation
    return '请选中文字或使用区域 OCR'
  }

  function getOcrStatusText() {
    if (!ocrResult) return ''
    if (
      ocrResult.status === 'diagram-recognizing' ||
      ocrResult.status === 'compare-recognizing' ||
      ocrResult.status === 'recognizing'
    )
      return '正在识别...'
    if (
      ocrResult.status === 'diagram-translating' ||
      ocrResult.status === 'compare-translating' ||
      ocrResult.status === 'translating'
    )
      return '翻译中...'
    if (ocrResult.status === 'diagram-success') return '图解模式结果已生成'
    if (ocrResult.status === 'compare-success') return '对照模式结果已生成'
    if (ocrResult.status === 'error') return ocrResult.error || '区域 OCR 失败'
    return ''
  }

  function handleDiagramWheel(event) {
    event.preventDefault()
    event.stopPropagation()
    const delta = event.deltaY < 0 ? 0.12 : -0.12

    setDiagramZoom((currentZoom) => clampNumber(Number((currentZoom + delta).toFixed(2)), 0.5, 4))
  }

  function toggleDiagramModalFullscreen() {
    setIsDiagramModalFullscreen((isFullscreen) => !isFullscreen)
  }

  function toggleCompareModalFullscreen() {
    setIsCompareModalFullscreen((isFullscreen) => !isFullscreen)
  }

  function toggleImagePreviewFullscreen() {
    setIsImagePreviewFullscreen((isFullscreen) => !isFullscreen)
  }

  function closeDiagramModal() {
    setIsDiagramModalFullscreen(false)
    setDiagramResult(null)
  }

  function closeCompareModal() {
    setIsCompareModalFullscreen(false)
    setCompareResult(null)
  }

  function handleCompareWheel(event, side) {
    event.preventDefault()
    event.stopPropagation()
    const delta = event.deltaY < 0 ? 0.12 : -0.12

    adjustCompareZoom(side, delta)
  }

  function adjustCompareZoom(side, delta) {
    const updateZoom = (currentZoom) => clampNumber(Number((currentZoom + delta).toFixed(2)), 0.5, 4)

    if (side === 'original') {
      setCompareOriginalZoom(updateZoom)
    } else {
      setCompareTranslatedZoom(updateZoom)
    }
  }

  function resetCompareZoom(side) {
    if (side === 'original') {
      setCompareOriginalZoom(1)
    } else {
      setCompareTranslatedZoom(1)
    }
  }

  function openCompareImagePreview(side) {
    if (!compareResult) return

    if (side === 'original') {
      openImagePreviewModal(compareResult.originalImage, 'OCR 对照模式原图', { fullscreen: true })
      return
    }

    openImagePreviewModal(compareResult.translatedImage, 'OCR 对照模式译文覆盖图', { fullscreen: true })
  }

  function handleImagePreviewWheel(event) {
    event.preventDefault()
    event.stopPropagation()
    const delta = event.deltaY < 0 ? 0.12 : -0.12

    setImagePreviewZoom((currentZoom) => clampNumber(Number((currentZoom + delta).toFixed(2)), 0.5, 4))
  }

  function getShortHistoryPreview(item) {
    if (item.type === 'ocr-diagram' || item.type === 'ocr-compare') return ''

    const preview = getHistoryPreview(item).replace(/\s+/g, ' ').trim()

    if (preview.length <= 72) return preview

    return `${preview.slice(0, 72)}...`
  }

  function formatRecentOpenTime(value) {
    const date = new Date(value)

    if (Number.isNaN(date.getTime())) return ''

    const now = new Date()
    const minute = String(date.getMinutes()).padStart(2, '0')
    const dateText = `${date.getMonth() + 1}月${date.getDate()}日${date.getHours()}时${minute}分`

    if (date.getFullYear() === now.getFullYear()) {
      return dateText
    }

    return `${date.getFullYear()}年${dateText}`
  }

  function renderRecentList({ compact = false } = {}) {
    return (
      <section className={compact ? 'recent-panel compact' : 'recent-panel'} aria-label="最近打开">
        <div className="recent-panel-header">
          <h3>最近打开</h3>
          <button
            type="button"
            className="history-clear-button"
            onClick={clearBrowsingHistory}
            disabled={!browsingHistory.length}
          >
            清空记录
          </button>
        </div>

        {recentStatus ? <p className="recent-status error">{recentStatus}</p> : null}

        {browsingHistory.length ? (
          <div className="recent-list">
            {browsingHistory.map((record) => (
              <article key={record.id} className="recent-item">
                <button type="button" className="recent-item-main" onClick={() => openPdfFromRecent(record)}>
                  <strong>{record.fileName}</strong>
                  <span>{formatRecentOpenTime(record.lastOpenedAt)}</span>
                </button>
                <button
                  type="button"
                  className="history-delete-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void deleteBrowsingRecord(record.id)
                  }}
                >
                  删除
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="history-empty">暂无最近打开记录</p>
        )}
      </section>
    )
  }

  function renderHistoryThumbnail(item) {
    if (item.type === 'ocr-diagram' && item.diagramResultImage) {
      return <img src={item.diagramResultImage} alt="图解 OCR 缩略图" />
    }

    if (item.type === 'ocr-compare' && (item.compareOriginalImage || item.compareTranslatedImage)) {
      return (
        <span className="history-compare-thumbnails">
          {item.compareOriginalImage ? <img src={item.compareOriginalImage} alt="对照 OCR 原图缩略图" /> : null}
          {item.compareTranslatedImage ? <img src={item.compareTranslatedImage} alt="对照 OCR 译图缩略图" /> : null}
        </span>
      )
    }

    if (item.type === 'ocr-text' && item.screenshotDataUrl) {
      return <img src={item.screenshotDataUrl} alt="文本 OCR 截图缩略图" />
    }

    return null
  }

  function renderHistoryPreviewText(item) {
    const preview = getShortHistoryPreview(item)

    return preview ? <span>{preview}</span> : null
  }

  function renderAnnotationOverlay() {
    const pageBox = getCurrentPageBox()
    if (!pageBox) return null

    const currentPageAnnotations = documentAnnotations.filter((item) => item.pageNumber === pageNumber)

    return (
      <div className="annotation-layer" aria-hidden="false">
        {previewHighlight?.pageNumber === pageNumber ? previewHighlight.rects.map((rect, index) => {
          const viewRect = denormalizePageRect(rect, pageBox)
          if (!viewRect) return null

          return (
            <div
              className="annotation-preview-highlight"
              key={`preview-${index}`}
              style={{
                left: `${viewRect.left}px`,
                top: `${viewRect.top}px`,
                width: `${viewRect.width}px`,
                height: `${viewRect.height}px`,
                ...getHighlightStyle(previewHighlight.color),
              }}
            />
          )
        }) : null}
        {currentPageAnnotations.filter((item) => item.type === 'text-highlight').flatMap((annotation) =>
          annotation.rects.map((rect, index) => {
            const viewRect = denormalizePageRect(rect, pageBox)
            if (!viewRect) return null

            return (
              <button
                type="button"
                className={activeAnnotationId === annotation.id ? 'annotation-highlight active' : 'annotation-highlight'}
                key={`${annotation.id}-${index}`}
                style={{
                  left: `${viewRect.left}px`,
                  top: `${viewRect.top}px`,
                  width: `${viewRect.width}px`,
                  height: `${viewRect.height}px`,
                  ...getHighlightStyle(annotation.color),
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  handleAnnotationClick(annotation)
                }}
                onContextMenu={(event) => openHighlightContextMenu(event, annotation)}
                title={annotation.noteId ? '打开批注笔记' : '添加批注笔记'}
              />
            )
          }),
        )}
        {!hideOcrNoteTags ? currentPageAnnotations.filter((item) => item.type === 'ocr-note-tag').map((annotation) => {
          const viewRect = denormalizePageRect(annotation.rect, pageBox)
          if (!viewRect) return null

          return (
            <button
              type="button"
              className="ocr-note-tag"
              key={annotation.id}
              style={{
                left: `${viewRect.left + viewRect.width - 14}px`,
                top: `${viewRect.top - 8}px`,
              }}
              onClick={(event) => {
                event.stopPropagation()
                handleAnnotationClick(annotation)
              }}
              title="打开 OCR 笔记"
            >
              <NotebookPen size={14} strokeWidth={1.9} aria-hidden="true" />
            </button>
          )
        }) : null}
      </div>
    )
  }

  function getNotePreview(note) {
    return note.noteText || note.selectedText || note.ocrText || note.translation || note.title || '笔记'
  }

  function renderNoteMedia(note) {
    if (note.type === 'ocr-text-note' && note.screenshotDataUrl) {
      return (
        <button type="button" className="result-image-button" onClick={() => openImagePreviewModal(note.screenshotDataUrl)}>
          <img className="ocr-capture-preview" src={note.screenshotDataUrl} alt="文本 OCR 笔记截图" />
          <span>点击查看大图</span>
        </button>
      )
    }

    if (note.type === 'ocr-diagram-note' && note.diagramResultImage) {
      return (
        <button type="button" className="result-image-button" onClick={() => openImagePreviewModal(note.diagramResultImage, '图解 OCR 笔记')}>
          <img className="ocr-capture-preview" src={note.diagramResultImage} alt="图解 OCR 笔记图片" />
          <span>点击查看大图</span>
        </button>
      )
    }

    if (note.type === 'ocr-compare-note' && (note.compareOriginalImage || note.compareTranslatedImage)) {
      return (
        <button type="button" className="compare-preview-button" onClick={() => openImagePreviewModal(note.compareTranslatedImage || note.compareOriginalImage, '对照 OCR 笔记')}>
          <span className="compare-preview-grid">
            {note.compareOriginalImage ? <img src={note.compareOriginalImage} alt="对照 OCR 原图" /> : null}
            {note.compareTranslatedImage ? <img src={note.compareTranslatedImage} alt="对照 OCR 译图" /> : null}
          </span>
          <span>点击查看大图</span>
        </button>
      )
    }

    return null
  }

  function renderNoteDetail(note) {
    if (!note) return null

    return (
      <section className="note-detail">
        <div className="note-detail-header">
          <div>
            <h3>{note.title || NOTE_TYPE_LABELS[note.type]}</h3>
            <p>
              {NOTE_TYPE_LABELS[note.type]} · 第 {note.pageNumber} 页
            </p>
            <p>创建：{formatHistoryTime(note.createdAt)} · 更新：{formatHistoryTime(note.updatedAt)}</p>
          </div>
          <button type="button" className="history-clear-button" onClick={() => setSelectedNoteId('')}>
            返回笔记列表
          </button>
        </div>

        <section className="ocr-result-section">
          <h3>笔记内容</h3>
          <p className="selected-text">{note.noteText}</p>
        </section>

        {note.selectedText ? (
          <section className="ocr-result-section">
            <h3>原文</h3>
            <p className="selected-text">{note.selectedText}</p>
          </section>
        ) : null}

        {note.ocrText ? (
          <section className="ocr-result-section">
            <h3>OCR 文本</h3>
            <p className="selected-text">{note.ocrText}</p>
          </section>
        ) : null}

        {note.translation ? (
          <section className="ocr-result-section">
            <h3>翻译结果</h3>
            <p className="selected-text">{note.translation}</p>
          </section>
        ) : null}

        {renderNoteMedia(note)}

        <div className="note-detail-actions">
          <button type="button" className="history-clear-button" onClick={() => jumpToNotePage(note)}>
            跳转到该页
          </button>
          <button type="button" className="history-clear-button" onClick={() => openEditNoteDialog(note)}>
            编辑
          </button>
          <button type="button" className="history-delete-button" onClick={() => deleteNote(note)}>
            删除
          </button>
        </div>
      </section>
    )
  }

  function renderNotesPanel() {
    const selectedNote = documentNotes.find((note) => note.id === selectedNoteId)

    return (
      <section className="history-panel notes-panel" aria-label="笔记">
        <div className="history-panel-actions">
          <button
            type="button"
            className="history-clear-button"
            onClick={isNotesBatchSelecting ? deleteSelectedNotes : clearCurrentDocumentNotes}
            disabled={!documentNotes.length || (isNotesBatchSelecting && !selectedNoteIds.length)}
          >
            {isNotesBatchSelecting ? '删除所选' : '清空'}
          </button>
          <button
            type="button"
            className="history-clear-button"
            onClick={() => {
              if (isNotesBatchSelecting) {
                setIsNotesBatchSelecting(false)
                setSelectedNoteIds([])
                return
              }

              setSelectedNoteId('')
              setIsNotesBatchSelecting(true)
            }}
            disabled={!documentNotes.length}
          >
            {isNotesBatchSelecting ? '取消选择' : '批量选择'}
          </button>
        </div>

        {notesStatus ? <p className="note-status">{notesStatus}</p> : null}

        {selectedNote ? (
          renderNoteDetail(selectedNote)
        ) : documentNotes.length ? (
          <div className="history-list">
            {documentNotes.map((note) => (
              <article key={note.id} className="history-item selectable-history-item">
                {isNotesBatchSelecting ? (
                  <input
                    type="checkbox"
                    checked={selectedNoteIds.includes(note.id)}
                    onChange={() => toggleNoteSelection(note.id)}
                    aria-label="选择笔记"
                  />
                ) : null}
                <button
                  type="button"
                  className="history-item-main"
                  onClick={() => (isNotesBatchSelecting ? toggleNoteSelection(note.id) : setSelectedNoteId(note.id))}
                >
                  <span className="history-item-meta">
                    <strong>{NOTE_TYPE_LABELS[note.type] || note.title}</strong>
                    <span>第 {note.pageNumber} 页</span>
                    <span>{formatHistoryTime(note.updatedAt)}</span>
                  </span>
                  <span className="history-item-content">
                    <span>{getShortHistoryPreview({ type: 'text-selection', selectedText: getNotePreview(note) })}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="history-delete-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteNote(note)
                  }}
                >
                  删除
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    )
  }

  function getFileExportDocumentIds() {
    if (fileExportScope === 'current') {
      const documentId = selectedExportDetailDocumentId || currentDocument?.documentId
      return documentId ? [documentId] : []
    }
    if (fileExportScope === 'selected') return selectedFileExportDocumentIds
    if (fileExportScope === 'all') return libraryDocuments.map((document) => document.documentId)
    if (fileExportScope === 'recycle') return recycledLibraryDocuments.map((document) => document.documentId)
    const folderId = fileExportFolderId === 'unfiled' ? null : fileExportFolderId
    const folderIds = fileExportScope === 'folder-tree' && folderId
      ? getLibraryDescendantFolderIds(folderId)
      : new Set(folderId ? [folderId] : [])
    return libraryDocuments
      .filter((document) => (folderId ? folderIds.has(document.folderId) : !document.folderId))
      .map((document) => document.documentId)
  }

  function getSelectedExportRecordCount(items, options) {
    return items.reduce((total, item) => {
      const highlights = item.annotations.filter((annotation) => annotation.type === 'text-highlight').length
      const annotations = item.annotations.length - highlights
      return total +
        (options.exportNotes ? item.notes.length : 0) +
        (options.exportHistories ? item.histories.length : 0) +
        (options.exportHighlights ? highlights : 0) +
        (options.exportAnnotations ? annotations : 0) +
        (options.exportBookmarks ? item.bookmarks.length : 0)
    }, 0)
  }

  function openFileExportFromHistory() {
    const selectedDocument = getHistoryLibraryDocuments().find((document) => document.documentId === selectedExportDetailDocumentId)
    if (historyLibraryNodeId === 'recycle' && historySelectedRecycleIds.length > 1) {
      setSelectedFileExportDocumentIds(historySelectedRecycleIds)
      setFileExportScope('selected')
    } else if (selectedDocument) {
      setSelectedFileExportDocumentIds([selectedDocument.documentId])
      setFileExportScope('current')
    } else if (historyLibraryNodeId === 'all') {
      setFileExportScope('all')
    } else if (historyLibraryNodeId === 'recycle') {
      setFileExportScope('recycle')
    } else {
      setFileExportFolderId(historyLibraryNodeId)
      setFileExportScope('folder-tree')
      setFileExportMethod('folder')
    }
    setImportExportTab('fileExport')
    setExportStatus('')
    setExportFailures([])
  }

  async function exportFiles() {
    const documentIds = Array.from(new Set(getFileExportDocumentIds()))
    if (!documentIds.length) {
      setExportStatus('请选择文献')
      return
    }
    if (!hasSelectedContentExportOption(fileExportContents)) {
      setExportStatus('请至少选择一项导出内容')
      return
    }

    setIsFileExporting(true)
    setExportStatus('')
    setExportFailures([])
    try {
      const generatorOptions = fileExportFormat === 'markdown'
        ? { ...fileExportContents, ...markdownFormatOptions }
        : { ...fileExportContents, ...pdfFormatOptions }
      const items = await collectMarkdownExportItems(documentIds, '文件导出')
      const recordCount = getSelectedExportRecordCount(items, fileExportContents)
      if (!recordCount) throw new Error('所选文献没有符合条件的记录')

      const outputName = batchExportNameRef.current.trim() || `${fileExportFormat === 'markdown' ? 'Markdown' : 'PDF'}导出_${items.length}篇文献`
      const exportDocumentsById = new Map(exportableDocuments.map((document) => [document.documentId, document]))
      let result
      if (fileExportFormat === 'markdown') {
        result = fileExportMethod === 'merged'
          ? await window.electronAPI.saveMarkdownFile({
              markdown: buildBatchPdfMarkdown(items, generatorOptions),
              defaultFileName: makeSafeMarkdownFileName(outputName),
            })
          : await window.electronAPI.saveMarkdownBatchFiles({
              outputName,
              files: items.map((item) => ({
                fileName: makeSafeMarkdownFileName(getPdfDisplayName(item.pdf)),
                markdown: buildPdfMarkdown(item, generatorOptions),
                relativePath: fileExportMethod === 'folder' ? getFileExportRelativePath(exportDocumentsById.get(item.pdf.documentId) || item.pdf) : '',
              })),
            })
      } else {
        result = fileExportMethod === 'merged'
          ? await window.electronAPI.savePdfReport({
              html: assertPdfReportHtml(buildBatchPdfReportHtml(items, generatorOptions)),
              defaultFileName: makeSafePdfReportFileName(outputName),
            })
          : await window.electronAPI.saveBatchPdfReports({
              outputName,
              files: items.map((item) => ({
                fileName: makeSafePdfReportFileName(getPdfDisplayName(item.pdf)),
                html: assertPdfReportHtml(buildPdfReportHtml(item, generatorOptions)),
                relativePath: fileExportMethod === 'folder' ? getFileExportRelativePath(exportDocumentsById.get(item.pdf.documentId) || item.pdf) : '',
              })),
            })
      }

      setExportFailures(result?.errors || [])
      if (result?.error) {
        const detail = (result.errors || []).map((failure) => `${failure.fileName}：${failure.error}`).join('；')
        throw new Error(detail ? `${result.error}：${detail}` : result.error)
      }
      if (!result?.canceled) {
        const failures = result.errors?.length || 0
        setExportStatus(`导出完成\n文献 ${(result.filePaths?.length || (result.filePath ? items.length : 0))}\n记录 ${recordCount}\n失败 ${failures}`)
      }
    } catch (error) {
      setExportStatus(error.message || '导出失败')
    } finally {
      setIsFileExporting(false)
    }
  }

  function renderBookmarksPanel() {
    return (
      <section className="history-panel bookmarks-panel" aria-label="书签">
        <div className="bookmark-add-row">
          <button type="button" className="settings-primary-button bookmark-add-button" onClick={openBookmarkDialog}>
            添加书签
          </button>
        </div>

        <div className="history-panel-actions bookmark-management-actions">
          <button
            type="button"
            className="history-clear-button"
            onClick={deleteSelectedBookmarks}
            disabled={!selectedBookmarkIds.length}
          >
            删除所选
          </button>
          <button
            type="button"
            className="history-clear-button"
            onClick={clearCurrentDocumentBookmarks}
            disabled={!documentBookmarks.length}
          >
            清空
          </button>
          <button
            type="button"
            className="history-clear-button"
            onClick={() => {
              if (isBookmarksBatchSelecting) {
                setIsBookmarksBatchSelecting(false)
                setSelectedBookmarkIds([])
                return
              }

              setIsBookmarksBatchSelecting(true)
            }}
            disabled={!documentBookmarks.length}
          >
            {isBookmarksBatchSelecting ? '取消选择' : '批量选择'}
          </button>
        </div>

        {bookmarksStatus ? <p className="note-status">{bookmarksStatus}</p> : null}

        {documentBookmarks.length ? (
          <div className="history-list bookmark-list">
            {documentBookmarks.map((bookmark) => (
              <article key={bookmark.id} className="history-item bookmark-item">
                {isBookmarksBatchSelecting ? (
                  <input
                    type="checkbox"
                    checked={selectedBookmarkIds.includes(bookmark.id)}
                    onChange={() => toggleBookmarkSelection(bookmark.id)}
                    aria-label="选择书签"
                  />
                ) : null}
                <button
                  type="button"
                  className="bookmark-item-main"
                  onClick={() => (isBookmarksBatchSelecting ? toggleBookmarkSelection(bookmark.id) : jumpToBookmark(bookmark))}
                >
                  <span>第 {bookmark.pageNumber} 页</span>
                  <strong>{bookmark.title}</strong>
                </button>
              </article>
            ))}
          </div>
        ) : (
          <p className="history-empty">暂无书签</p>
        )}
      </section>
    )
  }

  function renderTocItem(item) {
    const subsections = Array.isArray(item.children)
      ? item.children
      : Array.isArray(item.subsections)
        ? item.subsections
        : []
    const hasSubsections = subsections.length > 0
    const isCollapsed = collapsedTocItemIds.includes(item.id)

    return (
      <div key={item.id} className={item.level >= 2 ? 'toc-tree-item level-two' : 'toc-tree-item'}>
        <div className="toc-tree-row">
          {hasSubsections ? (
            <button
              type="button"
              className={isCollapsed ? 'toc-collapse-button collapsed' : 'toc-collapse-button'}
              onClick={() => toggleTocItemCollapsed(item.id)}
              aria-label={isCollapsed ? '展开小节' : '折叠小节'}
              title={isCollapsed ? '展开' : '折叠'}
            >
              ▾
            </button>
          ) : (
            <span className="toc-collapse-spacer" aria-hidden="true" />
          )}
          <button type="button" className="toc-item-main" onClick={() => jumpToTocItem(item)}>
            <span>{item.title}</span>
            <strong>
              {item.pageNumber || (Number.isFinite(Number(item.pageIndex)) ? Number(item.pageIndex) + 1 : item.pageStart)}
            </strong>
          </button>
        </div>
        {hasSubsections && !isCollapsed ? (
          <div className="toc-subsection-list">
            {subsections.map((subsection) => renderTocItem(subsection))}
          </div>
        ) : null}
      </div>
    )
  }

  function renderTocPanel() {
    if (!pdfUrl || isTocGenerating) {
      return <section className="toc-panel toc-panel-empty" aria-label="目录" />
    }

    if (!documentToc.length) {
      return (
        <section className="toc-panel toc-panel-empty" aria-label="目录">
          {tocStatus ? <p className="toc-unavailable">无法识别出目录</p> : null}
        </section>
      )
    }

    return (
      <section className="toc-panel" aria-label="目录">
        <h2 className="toc-panel-title">目录</h2>
        <div className="toc-tree-list">
          {documentToc.map((item) => renderTocItem(item))}
        </div>
      </section>
    )
  }

  function renderHistoryPanel() {
    return (
      <section className="history-panel" aria-label="翻译历史记录">
        <div className="history-panel-actions">
          <button
            type="button"
            className="history-clear-button"
            onClick={isHistoryBatchSelecting ? deleteSelectedHistoryItems : clearHistory}
            disabled={!translationHistory.length || (isHistoryBatchSelecting && !selectedHistoryIds.length)}
          >
            {isHistoryBatchSelecting ? '删除所选' : '清空'}
          </button>
          <button
            type="button"
            className="history-clear-button"
            onClick={() => {
              if (isHistoryBatchSelecting) {
                setIsHistoryBatchSelecting(false)
                setSelectedHistoryIds([])
                return
              }

              setIsHistoryBatchSelecting(true)
            }}
            disabled={!translationHistory.length}
          >
            {isHistoryBatchSelecting ? '取消选择' : '批量选择'}
          </button>
        </div>
        <p className="history-panel-limit">最多保留最新 {HISTORY_LIMIT} 条</p>

        {historyStatus ? <p className="note-status">{historyStatus}</p> : null}

        {translationHistory.length ? (
          <div className="history-list">
            {translationHistory.map((item) => (
              <article key={item.id} className="history-item selectable-history-item">
                {isHistoryBatchSelecting ? (
                  <input
                    type="checkbox"
                    checked={selectedHistoryIds.includes(item.id)}
                    onChange={() => toggleHistorySelection(item.id)}
                    aria-label="选择翻译历史"
                  />
                ) : null}
                <button
                  type="button"
                  className="history-item-main"
                  onClick={() => (isHistoryBatchSelecting ? toggleHistorySelection(item.id) : restoreHistoryItem(item))}
                >
                  <span className="history-item-meta">
                    <strong>{HISTORY_TYPE_LABELS[item.type] || item.title}</strong>
                    {item.pageNumber ? <span>第 {item.pageNumber} 页</span> : null}
                    <span>{formatHistoryTime(item.createdAt)}</span>
                  </span>
                  <span className="history-item-content">
                    {renderHistoryThumbnail(item)}
                    {renderHistoryPreviewText(item)}
                  </span>
                </button>
                <button
                  type="button"
                  className="history-delete-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteHistoryItem(item.id)
                  }}
                  aria-label="删除这条历史记录"
                >
                  删除
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    )
  }

  function renderContentExportOptions(options, setOptions, disabled = false) {
    const toggleOption = (key) => {
      setOptions((currentOptions) => ({
        ...currentOptions,
        [key]: !currentOptions[key],
      }))
    }
    return (
      <fieldset className="content-export-options" aria-label="选择导出内容">
        <div className="content-export-option-list">
          {CONTENT_EXPORT_OPTION_ITEMS.map((item) => (
            <label className="content-export-option" key={item.key}>
              <input
                type="checkbox"
                checked={Boolean(options[item.key])}
                disabled={disabled}
                onChange={() => toggleOption(item.key)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  function renderExportDetailGroup(title, records, previewGetter) {
    const visibleRecords = records.slice(0, 6)

    return (
      <section className="export-detail-group">
        <header>
          <h4>{title}</h4>
          <span>{records.length} 条</span>
        </header>
        {visibleRecords.length ? (
          <div className="export-detail-list">
            {visibleRecords.map((record, index) => (
              <article className="export-detail-item" key={record.id || `${title}-${index}`}>
                <span className="export-detail-page">{getExportDetailPageText(record)}</span>
                <p>{previewGetter(record)}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="export-detail-empty">暂无内容</p>
        )}
        {records.length > visibleRecords.length ? (
          <p className="export-detail-more">还有 {records.length - visibleRecords.length} 条未在预览中显示</p>
        ) : null}
      </section>
    )
  }

  function renderExportDocumentDetail() {
    const document = exportableDocuments.find((item) => item.documentId === selectedExportDetailDocumentId)
    if (!document) return null

    const detail = exportDocumentDetail?.documentId === selectedExportDetailDocumentId
      ? exportDocumentDetail
      : null

    return (
      <section className="export-document-detail">
        <div className="export-document-detail-header">
          <h3>{getExportDocumentDisplayName(document)}</h3>
          <span>文件详情</span>
        </div>
        {exportDocumentDetailStatus ? (
          <p className="export-detail-empty">{exportDocumentDetailStatus}</p>
        ) : (
          <div className="export-detail-grid">
            {renderExportDetailGroup('笔记', detail?.notes || [], getExportNoteDetailPreview)}
            {renderExportDetailGroup('翻译历史', detail?.histories || [], getExportHistoryDetailPreview)}
            {renderExportDetailGroup('高亮', (detail?.annotations || []).filter((item) => item.type === 'text-highlight'), getExportAnnotationDetailPreview)}
            {renderExportDetailGroup('批注', (detail?.annotations || []).filter((item) => item.type !== 'text-highlight'), getExportAnnotationDetailPreview)}
            {renderExportDetailGroup('书签', detail?.bookmarks || [], getExportBookmarkDetailPreview)}
          </div>
        )}
      </section>
    )
  }

  function renderSearchDialog() {
    if (!searchDialog.open) return null

    const dialogTitle = searchDialog.source === 'reader' ? '搜索当前 PDF' : '全局搜索'

    return (
      <div
        className="search-overlay"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeSearchDialog()
        }}
      >
        <section className="search-dialog" role="dialog" aria-modal="true" aria-label={dialogTitle}>
          <header className="search-dialog-header">
            <h2>{dialogTitle}</h2>
            <IconButton className="search-dialog-close" onClick={closeSearchDialog} label="关闭搜索">
              <X size={17} strokeWidth={1.9} />
            </IconButton>
          </header>
          <div className="search-dialog-controls">
            <label className="search-dialog-input">
              <Search size={17} strokeWidth={1.8} aria-hidden="true" />
              <input
                ref={searchDialogInputRef}
                type="search"
                value={searchDialog.query}
                onChange={(event) => updateSearchDialogQuery(event.target.value)}
                onKeyDown={handleSearchDialogKeyDown}
                aria-label={dialogTitle}
              />
            </label>
            <select
              className="search-scope-select"
              value={searchDialog.scope}
              onChange={(event) => updateSearchDialogScope(event.target.value)}
              aria-label="搜索范围"
            >
              {SEARCH_SCOPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="search-result-list">
            {searchResults.map((result) => (
              <button
                type="button"
                className="search-result-item"
                key={result.id}
                onClick={() => void openSearchResult(result)}
              >
                <span className="search-result-type">{SEARCH_RESULT_TYPE_LABELS[result.type] || result.type}</span>
                <strong>{result.title}</strong>
                {result.subtitle ? <span>{result.subtitle}</span> : null}
                <p>{result.snippet}</p>
              </button>
            ))}
            {searchStatus ? <p className="search-status">{searchStatus}</p> : null}
          </div>
        </section>
      </div>
    )
  }

  function toggleFileExportDocument(documentId) {
    setSelectedExportDetailDocumentId(documentId)
    setSelectedFileExportDocumentIds((currentIds) => (
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId]
    ))
  }

  function toggleExportFolderTreeExpanded(folderId) {
    setExportFolderTreeExpandedIds((currentIds) => {
      const nextIds = new Set(currentIds)
      if (nextIds.has(folderId)) nextIds.delete(folderId)
      else nextIds.add(folderId)
      return nextIds
    })
  }

  function renderFileExportDocumentRow(document, {
    selectedIds = selectedFileExportDocumentIds,
    onToggle = toggleFileExportDocument,
    disabled = isFileExporting,
    depth = 0,
  } = {}) {
    const documentName = getExportDocumentDisplayName(document)
    return (
      <div className="file-export-document-row" key={`file-export-${document.documentId}`} style={{ '--folder-depth': depth }}>
        <input
          type="checkbox"
          checked={selectedIds.includes(document.documentId)}
          disabled={disabled}
          onChange={() => onToggle(document.documentId)}
        />
        <button type="button" onClick={() => setSelectedExportDetailDocumentId(document.documentId)}>{documentName}</button>
        <span>{document.recordCount || 0}</span>
      </div>
    )
  }

  function renderFileExportFolderBranch(folder, depth = 1, options = {}) {
    const {
      selectedIds = [],
      onToggle = () => {},
      disabled = false,
      showDocuments = true,
      selectFolder = false,
    } = options
    const documents = exportableDocuments.filter((document) => document.status !== 'recycled' && document.folderId === folder.id)
    const children = getLibraryFolderChildren(folder.id)
    const isExpanded = exportFolderTreeExpandedIds.has(folder.id)
    const isSelected = selectFolder && fileExportFolderId === folder.id
    const canExpand = children.length > 0 || (showDocuments && documents.length > 0)

    return (
      <div className="file-export-folder-branch" key={`export-folder-${folder.id}`}>
        <div className="file-export-folder-tree-row" style={{ '--folder-depth': depth }}>
          {canExpand ? (
            <TreeChevron
              expanded={isExpanded}
              onToggle={() => toggleExportFolderTreeExpanded(folder.id)}
            />
          ) : <span className="tree-chevron-spacer" />}
          {selectFolder ? (
            <button
              type="button"
              className={isSelected ? 'file-export-folder-node active' : 'file-export-folder-node'}
              onClick={() => setFileExportFolderId(folder.id)}
            >
              <span>{folder.name}</span>
            </button>
          ) : <div className="file-export-folder-node"><span>{folder.name}</span></div>}
        </div>
        {isExpanded ? (
          <>
            {showDocuments ? documents.map((document) => renderFileExportDocumentRow(document, {
              selectedIds,
              onToggle,
              disabled,
              depth: depth + 1,
            })) : null}
            {children.map((child) => renderFileExportFolderBranch(child, depth + 1, options))}
          </>
        ) : null}
      </div>
    )
  }

  function renderFileExportFolderTree({
    selectedIds = [],
    onToggle = () => {},
    disabled = false,
    showDocuments = true,
    selectFolder = false,
    includeRecycle = false,
  } = {}) {
    const isUnfiledSelected = selectFolder && fileExportFolderId === 'unfiled'
    const unfiledDocuments = exportableDocuments.filter((document) => document.status !== 'recycled' && !document.folderId)
    const recycledDocuments = exportableDocuments.filter((document) => document.status === 'recycled')
    const options = { selectedIds, onToggle, disabled, showDocuments, selectFolder }

    return (
      <div className="file-export-selection-tree">
        <div className="file-export-folder-branch">
          <div className="file-export-folder-tree-row" style={{ '--folder-depth': 0 }}>
            <TreeChevron
              expanded={exportFolderTreeRootExpanded}
              onToggle={() => setExportFolderTreeRootExpanded((expanded) => !expanded)}
            />
            <div className="file-export-folder-node"><span>全部文献</span></div>
          </div>
          {exportFolderTreeRootExpanded ? (
            <>
              <div className="file-export-folder-branch">
                <div className="file-export-folder-tree-row" style={{ '--folder-depth': 1 }}>
                  {showDocuments && unfiledDocuments.length ? (
                    <TreeChevron
                      expanded={exportFolderTreeUnfiledExpanded}
                      onToggle={() => setExportFolderTreeUnfiledExpanded((expanded) => !expanded)}
                    />
                  ) : <span className="tree-chevron-spacer" />}
                  {selectFolder ? (
                    <button
                      type="button"
                      className={isUnfiledSelected ? 'file-export-folder-node active' : 'file-export-folder-node'}
                      onClick={() => setFileExportFolderId('unfiled')}
                    >
                      <span>未分类</span>
                    </button>
                  ) : <div className="file-export-folder-node"><span>未分类</span></div>}
                </div>
                {showDocuments && exportFolderTreeUnfiledExpanded ? unfiledDocuments.map((document) => renderFileExportDocumentRow(document, {
                  selectedIds,
                  onToggle,
                  disabled,
                  depth: 2,
                })) : null}
              </div>
              {getLibraryFolderChildren(null).map((folder) => renderFileExportFolderBranch(folder, 1, options))}
            </>
          ) : null}
        </div>
        {includeRecycle ? (
          <div className="file-export-folder-branch recycle">
            <div className="file-export-folder-tree-row" style={{ '--folder-depth': 0 }}>
              {showDocuments && recycledDocuments.length ? (
                <TreeChevron
                  expanded={exportFolderTreeRecycleExpanded}
                  onToggle={() => setExportFolderTreeRecycleExpanded((expanded) => !expanded)}
                />
              ) : <span className="tree-chevron-spacer" />}
              <div className="file-export-folder-node"><span>回收箱</span></div>
            </div>
            {showDocuments && exportFolderTreeRecycleExpanded ? recycledDocuments.map((document) => renderFileExportDocumentRow(document, {
              selectedIds,
              onToggle,
              disabled,
              depth: 1,
            })) : null}
          </div>
        ) : null}
      </div>
    )
  }

  function getFileExportRelativePath(document) {
    if (document.status === 'recycled') return '回收箱'
    if (!document.folderId) return '未分类'
    const names = []
    const visited = new Set()
    let folderId = document.folderId
    while (folderId && !visited.has(folderId)) {
      visited.add(folderId)
      const folder = libraryFolders.find((item) => item.id === folderId)
      if (!folder) break
      names.unshift(folder.name)
      folderId = folder.parentId
    }
    return names.join('/') || '未分类'
  }

  function renderImportExportSettings() {
    const historyDocuments = getHistoryLibraryDocuments()
    const historyRecordCount = historyDocuments.reduce((total, document) => total + (document.recordCount || 0), 0)
    const selectedRecycleIdSet = new Set(historySelectedRecycleIds)

    return (
      <div className="settings-dialog module-settings-panel import-export-settings-panel">
        <div className="settings-dialog-body">
          <nav className="settings-tabs" aria-label="文献数据工具">
          <button
            type="button"
            className={importExportTab === 'libraryRecords' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('libraryRecords')}
          >
            文献与记录
          </button>
          <button
            type="button"
            className={importExportTab === 'backupRestore' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('backupRestore')}
          >
            备份与恢复
          </button>
          <button
            type="button"
            className={importExportTab === 'fileExport' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('fileExport')}
          >
            导出文件
          </button>
          </nav>

          <div className="settings-content">
            <section className="settings-page import-export-page">

        {importExportTab === 'libraryRecords' ? (
          <section className="history-library-browser">
            <aside className="history-library-tree">
              <div className="history-library-tree-header">
                <strong>文献分类</strong>
                <small>{libraryLiteratures.length}</small>
              </div>
              <button
                type="button"
                className={historyLibraryNodeId === 'all' ? 'library-folder-button active' : 'library-folder-button'}
                onClick={() => setHistoryLibraryNodeId('all')}
              >
                <span>全部文献</span>
                <small>{libraryDocuments.length}</small>
              </button>
              <div className="history-library-folder-tree">
                <div className="library-folder-tree-row history-mode" style={{ '--folder-depth': 0 }}>
                  <span className="tree-chevron-spacer" />
                  <button
                    type="button"
                    className={historyLibraryNodeId === 'unfiled' ? 'library-folder-button active' : 'library-folder-button'}
                    onClick={() => setHistoryLibraryNodeId('unfiled')}
                  >
                    <span>未分类</span>
                    <small>{libraryDocuments.filter((document) => !document.folderId).length}</small>
                  </button>
                </div>
                {getLibraryFolderChildren(null).map((folder) => renderLibraryFolderTreeNode(folder, 0, 'history'))}
              </div>
              <div className="history-library-system-divider" />
              <button
                type="button"
                className={historyLibraryNodeId === 'recycle' ? 'library-folder-button active recycle' : 'library-folder-button recycle'}
                onClick={() => setHistoryLibraryNodeId('recycle')}
              >
                <span>回收箱</span>
                <small>{recycledLibraryDocuments.length}</small>
              </button>
            </aside>

            <div className="history-library-content">
              <div className="history-library-toolbar">
                <div>
                  <strong>{historyLibraryNodeId === 'recycle' ? '回收箱' : historyLibraryNodeId === 'all' ? '全部文献' : getLibraryFolderName(historyLibraryNodeId)}</strong>
                  <span>{historyDocuments.length} 篇 · {historyRecordCount} 条记录</span>
                </div>
                {!["all", "unfiled", "recycle"].includes(historyLibraryNodeId) ? (
                  <label className="history-library-toggle">
                    <input
                      type="checkbox"
                      checked={historyIncludeDescendants}
                      onChange={(event) => setHistoryIncludeDescendants(event.target.checked)}
                    />
                    包含子文件夹
                  </label>
                ) : null}
                <button type="button" className="settings-primary-button" onClick={openFileExportFromHistory}>
                  导出
                </button>
              </div>

              {historyLibraryNodeId === 'recycle' && historySelectedRecycleIds.length ? (
                <div className="history-library-selection-bar">
                  <span>已选 {historySelectedRecycleIds.length} 篇</span>
                  <button type="button" className="settings-secondary-button" onClick={() => void restoreRecycledDocuments(historySelectedRecycleIds)}>
                    恢复
                  </button>
                  <button type="button" className="settings-secondary-button" onClick={() => void permanentlyDeleteRecycledDocuments(historySelectedRecycleIds)}>
                    永久删除
                  </button>
                </div>
              ) : null}

              <div className="history-library-document-list">
                {historyDocuments.length ? historyDocuments.map((document) => (
                  <article className={document.recordCount ? 'history-library-document' : 'history-library-document empty-records'} key={document.documentId}>
                    {historyLibraryNodeId === 'recycle' ? (
                      <input
                        type="checkbox"
                        checked={selectedRecycleIdSet.has(document.documentId)}
                        onChange={() => setHistorySelectedRecycleIds((current) => (
                          current.includes(document.documentId)
                            ? current.filter((id) => id !== document.documentId)
                            : [...current, document.documentId]
                        ))}
                        aria-label={`选择 ${document.displayName || document.fileName}`}
                      />
                    ) : null}
                    <button type="button" className="history-library-document-main" onClick={() => setSelectedExportDetailDocumentId(document.documentId)}>
                      <strong>{document.displayName || document.fileName}</strong>
                      <span>{document.recordCount || 0} 条记录</span>
                    </button>
                    <span className="history-library-document-folder">
                      {historyLibraryNodeId === 'recycle'
                        ? `移入 ${formatHistoryTime(document.recycledAt)}`
                        : getLibraryFolderName(document.folderId)}
                    </span>
                    {historyLibraryNodeId === 'recycle' ? (
                      <div className="history-library-document-actions">
                        <IconButton onClick={() => void restoreRecycledDocuments([document.documentId])} label="恢复到文献库" title="恢复">
                          <RotateCcw size={15} />
                        </IconButton>
                        <button type="button" onClick={() => {
                          setSelectedFileExportDocumentIds([document.documentId])
                          setSelectedExportDetailDocumentId(document.documentId)
                          setFileExportScope('selected')
                          setImportExportTab('fileExport')
                        }}>导出</button>
                        <IconButton onClick={() => void permanentlyDeleteRecycledDocuments([document.documentId])} label="永久删除" title="永久删除">
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    ) : null}
                  </article>
                )) : null}
              </div>
              {historyDocuments.some((document) => document.documentId === selectedExportDetailDocumentId)
                ? renderExportDocumentDetail()
                : null}
            </div>
          </section>
        ) : null}

        {importExportTab === 'backupRestore' ? (
          <>
            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>默认备份位置</h3>
                <span>{exportDefaultDir || 'Downloads'}</span>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="settings-secondary-button" onClick={selectExportDefaultDir}>
                  选择文件夹
                </button>
                <button type="button" className="settings-secondary-button" onClick={resetExportDefaultDir}>
                  恢复默认
                </button>
              </div>
            </section>

            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>备份范围</h3>
                <span>{selectedExportDocumentIds.length} / {exportableDocuments.length} 篇</span>
              </div>
              <label className="settings-field backup-name-field">
                <span>备份名称</span>
                <input
                  type="text"
                  defaultValue={batchExportNameRef.current}
                  onInput={(event) => {
                    batchExportNameRef.current = event.currentTarget.value
                  }}
                  placeholder="Paper Reader 备份"
                />
              </label>

              {renderFileExportFolderTree({
                selectedIds: selectedExportDocumentIds,
                onToggle: toggleExportDocument,
                includeRecycle: true,
              })}

              <div className="settings-inline-actions backup-actions">
                <button type="button" className="settings-primary-button" onClick={() => void backupPaperReaderData('full')}>
                  完整备份
                </button>
                <button type="button" className="settings-secondary-button" onClick={() => void backupPaperReaderData('selected')} disabled={!selectedExportDocumentIds.length}>
                  选择文献备份
                </button>
              </div>
            </section>

            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>恢复</h3>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="settings-primary-button" onClick={batchImportPaperReaderData}>
                  导入备份
                </button>
              </div>
            </section>
          </>
        ) : null}

        {importExportTab === 'fileExport' ? (
          <section className="file-export-workspace">
            <section className="file-export-section">
              <h3>导出范围</h3>
              <div className="file-export-scope-grid">
                {[
                  ['current', '当前文献'],
                  ['selected', '选中文献'],
                  ['folder', '当前文件夹'],
                  ['folder-tree', '当前文件夹及子文件夹'],
                  ['all', '全部文献'],
                  ['recycle', '回收箱'],
                ].map(([value, label]) => (
                  <label key={value} className={fileExportScope === value ? 'file-export-choice active' : 'file-export-choice'}>
                    <input type="radio" name="file-export-scope" value={value} checked={fileExportScope === value} onChange={() => setFileExportScope(value)} />
                    {label}
                  </label>
                ))}
              </div>
              {['folder', 'folder-tree'].includes(fileExportScope) ? renderFileExportFolderTree({
                showDocuments: false,
                selectFolder: true,
              }) : null}
              {fileExportScope === 'selected' ? (
                renderFileExportFolderTree({
                  selectedIds: selectedFileExportDocumentIds,
                  onToggle: toggleFileExportDocument,
                  disabled: isFileExporting,
                  includeRecycle: true,
                })
              ) : null}
            </section>

            <section className="file-export-section">
              <h3>导出内容</h3>
              {renderContentExportOptions(fileExportContents, setFileExportContents, isFileExporting)}
            </section>

            <section className="file-export-section file-export-two-column">
              <div>
                <h3>输出格式</h3>
                <div className="segmented-control">
                  <button type="button" className={fileExportFormat === 'markdown' ? 'active' : ''} onClick={() => setFileExportFormat('markdown')}>Markdown</button>
                  <button type="button" className={fileExportFormat === 'pdf' ? 'active' : ''} onClick={() => setFileExportFormat('pdf')}>PDF</button>
                </div>
              </div>
              <div>
                <h3>导出方式</h3>
                <select value={fileExportMethod} onChange={(event) => setFileExportMethod(event.target.value)}>
                  <option value="merged">合并导出</option>
                  <option value="batch">批量导出</option>
                  <option value="folder">按文件夹导出</option>
                </select>
              </div>
            </section>

            <section className="file-export-section">
              <h3>{fileExportFormat === 'markdown' ? 'Markdown 设置' : 'PDF 设置'}</h3>
              {fileExportFormat === 'markdown' ? (
                <div className="file-export-option-row">
                  <label><input type="checkbox" checked={markdownFormatOptions.includeOriginal} onChange={(event) => setMarkdownFormatOptions((current) => ({ ...current, includeOriginal: event.target.checked }))} />包含原文</label>
                  <label><input type="checkbox" checked={markdownFormatOptions.generateToc} onChange={(event) => setMarkdownFormatOptions((current) => ({ ...current, generateToc: event.target.checked }))} />生成目录</label>
                  <label><input type="checkbox" checked={markdownFormatOptions.groupByType} onChange={(event) => setMarkdownFormatOptions((current) => ({ ...current, groupByType: event.target.checked }))} />按记录类型分节</label>
                </div>
              ) : (
                <div className="file-export-format-grid">
                  <label><span>页面尺寸</span><select value={pdfFormatOptions.pageSize} onChange={(event) => setPdfFormatOptions((current) => ({ ...current, pageSize: event.target.value }))}><option value="A4">A4</option><option value="Letter">Letter</option></select></label>
                  <label><span>页边距</span><select value={pdfFormatOptions.pageMargin} onChange={(event) => setPdfFormatOptions((current) => ({ ...current, pageMargin: event.target.value }))}><option value="compact">紧凑</option><option value="normal">标准</option><option value="wide">宽</option></select></label>
                  <label><input type="checkbox" checked={pdfFormatOptions.showPageNumbers} onChange={(event) => setPdfFormatOptions((current) => ({ ...current, showPageNumbers: event.target.checked }))} />显示页码</label>
                  <label><input type="checkbox" checked={pdfFormatOptions.includeOriginal} onChange={(event) => setPdfFormatOptions((current) => ({ ...current, includeOriginal: event.target.checked }))} />包含原文</label>
                  <label><input type="checkbox" checked={pdfFormatOptions.groupByType} onChange={(event) => setPdfFormatOptions((current) => ({ ...current, groupByType: event.target.checked }))} />按记录类型分节</label>
                </div>
              )}
            </section>

            <section className="file-export-section">
              <h3>保存设置</h3>
              <div className="file-export-save-grid">
                <label className="settings-field">
                  <span>导出名称</span>
                  <input
                    type="text"
                    defaultValue={batchExportNameRef.current}
                    onInput={(event) => {
                      batchExportNameRef.current = event.currentTarget.value
                    }}
                    placeholder="未命名导出"
                  />
                </label>
                <div className="file-export-location"><span>{exportDefaultDir || 'Downloads'}</span><button type="button" className="settings-secondary-button" onClick={selectExportDefaultDir}>选择文件夹</button><button type="button" className="settings-secondary-button" onClick={resetExportDefaultDir}>恢复默认</button></div>
              </div>
            </section>

            <section className="file-export-section file-export-preview">
              <div className="settings-section-header"><h3>预览</h3><span>{getFileExportDocumentIds().length} 篇</span></div>
              {getFileExportDocumentIds().includes(selectedExportDetailDocumentId) ? renderExportDocumentDetail() : null}
            </section>

            <div className="file-export-submit">
              <button type="button" className="settings-primary-button" onClick={() => void exportFiles()} disabled={isFileExporting || !getFileExportDocumentIds().length || !hasSelectedContentExportOption(fileExportContents)}>
                {isFileExporting ? '导出中...' : '导出'}
              </button>
            </div>
          </section>
        ) : null}

        {exportStatus ? <p className="settings-status">{exportStatus}</p> : null}
        {exportFailures.length ? (
          <details className="export-failure-list">
            <summary>失败列表</summary>
            {exportFailures.map((failure, index) => (
              <p key={`${failure.fileName || 'file'}-${index}`}>{failure.fileName || '未命名文件'}：{failure.error || '导出失败'}</p>
            ))}
          </details>
        ) : null}
            </section>
          </div>
        </div>
        {permanentDeleteDialogIds.length ? (
          <div className="note-dialog-overlay" role="presentation">
            <section className="note-dialog library-delete-dialog" aria-label="永久删除" onClick={(event) => event.stopPropagation()}>
              <div className="diagram-dialog-header">
                <h2>永久删除</h2>
              </div>
              <p>将删除该文献及全部历史记录，此操作无法撤销。</p>
              <div className="settings-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setPermanentDeleteDialogIds([])}>取消</button>
                <button type="button" className="settings-primary-button" onClick={() => void confirmPermanentlyDeleteRecycledDocuments()}>永久删除</button>
              </div>
            </section>
          </div>
        ) : null}
      </div>
    )
  }

  function renderLibraryFolderTreeNode(folder, depth = 0, mode = 'library') {
    const children = getLibraryFolderChildren(folder.id)
    const isExpanded = folder.expanded !== false
    const isHistoryMode = mode === 'history'
    const isSelected = isHistoryMode ? historyLibraryNodeId === folder.id : selectedLibraryFolderId === folder.id
    const documentCount = getLibraryFolderDocumentCount(folder.id, true)
    const recordCount = getLibraryFolderRecordCount(folder.id, true)
    const isDragging = draggedLibraryFolderId === folder.id
    const dropPlacement = libraryFolderDropTarget?.folderId === folder.id
      ? libraryFolderDropTarget.placement
      : ''

    return (
      <div className="library-folder-tree-branch" key={`${mode}-${folder.id}`}>
        <div
          className={isHistoryMode
            ? 'library-folder-tree-row history-mode'
            : `library-folder-tree-row${isSelected ? ' active' : ''}${isDragging ? ' dragging' : ''}${dropPlacement ? ` drop-${dropPlacement}` : ''}`}
          style={{ '--folder-depth': depth }}
          onContextMenu={isHistoryMode ? undefined : (event) => openLibraryFolderContextMenu(event, folder)}
          draggable={!isHistoryMode}
          onDragStart={isHistoryMode ? undefined : (event) => beginLibraryFolderDrag(event, folder)}
          onDragOver={isHistoryMode ? undefined : (event) => updateLibraryFolderDragTarget(event, folder)}
          onDrop={isHistoryMode ? undefined : (event) => dropLibraryFolder(event, folder)}
          onDragEnd={isHistoryMode ? undefined : endLibraryFolderDrag}
        >
          {children.length ? (
            <TreeChevron
              expanded={isExpanded}
              onToggle={() => void toggleLibraryFolderExpanded(folder)}
            />
          ) : <span className="tree-chevron-spacer" />}
          {isHistoryMode ? (
            <button
              type="button"
              className={isSelected ? 'library-folder-button active' : 'library-folder-button'}
              onClick={() => setHistoryLibraryNodeId(folder.id)}
            >
              <span>{folder.name}</span>
              <small>{`${documentCount} · ${recordCount}`}</small>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={isSelected ? 'library-folder-main active' : 'library-folder-main'}
                onClick={() => setSelectedLibraryFolderId(folder.id)}
              >
                <span>{folder.name}</span>
              </button>
              <IconButton
                className="library-folder-create-child"
                onClick={(event) => createLibrarySubfolder(event, folder)}
                onDragStart={(event) => event.preventDefault()}
                label="新建子文件夹"
                title="新建子文件夹"
              >
                +
              </IconButton>
              <button
                type="button"
                className="library-folder-count"
                onClick={() => setSelectedLibraryFolderId(folder.id)}
                aria-label={`${folder.name}，${documentCount} 篇文献`}
              >
                {documentCount}
              </button>
            </>
          )}
        </div>
        {isExpanded ? children.map((child) => renderLibraryFolderTreeNode(child, depth + 1, mode)) : null}
      </div>
    )
  }

  function renderLibraryFolderMoveTarget(folder, depth = 0) {
    const movingFolder = libraryFolders.find((item) => item.id === libraryFolderMoveDialog?.folderId)
    if (!movingFolder) return null

    const invalidTargets = getLibraryDescendantFolderIds(movingFolder.id)
    const isDisabled = invalidTargets.has(folder.id) || folder.id === movingFolder.parentId
    const children = getLibraryFolderChildren(folder.id)
    const isExpanded = libraryFolderMoveExpandedIds.has(folder.id)
    const isSelected = libraryFolderMoveDialog?.hasTarget && libraryFolderMoveDialog.targetParentId === folder.id

    return (
      <div className="library-move-tree-branch" key={`folder-move-${folder.id}`}>
        <div className="library-folder-move-tree-row" style={{ '--folder-depth': depth }}>
          {children.length ? (
            <TreeChevron
              expanded={isExpanded}
              onToggle={() => toggleLibraryFolderMoveExpanded(folder.id)}
            />
          ) : <span className="tree-chevron-spacer" />}
          <button
            type="button"
            className={isSelected ? 'library-folder-move-node active' : 'library-folder-move-node'}
            disabled={isDisabled}
            onClick={() => selectLibraryFolderMoveTarget(folder.id)}
          >
            <span>{folder.name}</span>
          </button>
        </div>
        {isExpanded ? children.map((child) => renderLibraryFolderMoveTarget(child, depth + 1)) : null}
      </div>
    )
  }

  function renderLibraryFolderMoveRoot() {
    const movingFolder = libraryFolders.find((folder) => folder.id === libraryFolderMoveDialog?.folderId)
    const rootDisabled = !movingFolder || movingFolder.parentId === null
    const isSelected = libraryFolderMoveDialog?.hasTarget && libraryFolderMoveDialog.targetParentId === null

    return (
      <div className="library-move-tree-branch">
        <div className="library-folder-move-tree-row" style={{ '--folder-depth': 0 }}>
          <TreeChevron
            expanded={libraryFolderMoveRootExpanded}
            onToggle={() => setLibraryFolderMoveRootExpanded((expanded) => !expanded)}
          />
          <button
            type="button"
            className={isSelected ? 'library-folder-move-node active' : 'library-folder-move-node'}
            disabled={rootDisabled}
            onClick={() => selectLibraryFolderMoveTarget(null)}
          >
            <span>全部文献</span>
          </button>
        </div>
        {libraryFolderMoveRootExpanded ? (
          <>
            <div className="library-folder-move-tree-row system" style={{ '--folder-depth': 1 }}>
              <span className="tree-chevron-spacer" />
              <button type="button" className="library-folder-move-node" disabled>
                <span>未分类</span>
              </button>
            </div>
            {getLibraryFolderChildren(null).map((folder) => renderLibraryFolderMoveTarget(folder, 1))}
          </>
        ) : null}
      </div>
    )
  }

  function renderMoveFolderTree(folder, depth = 0) {
    const children = getLibraryFolderChildren(folder.id)
    const isExpanded = libraryMoveExpandedIds.has(folder.id)
    const isSelectedFolder = libraryMoveDialog?.hasTarget && folder.id === libraryMoveDialog.targetFolderId

    return (
      <div className="library-move-tree-branch" key={`move-${folder.id}`}>
        <div className="library-folder-move-tree-row" style={{ '--folder-depth': depth }}>
          {children.length ? (
            <TreeChevron
              expanded={isExpanded}
              onToggle={() => toggleLibraryMoveExpanded(folder.id)}
            />
          ) : <span className="tree-chevron-spacer" />}
          <button
            type="button"
            className={isSelectedFolder ? 'library-folder-move-node active' : 'library-folder-move-node'}
            onClick={() => selectLibraryMoveTarget(folder.id)}
          >
            <span>{folder.name}</span>
          </button>
        </div>
        {isExpanded ? children.map((child) => renderMoveFolderTree(child, depth + 1)) : null}
      </div>
    )
  }

  function renderLibraryDocumentMoveRoot() {
    const isUnfiledSelected = libraryMoveDialog?.hasTarget && !libraryMoveDialog.targetFolderId

    return (
      <div className="library-move-tree-branch">
        <div className="library-folder-move-tree-row system" style={{ '--folder-depth': 0 }}>
          <TreeChevron
            expanded={libraryMoveRootExpanded}
            onToggle={() => setLibraryMoveRootExpanded((expanded) => !expanded)}
          />
          <button type="button" className="library-folder-move-node" disabled>
            <span>全部文献</span>
          </button>
        </div>
        {libraryMoveRootExpanded ? (
          <>
            <div className="library-folder-move-tree-row" style={{ '--folder-depth': 1 }}>
              <span className="tree-chevron-spacer" />
              <button
                type="button"
                className={isUnfiledSelected ? 'library-folder-move-node active' : 'library-folder-move-node'}
                onClick={() => selectLibraryMoveTarget('')}
              >
                <span>未分类</span>
              </button>
            </div>
            {getLibraryFolderChildren(null).map((folder) => renderMoveFolderTree(folder, 1))}
          </>
        ) : null}
      </div>
    )
  }

  function renderLibraryPage() {
    const visibleDocuments = getVisibleLibraryDocuments()
    const unfiledCount = libraryDocuments.filter((document) => !document.folderId).length
    const contextFolder = libraryFolderContextMenu
      ? libraryFolders.find((folder) => folder.id === libraryFolderContextMenu.folderId)
      : null

    return (
      <section className="library-page">
        <aside className="library-folder-panel">
          <div className="library-folder-header">
            <strong>项目文件夹</strong>
            <IconButton onClick={() => openLibraryFolderDialog(null, null)} label="新建文件夹" title="新建文件夹">
              <FolderPlus size={16} />
            </IconButton>
          </div>
          <button
            type="button"
            className={selectedLibraryFolderId === 'all' ? 'library-folder-button active' : 'library-folder-button'}
            onClick={() => setSelectedLibraryFolderId('all')}
          >
            <span>全部文献</span>
            <small>{libraryDocuments.length}</small>
          </button>
          <div className="library-folder-tree">
            <div className={`library-folder-tree-row system-folder-row${selectedLibraryFolderId === 'unfiled' ? ' active' : ''}`} style={{ '--folder-depth': 0 }}>
              <span className="tree-chevron-spacer" />
              <button
                type="button"
                className={selectedLibraryFolderId === 'unfiled' ? 'library-folder-main active' : 'library-folder-main'}
                onClick={() => setSelectedLibraryFolderId('unfiled')}
              >
                <span>未分类</span>
              </button>
              <span className="library-folder-system-spacer" />
              <button
                type="button"
                className="library-folder-count"
                onClick={() => setSelectedLibraryFolderId('unfiled')}
                aria-label={`未分类：${unfiledCount} 篇文献`}
              >
                {unfiledCount}
              </button>
            </div>
            {getLibraryFolderChildren(null).map((folder) => renderLibraryFolderTreeNode(folder))}
          </div>
        </aside>

        {libraryFolderContextMenu && contextFolder ? (
          <div
            className="library-context-menu library-folder-context-menu"
            style={{ left: `${libraryFolderContextMenu.x}px`, top: `${libraryFolderContextMenu.y}px` }}
            role="menu"
            aria-label={`${contextFolder.name} 文件夹操作`}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setLibraryFolderContextMenu(null)
                openLibraryFolderDialog(contextFolder.parentId, contextFolder)
              }}
            >
              重命名
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                openLibraryFolderMoveDialog(contextFolder, libraryFolderContextMenu)
              }}
            >
              移动至
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setLibraryFolderContextMenu(null)
                void deleteLibraryFolder(contextFolder)
              }}
            >
              删除
            </button>
          </div>
        ) : null}

        {libraryFolderMoveDialog ? (
          <div
            className="library-move-popover library-folder-move-popover"
            style={{ left: `${libraryFolderMoveDialog.x}px`, top: `${libraryFolderMoveDialog.y}px` }}
            role="dialog"
            aria-label="移动文件夹"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="library-move-header">
              <strong>移动至</strong>
              <button type="button" onClick={() => setLibraryFolderMoveDialog(null)}>关闭</button>
            </div>
            <div className="library-move-folder-list">
              {renderLibraryFolderMoveRoot()}
            </div>
            <div className="library-move-actions">
              <button type="button" className="settings-secondary-button" onClick={() => setLibraryFolderMoveDialog(null)}>
                取消
              </button>
              <button
                type="button"
                className="settings-primary-button"
                disabled={!libraryFolderMoveDialog.hasTarget}
                onClick={confirmLibraryFolderMove}
              >
                移动
              </button>
            </div>
          </div>
        ) : null}

        <section className="library-main-panel">
          <div className="library-toolbar">
            <div className="library-search">
              <input
                type="search"
                aria-label="搜索文献"
                value={librarySearch}
                onFocus={() => {
                  if (librarySearchMode === 'global') openSearchDialog('library', librarySearch)
                }}
                onChange={handleLibrarySearchInputChange}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && librarySearchMode === 'global') {
                    openSearchDialog('library', librarySearch)
                  }
                }}
                placeholder={librarySearchMode === 'global' ? '全局搜索' : '按文件名搜索'}
              />
              <select
                className="library-search-mode"
                value={librarySearchMode}
                onChange={(event) => updateLibrarySearchMode(event.target.value)}
                aria-label="文献库搜索模式"
              >
                <option value="filename">文件名搜索</option>
                <option value="global">全局搜索</option>
              </select>
            </div>
            <label className="library-sort">
              <select
                value={librarySort}
                aria-label="排序"
                onChange={(event) => setLibrarySort(event.target.value)}
              >
                <option value="recent">最近阅读</option>
                <option value="progress">阅读进度</option>
                <option value="notes">笔记数量</option>
              </select>
            </label>
            <button type="button" className="settings-primary-button library-import-button" onClick={importLibraryDocuments}>
              导入文献
            </button>
          </div>

          <div className="library-batch-bar">
            <span>已选 {selectedLibraryDocumentIds.length} 篇</span>
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => openLibraryMoveDialog(selectedLibraryDocumentIds)}
              disabled={!selectedLibraryDocumentIds.length}
            >
              批量移动
            </button>
            <button
              type="button"
              className="settings-secondary-button"
              onClick={() => deleteLibraryDocuments()}
              disabled={!selectedLibraryDocumentIds.length}
            >
              批量删除
            </button>
          </div>

          {libraryStatus ? <p className="settings-status">{libraryStatus}</p> : null}

          <div className="library-document-list">
            {visibleDocuments.map((document) => (
              <article
                key={document.documentId}
                className="library-document-row"
                onContextMenu={(event) => openLibraryContextMenu(event, document)}
              >
                <input
                  type="checkbox"
                  checked={selectedLibraryDocumentIds.includes(document.documentId)}
                  onChange={() => toggleLibraryDocumentSelection(document.documentId)}
                  aria-label={`选择 ${document.fileName}`}
                />
                <button type="button" className="library-document-main" onClick={() => openLibraryDocument(document)}>
                  <strong>{document.displayName || document.fileName}</strong>
                  <div className="library-progress">
                    <i style={{ width: `${getLibraryProgressPercent(document)}%` }} />
                  </div>
                </button>
                <div className="library-document-meta">
                  <span>导入 {formatHistoryTime(document.importedAt)}</span>
                  <span>更新 {formatHistoryTime(document.updatedAt || document.lastOpenedAt || document.importedAt)}</span>
                  <span>阅读 {getLibraryProgress(document)}</span>
                </div>
              </article>
            ))}
          </div>

          {libraryContextMenu ? (
            <div
              className="library-context-menu"
              style={{ left: `${libraryContextMenu.x}px`, top: `${libraryContextMenu.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => openLibraryMoveDialog(
                  [libraryContextMenu.documentId],
                  libraryContextMenu.folderId,
                  { x: libraryContextMenu.x, y: libraryContextMenu.y },
                )}
              >
                移动到
              </button>
              <button
                type="button"
                onClick={() => void renameLibraryDocument(
                  libraryDocuments.find((document) => document.documentId === libraryContextMenu.documentId),
                )}
              >
                重命名
              </button>
              <button type="button" onClick={() => deleteLibraryDocuments([libraryContextMenu.documentId])}>
                删除文献
              </button>
            </div>
          ) : null}

          {libraryMoveDialog ? (
            <div
              className="library-move-popover"
              style={{ left: `${libraryMoveDialog.x}px`, top: `${libraryMoveDialog.y}px` }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="library-move-header">
                <strong>移动到</strong>
                <button type="button" onClick={() => setLibraryMoveDialog(null)}>
                  取消
                </button>
              </div>
              <div className="library-move-folder-list">
                {renderLibraryDocumentMoveRoot()}
              </div>
              <div className="library-move-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setLibraryMoveDialog(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="settings-primary-button"
                  disabled={!libraryMoveDialog.hasTarget}
                  onClick={confirmLibraryDocumentMove}
                >
                  确认
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {libraryFolderDialogOpen ? (
          <div className="note-dialog-overlay" role="presentation">
            <section
              className="note-dialog library-folder-dialog"
              aria-label={libraryFolderEditingId ? '重命名文件夹' : libraryFolderParentId ? '新建子文件夹' : '新建文件夹'}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="diagram-dialog-header">
                <h2>{libraryFolderEditingId ? '重命名文件夹' : libraryFolderParentId ? '新建子文件夹' : '新建文件夹'}</h2>
                <button type="button" onClick={closeLibraryFolderDialog}>
                  取消
                </button>
              </div>

              <label className="note-dialog-field">
                <span>文件夹名称</span>
                <input
                  ref={libraryFolderNameInputRef}
                  type="text"
                  value={libraryFolderNameDraft}
                  onChange={(event) => {
                    setLibraryFolderNameDraft(event.target.value)
                    setLibraryFolderNameError('')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void confirmCreateLibraryFolder()
                    }
                  }}
                />
              </label>

              {libraryFolderNameError ? <p className="settings-status error">{libraryFolderNameError}</p> : null}

              <div className="settings-actions">
                <button type="button" className="settings-secondary-button" onClick={closeLibraryFolderDialog}>
                  取消
                </button>
                <button type="button" className="settings-primary-button" onClick={confirmCreateLibraryFolder}>
                  确认
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {libraryDeleteDialog ? (
          <div className="note-dialog-overlay" role="presentation">
            <section className="note-dialog library-delete-dialog" aria-label="删除文献" onClick={(event) => event.stopPropagation()}>
              <div className="diagram-dialog-header">
                <h2>删除文献</h2>
              </div>
              <div className="settings-actions library-delete-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setLibraryDeleteDialog(null)}>取消</button>
                <button type="button" className="settings-secondary-button" onClick={() => void confirmDeleteLibraryDocuments('recycle')}>仅移出文献库</button>
                <button type="button" className="settings-primary-button" onClick={() => void confirmDeleteLibraryDocuments('permanent')}>删除文献及记录</button>
              </div>
            </section>
          </div>
        ) : null}

      </section>
    )
  }

  function renderRightPanelResult() {
    if (ocrResult?.mode === 'diagram' || ocrResult?.mode === 'compare') {
      return (
        <div className="ocr-status-panel">
          <p className={ocrResult.status === 'error' ? 'selected-text error' : 'selection-placeholder'}>
            {getOcrStatusText()}
          </p>
        </div>
      )
    }

    if (ocrResult) {
      return (
        <div className="ocr-result-panel">
          <section className="ocr-result-section">
            <h3>框选区域</h3>
            {ocrResult.image ? (
              <button
                type="button"
                className="result-image-button"
                onClick={() => openImagePreviewModal(ocrResult.image)}
              >
                <img className="ocr-capture-preview" src={ocrResult.image} alt="OCR 框选区域" />
                <span>点击查看大图</span>
              </button>
            ) : null}
          </section>

          <section className="ocr-result-section">
            <h3>OCR 识别文本</h3>
            {ocrResult.status === 'recognizing' ? (
              <p className="selection-placeholder">正在识别...</p>
            ) : (
              <p className={ocrResult.text ? 'selected-text' : 'selection-placeholder'}>
                {ocrResult.text || ocrResult.error || '未识别到文字'}
              </p>
            )}
          </section>

          <section className="ocr-result-section">
            <h3>翻译结果</h3>
            {ocrResult.status === 'translating' ? (
              <p className="selection-placeholder">正在翻译...</p>
            ) : ocrResult.status === 'error' ? (
              <p className="selected-text error">{ocrResult.error}</p>
            ) : null}
          </section>
        </div>
      )
    }

    if (translationStatus === 'loading' || translationStatus === 'error') {
      return (
        <p className={translationStatus === 'error' ? 'selected-text error' : 'selection-placeholder'}>
          {getPanelText()}
        </p>
      )
    }

    if (!rightPanelResult) {
      return <p className="selection-placeholder">{getPanelText()}</p>
    }

    if (rightPanelResult.type === 'text-selection') {
      return (
        <div className="ocr-result-panel">
          <section className="ocr-result-section">
            <h3>翻译结果</h3>
            <p className="selected-text">{rightPanelResult.translation}</p>
          </section>
          <button type="button" className="add-note-button" onClick={openResultNoteDialog}>
            添加到笔记
          </button>
        </div>
      )
    }

    if (rightPanelResult.type === 'ocr-text') {
      return (
        <div className="ocr-result-panel">
          <section className="ocr-result-section">
            <h3>文本模式结果</h3>
            <button
              type="button"
              className="result-image-button"
              onClick={() => openImagePreviewModal(rightPanelResult.screenshotDataUrl)}
            >
              <img className="ocr-capture-preview" src={rightPanelResult.screenshotDataUrl} alt="文本模式框选区域" />
              <span>点击查看大图</span>
            </button>
          </section>

          <section className="ocr-result-section">
            <h3>OCR 识别文本</h3>
            <textarea
              className="ocr-edit-textarea"
              value={editableOcrText}
              onChange={(event) => {
                setEditableOcrText(event.target.value)
                setOcrRetranslateError('')
                if (ocrRetranslateStatus !== 'loading') {
                  setOcrRetranslateStatus('idle')
                }
              }}
              onWheel={(event) => event.stopPropagation()}
              placeholder="请输入需要翻译的 OCR 文本"
            />
            <div className="ocr-retranslate-row">
              <button
                type="button"
                className="ocr-retranslate-button"
                onClick={retranslateOcrText}
                disabled={ocrRetranslateStatus === 'loading'}
              >
                {ocrRetranslateStatus === 'loading' ? '翻译中...' : '重新翻译'}
              </button>
              {ocrRetranslateError ? <span className="ocr-retranslate-error">{ocrRetranslateError}</span> : null}
              {ocrRetranslateStatus === 'success' ? <span className="ocr-retranslate-success">已更新翻译</span> : null}
            </div>
          </section>

          <section className="ocr-result-section">
            <h3>翻译结果</h3>
            <p className="selected-text">{rightPanelResult.translation}</p>
          </section>
          <button type="button" className="add-note-button" onClick={openResultNoteDialog}>
            添加到笔记
          </button>
        </div>
      )
    }

    if (rightPanelResult.type === 'ocr-diagram') {
      return (
        <div className="ocr-result-panel">
          <section className="ocr-result-section">
            <h3>图解模式结果</h3>
            <button type="button" className="result-image-button" onClick={() => openDiagramResultModal(rightPanelResult)}>
              <img className="ocr-capture-preview" src={rightPanelResult.diagramResultImage} alt="图解模式结果" />
              <span>点击查看大图</span>
            </button>
          </section>
          <button type="button" className="add-note-button" onClick={openResultNoteDialog}>
            添加到笔记
          </button>
        </div>
      )
    }

    if (rightPanelResult.type === 'ocr-compare') {
      return (
        <div className="ocr-result-panel">
          <section className="ocr-result-section">
            <h3>对照模式结果</h3>
            <button type="button" className="compare-preview-button" onClick={() => openCompareResultModal(rightPanelResult)}>
              <span className="compare-preview-grid">
                <img src={rightPanelResult.compareOriginalImage} alt="对照模式原图" />
                <img src={rightPanelResult.compareTranslatedImage} alt="对照模式译文覆盖图" />
              </span>
              <span>点击打开对照弹窗</span>
            </button>
          </section>
          <button type="button" className="add-note-button" onClick={openResultNoteDialog}>
            添加到笔记
          </button>
        </div>
      )
    }

    return <p className="selection-placeholder">{getPanelText()}</p>
  }

  function toggleSidebarCollapsed() {
    sidebarResizeSettlingRef.current = true

    if (sidebarResizeTimerRef.current) {
      clearTimeout(sidebarResizeTimerRef.current)
    }

    setSidebarCollapsed((isCollapsed) => !isCollapsed)

    sidebarResizeTimerRef.current = setTimeout(() => {
      sidebarResizeSettlingRef.current = false
      sidebarResizeTimerRef.current = null
      requestAnimationFrame(() => {
        syncPageWidthRef.current?.()
      })
    }, 190)
  }

  function toggleToolbarCollapsed() {
    setToolbarCollapsed((isCollapsed) => {
      const nextCollapsed = !isCollapsed

      if (nextCollapsed) {
        setIsRecentOpen(false)
        setIsAnnotationToolbarOpen(false)
        setIsOcrMenuOpen(false)
      }

      return nextCollapsed
    })
  }

  return (
    <main className={sidebarCollapsed ? 'app sidebar-collapsed' : 'app'} ref={appRef}>
      <aside className="module-sidebar" aria-label="主模块">
        <div className="sidebar-head">
          <div className="sidebar-brand">
            <img className="sidebar-brand-mark" src={APP_ICON_SRC} alt="" draggable="false" />
            <span className="sidebar-brand-copy">
              <strong>Paper Reader</strong>
              <small>RESEARCH DESK</small>
            </span>
          </div>
          <IconButton
            className="module-sidebar-toggle"
            onClick={toggleSidebarCollapsed}
            label={sidebarCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            title={sidebarCollapsed ? '展开左侧栏' : '折叠左侧栏'}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen size={17} strokeWidth={1.8} />
              : <PanelLeftClose size={17} strokeWidth={1.8} />}
          </IconButton>
        </div>
        <nav className="module-nav-list" aria-label="页面模块">
          {MODULE_NAV_ITEMS.map((item) => {
            const ItemIcon = item.icon

            return (
              <button
                key={item.id}
                type="button"
                className={activeModule === item.id ? 'module-nav-button active' : 'module-nav-button'}
                onClick={() => switchModule(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={activeModule === item.id ? 'page' : undefined}
              >
                <span className="module-nav-icon" aria-hidden="true">
                  <ItemIcon size={19} strokeWidth={1.75} />
                </span>
                <span className="module-nav-label">{item.label}</span>
              </button>
            )
          })}
        </nav>
        {!tocDrawerOpen ? (
          <IconButton
            className="toc-edge-button"
            onClick={toggleTocPanel}
            label="目录"
            title="目录"
          >
            <ListTree size={15} strokeWidth={1.8} />
          </IconButton>
        ) : null}
      </aside>

      {tocDrawerOpen ? (
        <aside className="toc-drawer-panel" aria-label="目录面板">
          <IconButton
            className="toc-edge-button toc-drawer-edge-button active"
            onClick={toggleTocPanel}
            label="收起目录"
            title="目录"
          >
            <ChevronLeft size={15} strokeWidth={1.8} />
          </IconButton>
          {renderTocPanel()}
        </aside>
      ) : null}

      <div className="app-content">
        <section
          className={[
            'module-page',
            'reader-module',
            activeModule === 'reader' ? 'active' : '',
            toolbarCollapsed ? 'toolbar-hidden' : '',
          ].filter(Boolean).join(' ')}
          aria-hidden={activeModule !== 'reader'}
        >
      {toolbarCollapsed ? (
        <IconButton
          className="toolbar-collapse-toggle collapsed"
          onClick={toggleToolbarCollapsed}
          label="展开工具栏"
          title="展开工具栏"
        >
          <ChevronDown size={14} strokeWidth={2} />
        </IconButton>
      ) : null}
      <header className={toolbarCollapsed ? 'toolbar toolbar-collapsed' : 'toolbar'}>
        <section className="toolbar-group toolbar-left" aria-label="文件">
          <button
            type="button"
            className="upload-button"
            onClick={handleOpenPdfClick}
            aria-label={UI.choosePdf}
            title={UI.choosePdf}
          >
            <FilePlus2 size={17} strokeWidth={1.9} aria-hidden="true" />
            <span>{UI.choosePdf}</span>
          </button>
          <input
            ref={fallbackFileInputRef}
            className="hidden-file-input"
            type="file"
            accept="application/pdf"
            onChange={handleFileChange}
          />
          <button
            ref={recentButtonRef}
            type="button"
            className={isRecentOpen ? 'secondary-toolbar-button active' : 'secondary-toolbar-button'}
            onClick={() => setIsRecentOpen((isOpen) => !isOpen)}
            aria-label="最近打开"
            title="最近打开"
          >
            <History size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>最近打开</span>
          </button>
          <div className="annotation-menu-wrap">
            <button
              ref={annotationButtonRef}
              type="button"
              className={isAnnotationToolbarOpen || annotationColor ? 'ocr-button annotation-toolbar-trigger active' : 'ocr-button annotation-toolbar-trigger'}
              onClick={() => setIsAnnotationToolbarOpen((isOpen) => !isOpen)}
              disabled={!pdfUrl}
              aria-label="批注"
              title="批注"
            >
              <Highlighter size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>批注</span>
            </button>
            {isAnnotationToolbarOpen ? (
              <div className="annotation-toolbar" ref={annotationToolbarRef}>
                <div className="annotation-colors" aria-label="高亮颜色">
                  <button
                    type="button"
                    className={annotationColor === null ? 'annotation-color annotation-empty-color active' : 'annotation-color annotation-empty-color'}
                    onClick={() => setAnnotationColor(null)}
                    aria-label="不标记"
                  >
                    <CircleOff size={15} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                  {HIGHLIGHT_COLORS.map((highlightColor) => (
                    <button
                      key={highlightColor.name}
                      type="button"
                      className={annotationColor && normalizeHighlightColor(annotationColor) === highlightColor.color ? 'annotation-color active' : 'annotation-color'}
                      style={{ backgroundColor: highlightColor.color }}
                      onClick={() => setAnnotationColor(highlightColor.color)}
                      aria-label={`选择高亮颜色 ${highlightColor.label}`}
                    />
                  ))}
                </div>
                <button type="button" onClick={() => setHideOcrNoteTags((isHidden) => !isHidden)}>
                  {hideOcrNoteTags ? '显示笔记标签' : '隐藏笔记标签'}
                </button>
                {annotationStatus ? <span>{annotationStatus}</span> : null}
              </div>
            ) : null}
          </div>
        </section>

        <div className="reader-document-identity" title={currentDocument?.fileName || '未打开文献'}>
          <strong>{currentDocument?.fileName || '未打开文献'}</strong>
          <span>{pdfUrl ? `${pageNumber} / ${numPages || '—'}` : 'PDF READER'}</span>
        </div>

        <section className="toolbar-group toolbar-actions view-controls" aria-label="工具与设置">
          <label className="toolbar-search-control">
            <Search size={16} strokeWidth={1.8} aria-hidden="true" />
            <input
              type="search"
              value={readerSearchInput}
              onFocus={() => openSearchDialog('reader', readerSearchInput)}
              onChange={handleReaderSearchInputChange}
              onKeyDown={handleReaderSearchKeyDown}
              disabled={!pdfUrl}
              aria-label="搜索当前 PDF"
              placeholder="搜索"
            />
          </label>
          <div className="ocr-menu-wrap">
            <button
              type="button"
              className={isOcrMode || isOcrMenuOpen ? 'ocr-button active' : 'ocr-button'}
              onClick={toggleOcrMode}
              disabled={!pdfUrl}
              aria-label="区域 OCR"
              title="区域 OCR"
            >
              <ScanLine size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>区域 OCR</span>
            </button>
            {isOcrMenuOpen ? (
              <div className="ocr-mode-menu">
                <button type="button" onClick={() => startOcrMode('sidebar')}>
                  文本模式
                </button>
                <button type="button" onClick={() => startOcrMode('diagram')}>
                  图解模式
                </button>
                <button type="button" onClick={() => startOcrMode('compare')}>
                  对照模式
                </button>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="fullscreen-button"
            onClick={toggleFullscreen}
            disabled={!pdfUrl}
            aria-label={isFullscreen ? UI.exitFullscreen : UI.fullscreen}
            title={isFullscreen ? UI.exitFullscreen : UI.fullscreen}
          >
            {isFullscreen
              ? <Minimize2 size={16} strokeWidth={1.8} aria-hidden="true" />
              : <Maximize2 size={16} strokeWidth={1.8} aria-hidden="true" />}
            <span>{isFullscreen ? UI.exitFullscreen : UI.fullscreen}</span>
          </button>
        </section>
        {!toolbarCollapsed ? (
          <IconButton
            className="toolbar-collapse-toggle expanded"
            onClick={toggleToolbarCollapsed}
            label="收起工具栏"
            title="收起工具栏"
          >
            <ChevronUp size={14} strokeWidth={2} />
          </IconButton>
        ) : null}
      </header>

      {renderPdfTabs()}

      {isRecentOpen ? (
        <div className="recent-popover" ref={recentPopoverRef}>
          {renderRecentList({ compact: true })}
        </div>
      ) : null}

      {pendingSessionRestore ? (
        <div className="note-dialog-overlay" role="presentation">
          <section className="note-dialog session-restore-dialog" aria-label="恢复上次文献">
            <div className="diagram-dialog-header">
              <h2>恢复上次文献</h2>
            </div>

            <div className="note-dialog-source">
              <strong>是否恢复上次打开的文献？</strong>
              <p>检测到你上次关闭软件时仍有打开的文献，是否恢复这些标签页？</p>
              <span>{pendingSessionRestore.tabs?.length || 0} 个标签可恢复</span>
            </div>

            <div className="settings-actions">
              <button type="button" className="settings-secondary-button" onClick={declineSessionRestore}>
                否，不恢复
              </button>
              <button type="button" className="settings-primary-button" onClick={confirmSessionRestore}>
                是，恢复
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {pdfUrl ? (
        <div className="reader-layout" ref={readerLayoutRef}>
          <section
            className={isOcrMode ? 'pdf-viewer ocr-mode' : 'pdf-viewer'}
            ref={pdfViewerRef}
            onMouseDown={handleSelectionStart}
            onMouseMove={handleSelectionMove}
            onMouseUp={handleTextSelection}
            onClickCapture={clearSearchHitMarkers}
          >
            <div className="selection-highlight-layer" aria-hidden="true">
              {!annotationColor ? highlightRects.map((rect, index) => (
                <div
                  className="selection-highlight"
                  key={`${index}-${rect.left}-${rect.top}`}
                  style={{
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                  }}
                />
              )) : null}
            </div>
            <div className="search-hit-selection-layer">
              {searchHitMarkers.map((marker) => (
                <button
                  type="button"
                  key={marker.id}
                  className="search-hit-selection-marker"
                  style={{
                    left: `${marker.left}px`,
                    top: `${marker.top}px`,
                    width: `${marker.width}px`,
                    height: `${marker.height}px`,
                  }}
                  onClick={clearSearchHitMarkers}
                  aria-label="清除搜索命中标记"
                />
              ))}
            </div>
            {renderAnnotationOverlay()}
            {ocrRect ? (
              <div
                className="ocr-selection-box"
                aria-hidden="true"
                style={{
                  left: `${ocrRect.left}px`,
                  top: `${ocrRect.top}px`,
                  width: `${ocrRect.width}px`,
                  height: `${ocrRect.height}px`,
                }}
              />
            ) : null}
            <div
              className="pdf-pages-container"
              style={{ '--pdf-page-width': `${pageWidth}px` }}
            >
              <div
                className="pdf-page-wrapper"
                style={{ width: `${pageWidth}px` }}
              >
                <Document
                  file={pdfUrl}
                  onLoadSuccess={handleDocumentLoadSuccess}
                  loading={<p className="status">{UI.loadingPdf}</p>}
                  error={<p className="status error">{UI.pageError}</p>}
                >
                  <Page
                    pageNumber={pageNumber}
                    width={pageWidth}
                    onLoadSuccess={handlePageLoadSuccess}
                    renderAnnotationLayer={false}
                    renderTextLayer
                  />
                </Document>
              </div>
            </div>
          </section>

          <IconButton
            className={rightPanelVisible ? 'panel-toggle-button visible' : 'panel-toggle-button collapsed'}
            onClick={() => setRightPanelVisible((isVisible) => !isVisible)}
            label={rightPanelVisible ? '隐藏结果栏' : '显示结果栏'}
            title={rightPanelVisible ? '隐藏结果栏' : '显示结果栏'}
          >
            {rightPanelVisible
              ? <ChevronRight size={15} strokeWidth={2} />
              : <ChevronLeft size={15} strokeWidth={2} />}
          </IconButton>

          {rightPanelVisible ? (
            <div
              className={isResizingPanel ? 'resize-handle active' : 'resize-handle'}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize translation panel"
              onMouseDown={startPanelResize}
            />
          ) : null}

          {rightPanelVisible ? (
            <aside
              className="selection-panel"
              style={{
                width: `${rightPanelWidth}px`,
                flexBasis: `${rightPanelWidth}px`,
            }}
          >
            <div className="selection-panel-header">
              <div className="right-panel-tabs" role="tablist" aria-label="右侧栏模块">
                <button
                  type="button"
                  className={rightPanelTab === 'result' ? 'right-panel-tab active' : 'right-panel-tab'}
                  onClick={() => setRightPanelTab('result')}
                >
                  翻译结果
                </button>
                <button
                  type="button"
                  className={rightPanelTab === 'history' ? 'right-panel-tab active' : 'right-panel-tab'}
                  onClick={() => setRightPanelTab('history')}
                >
                  翻译历史
                </button>
                <button
                  type="button"
                  className={rightPanelTab === 'notes' ? 'right-panel-tab active' : 'right-panel-tab'}
                  onClick={() => setRightPanelTab('notes')}
                >
                  笔记
                </button>
                <button
                  type="button"
                  className={rightPanelTab === 'bookmarks' ? 'right-panel-tab active' : 'right-panel-tab'}
                  onClick={() => setRightPanelTab('bookmarks')}
                >
                  书签
                </button>
              </div>
            </div>

            {rightPanelTab === 'result' ? (
              <div className="selection-panel-actions">
              <button
                type="button"
                className="copy-button"
                onClick={copyTranslation}
                disabled={!canCopyTranslation()}
              >
                复制
              </button>
              <button
                type="button"
                className="copy-button"
                onClick={clearRightPanelResult}
                disabled={!hasRightPanelContent()}
              >
                清空
              </button>
              {copyStatus ? <span className="copy-status">{copyStatus}</span> : null}
              </div>
            ) : null}

            <div
              className="selection-panel-body"
              onWheel={(event) => event.stopPropagation()}
              onWheelCapture={(event) => event.stopPropagation()}
            >
              {rightPanelTab === 'result' ? renderRightPanelResult() : null}
              {rightPanelTab === 'history' ? renderHistoryPanel() : null}
              {rightPanelTab === 'notes' ? renderNotesPanel() : null}
              {rightPanelTab === 'bookmarks' ? renderBookmarksPanel() : null}
            </div>
            </aside>
          ) : null}
        </div>
      ) : (
        <section className="empty-state">
          <p>{UI.emptyPdf}</p>
        </section>
      )}
      <footer className="reader-statusbar" aria-label="阅读控制">
        <section className="statusbar-group page-controls" aria-label={UI.pageControl}>
          <IconButton
            className="statusbar-icon-button"
            onClick={goToPreviousPage}
            disabled={!pdfUrl || pageNumber <= 1}
            label={UI.previousPage}
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </IconButton>
          <span className="page-readout">
            {pdfUrl ? pageNumber : 0} / {numPages || 0}
          </span>
          <label className="page-jump-control">
            <input
              type="text"
              inputMode="numeric"
              value={isPageJumpFocused ? pageJumpInput : String(pageNumber)}
              onChange={(event) => setPageJumpInput(event.target.value)}
              onFocus={() => {
                setIsPageJumpFocused(true)
                setPageJumpInput(String(pageNumber))
                requestAnimationFrame(() => document.activeElement?.select?.())
              }}
              onKeyDown={handlePageJumpKeyDown}
              onBlur={(event) => {
                jumpToPage(event.currentTarget.value)
                setIsPageJumpFocused(false)
              }}
              disabled={!pdfUrl || !numPages}
              aria-label="跳转页码"
            />
          </label>
          <button type="button" className="statusbar-text-button" onClick={jumpToPage} disabled={!pdfUrl || !numPages}>
            跳转
          </button>
          <IconButton
            className="statusbar-icon-button"
            onClick={goToNextPage}
            disabled={!pdfUrl || !numPages || pageNumber >= numPages}
            label={UI.nextPage}
          >
            <ChevronRight size={16} strokeWidth={2} />
          </IconButton>
        </section>

        <div className="reader-status-summary" aria-live="polite">
          <span className={pdfUrl ? 'reader-status-dot ready' : 'reader-status-dot'} aria-hidden="true" />
          <span>{pdfUrl ? '文献已加载' : '等待文献'}</span>
        </div>

        <section className="statusbar-group zoom-controls" aria-label="PDF 缩放">
          <IconButton
            className="statusbar-icon-button"
            onClick={() => changeZoom(-ZOOM_STEP)}
            disabled={!pdfUrl}
            label="缩小"
          >
            <Minus size={16} strokeWidth={2} />
          </IconButton>
          <label className="zoom-input-control">
            <input
              type="text"
              inputMode="numeric"
              value={zoomInput}
              onChange={(event) => setZoomInput(event.target.value)}
              onKeyDown={handleZoomInputKeyDown}
              onBlur={() => applyZoom(zoomInput)}
              disabled={!pdfUrl}
              aria-label="缩放比例"
            />
            <span>%</span>
          </label>
          <IconButton
            className="statusbar-icon-button"
            onClick={() => changeZoom(ZOOM_STEP)}
            disabled={!pdfUrl}
            label="放大"
          >
            <Plus size={16} strokeWidth={2} />
          </IconButton>
        </section>
      </footer>
        </section>

        <section
          className={activeModule === 'importExport' ? 'module-page settings-module-page active' : 'module-page settings-module-page'}
          aria-hidden={activeModule !== 'importExport'}
        >
          <div className="module-settings-content">
            {renderImportExportSettings()}
          </div>
        </section>

        <section
          className={activeModule === 'library' ? 'module-page library-module-page active' : 'module-page library-module-page'}
          aria-hidden={activeModule !== 'library'}
        >
          {renderLibraryPage()}
        </section>

        <section
          className={activeModule === 'settings' ? 'module-page settings-module-page active' : 'module-page settings-module-page'}
          aria-hidden={activeModule !== 'settings'}
        >
          <form className="settings-dialog module-settings-panel" onSubmit={saveSettings}>
            <div className="settings-dialog-body">
              <nav className="settings-tabs" aria-label="设置分类">
                <button
                  type="button"
                  className={settingsTab === 'model' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => setSettingsTab('model')}
                >
                  模型设置
                </button>
                <button
                  type="button"
                  className={settingsTab === 'prompt' ? 'settings-tab active' : 'settings-tab'}
                  onClick={() => setSettingsTab('prompt')}
                >
                  翻译设置
                </button>
              </nav>

              <div className="settings-content">
                {settingsTab === 'model' ? (
                  <section className="settings-page import-export-page">
                    <section className="settings-glossary">
                      <div className="settings-section-header">
                        <h3>API 配置</h3>
                        <span>{settingsForm.apiKey ? UI.settingsKeyConfigured : UI.settingsKeyEmpty}</span>
                      </div>
                      <label className="settings-field">
                        <span>Provider</span>
                        <select
                          value={settingsForm.provider}
                          onChange={(event) => updateSettingsProvider(event.target.value)}
                        >
                          {Object.entries(PROVIDERS).map(([provider, providerConfig]) => (
                            <option key={provider} value={provider}>
                              {providerConfig.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="settings-field">
                        <span>Base URL</span>
                        <input
                          type="text"
                          value={settingsForm.baseUrl}
                          onChange={(event) => updateSettingsField('baseUrl', event.target.value)}
                          placeholder={PROVIDERS[settingsForm.provider].baseUrl}
                        />
                      </label>
                      <label className="settings-field">
                        <span>API Key</span>
                        <input
                          type="password"
                          value={settingsForm.apiKey}
                          onChange={(event) => updateSettingsField('apiKey', event.target.value)}
                          autoComplete="off"
                        />
                      </label>
                    </section>

                    <section className="settings-glossary">
                      <div className="settings-section-header">
                        <h3>模型参数</h3>
                        <span>
                          {modelListStatus === 'loading'
                            ? '正在获取模型'
                            : modelListStatus === 'success'
                              ? `已获取 ${availableModels.length} 个模型`
                              : modelListStatus === 'error'
                                ? '模型列表获取失败'
                                : ''}
                        </span>
                      </div>
                      <div className="settings-field">
                        <label htmlFor="settings-model-input">模型名</label>
                        <SettingsModelCombobox
                          value={settingsForm.model}
                          models={availableModels}
                          status={modelListStatus}
                          error={modelListError}
                          placeholder={
                            modelListStatus === 'loading'
                              ? '正在获取可用模型…'
                              : '选择或输入模型名称'
                          }
                          onChange={updateSettingsModel}
                        />
                      </div>
                      <details className="settings-advanced-parameters">
                        <summary>高级参数</summary>
                        <div className="settings-advanced-parameters-body">
                          <label className="settings-field">
                            <span>Temperature</span>
                            <select
                              value={settingsForm.temperatureMode}
                              onChange={(event) => updateSettingsField('temperatureMode', event.target.value)}
                            >
                              <option value="auto">自动</option>
                              <option value="custom">自定义</option>
                            </select>
                          </label>
                          {settingsForm.temperatureMode === 'custom' ? (
                            <label className="settings-field">
                              <span>Temperature 数值</span>
                              <input
                                type="number"
                                min="0"
                                max="2"
                                step="0.1"
                                value={settingsForm.temperature}
                                onChange={(event) => updateSettingsField('temperature', event.target.value)}
                              />
                            </label>
                          ) : null}
                        </div>
                      </details>
                      <label className="settings-switch-row">
                        <span>
                          <strong>启用多模态翻译</strong>
                        </span>
                        <input
                          type="checkbox"
                          checked={settingsSupportMultimodal(settingsForm)}
                          disabled={!settingsCanEnableMultimodal(settingsForm)}
                          title={
                            settingsForm.modelSupportsMultimodal === false
                              ? '模型列表未声明图片输入能力，仍可手动启用并由接口实际验证'
                              : '启用多模态图片识别'
                          }
                          onChange={(event) => updateSettingsField('enableMultimodalTranslation', event.target.checked)}
                        />
                      </label>
                    </section>
                  </section>
                ) : (
                  <section className="settings-page import-export-page">
                    <section className="settings-glossary">
                      <div className="settings-section-header">
                        <h3>Prompt 设置</h3>
                      </div>
                      <label className="settings-field">
                        <span>自定义翻译 Prompt</span>
                        <textarea
                          value={settingsForm.prompt}
                          onChange={(event) => updateSettingsField('prompt', event.target.value)}
                          rows={7}
                        />
                      </label>
                      <div className="settings-inline-actions">
                        <button type="button" className="settings-secondary-button" onClick={resetPrompt}>
                          恢复默认 Prompt
                        </button>
                      </div>
                    </section>

                    <section className="settings-glossary">
                      <div className="settings-section-header">
                        <h3>术语库</h3>
                        <span>{glossaryStatus}</span>
                      </div>

                      <div className="settings-inline-actions">
                        <button type="button" className="settings-secondary-button" onClick={importGlossary}>
                          导入术语库
                        </button>
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={() => setIsGlossaryVisible((isVisible) => !isVisible)}
                          disabled={!glossary.length}
                        >
                          {isGlossaryVisible ? '隐藏术语库' : '查看术语库'}
                        </button>
                        <button
                          type="button"
                          className="settings-secondary-button"
                          onClick={clearGlossary}
                          disabled={!glossary.length}
                        >
                          清空术语库
                        </button>
                      </div>

                      {isGlossaryVisible && glossary.length ? (
                        <div className="glossary-preview">
                          {glossary.slice(0, 20).map((entry) => (
                            <div className="glossary-entry" key={`${entry.source}-${entry.target}`}>
                              <span>{entry.source}</span>
                              <span>{entry.target}</span>
                            </div>
                          ))}
                          {glossary.length > 20 ? (
                            <p className="glossary-more">仅显示前 20 条，共 {glossary.length} 条。</p>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  </section>
                )}
              </div>
            </div>

            {settingsStatus ? <p className="settings-status">{settingsStatus}</p> : null}

            <div className="settings-actions">
              <button type="submit" className="settings-primary-button" disabled={isSavingSettings}>
                {UI.settingsSave}
              </button>
            </div>
          </form>
        </section>

      {renderSearchDialog()}

      {highlightContextMenu ? (
        <div
          className="annotation-context-menu"
          style={{
            left: `${highlightContextMenu.x}px`,
            top: `${highlightContextMenu.y}px`,
          }}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => deleteHighlightAnnotation(highlightContextMenu.highlightId)}>
            取消
          </button>
          <button type="button" onClick={translateHighlightFromContextMenu}>
            翻译
          </button>
        </div>
      ) : null}

      {pdfHighlightWritePromptOpen ? (
        <div className="note-dialog-overlay" role="presentation">
          <section
            className="note-dialog pdf-highlight-write-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pdf-highlight-write-dialog-title"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              resolvePdfHighlightWritePrompt('internal')
            }}
          >
            <div className="diagram-dialog-header">
              <h2 id="pdf-highlight-write-dialog-title">高亮写入方式</h2>
            </div>

            <div className="note-dialog-source">
              <strong>是否将后续高亮写入 PDF 文件本体？</strong>
              <p>写入后用其他 PDF 软件打开也能看到。</p>
            </div>

            <div className="settings-actions">
              <button
                type="button"
                className="settings-secondary-button"
                autoFocus
                onClick={() => resolvePdfHighlightWritePrompt('internal')}
              >
                仅在 Paper Reader 内显示
              </button>
              <button
                type="button"
                className="settings-primary-button"
                onClick={() => resolvePdfHighlightWritePrompt('write')}
              >
                写入 PDF 并创建备份
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {bookmarkDialogOpen ? (
        <div className="note-dialog-overlay" role="presentation">
          <section className="note-dialog bookmark-dialog" aria-label="添加书签">
            <div className="diagram-dialog-header">
              <h2>添加书签</h2>
              <button type="button" onClick={closeBookmarkDialog}>
                取消
              </button>
            </div>

            <label className="note-dialog-field">
              <span>本页主题</span>
              <input
                ref={bookmarkTitleInputRef}
                type="text"
                value={bookmarkTitleDraft}
                onChange={(event) => setBookmarkTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void confirmAddBookmark()
                  }
                }}
              />
            </label>

            <div className="note-dialog-source">
              <strong>第 {pageNumber} 页</strong>
            </div>

            <div className="settings-actions">
              <button type="button" className="settings-secondary-button" onClick={closeBookmarkDialog}>
                取消
              </button>
              <button type="button" className="settings-primary-button" onClick={confirmAddBookmark}>
                确认
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {noteDialog ? (
        <div className="note-dialog-overlay" role="presentation">
          <section
            key={noteDialog.dialogId}
            className="note-dialog"
            ref={noteDialogRef}
            aria-label={noteDialog.mode === 'edit' ? '编辑笔记' : '添加笔记'}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          >
            <div className="diagram-dialog-header">
              <h2>{noteDialog.mode === 'edit' ? '编辑笔记' : noteDialog.note.type === 'page-note' ? `为第 ${noteDialog.note.pageNumber} 页添加笔记` : '添加到笔记'}</h2>
              <button type="button" onClick={closeNoteDialog}>
                取消
              </button>
            </div>

            <label className="note-dialog-field">
              <span>标题</span>
              <input
                ref={noteTitleInputRef}
                type="text"
                autoFocus
                defaultValue={noteDialog.draft?.title ?? noteDraft.title}
                onFocus={() => setNotesStatus('')}
                placeholder="输入笔记标题"
              />
            </label>

            <label className="note-dialog-field">
              <span>笔记内容</span>
              <textarea
                ref={noteTextareaRef}
                defaultValue={noteDialog.draft?.noteText ?? noteDraft.noteText}
                onFocus={() => setNotesStatus('')}
                rows={6}
                placeholder="输入笔记内容"
                onWheel={(event) => event.stopPropagation()}
              />
            </label>

            <div className="note-dialog-source">
              <strong>{NOTE_TYPE_LABELS[noteDialog.note.type]}</strong>
              <span>第 {noteDialog.note.pageNumber} 页</span>
              {noteDialog.note.selectedText ? <p>{noteDialog.note.selectedText}</p> : null}
              {noteDialog.note.ocrText ? <p>{noteDialog.note.ocrText}</p> : null}
              {noteDialog.note.translation ? <p>{noteDialog.note.translation}</p> : null}
            </div>

            <div className="settings-actions">
              <button type="button" className="settings-secondary-button" onClick={closeNoteDialog}>
                取消
              </button>
              <button type="button" className="settings-primary-button" onClick={saveNoteDialog}>
                保存
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <div className="diagram-overlay image-preview-overlay" role="presentation">
          <section
            className={isImagePreviewFullscreen ? 'diagram-dialog fullscreen' : 'diagram-dialog'}
            aria-label={imagePreview.title}
          >
            <div className="diagram-dialog-header">
              <h2>{imagePreview.title}</h2>
              <div className="diagram-dialog-actions">
                <button type="button" onClick={() => setImagePreviewZoom(1)}>
                  重置缩放
                </button>
                <button type="button" onClick={toggleImagePreviewFullscreen}>
                  {isImagePreviewFullscreen ? '退出全屏' : '全屏'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setImagePreview(null)
                    setIsImagePreviewFullscreen(false)
                  }}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="diagram-image-stage" onWheel={handleImagePreviewWheel}>
              <img
                src={imagePreview.image}
                alt={imagePreview.title}
                style={{
                  width: `${imagePreviewZoom * 100}%`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
              />
            </div>
          </section>
        </div>
      ) : null}

      {diagramResult ? (
        <div className="diagram-overlay" role="presentation">
          <section
            className={isDiagramModalFullscreen ? 'diagram-dialog fullscreen' : 'diagram-dialog'}
            aria-label="OCR 图解模式结果"
          >
            <div className="diagram-dialog-header">
              <h2>OCR 图解模式结果</h2>
              <div className="diagram-dialog-actions">
                <button type="button" onClick={() => setDiagramZoom(1)}>
                  重置缩放
                </button>
                <button type="button" onClick={toggleDiagramModalFullscreen}>
                  {isDiagramModalFullscreen ? '退出全屏' : '全屏'}
                </button>
                <button type="button" onClick={closeDiagramModal}>
                  关闭
                </button>
              </div>
            </div>
            <div className="diagram-image-stage" onWheel={handleDiagramWheel}>
              <img
                src={diagramResult.image}
                alt="OCR 图解模式结果"
                style={{
                  width: `${diagramZoom * 100}%`,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }}
              />
            </div>
          </section>
        </div>
      ) : null}

      {compareResult ? (
        <div className="diagram-overlay" role="presentation">
          <section
            className={isCompareModalFullscreen ? 'compare-dialog fullscreen' : 'compare-dialog'}
            aria-label="OCR 对照模式结果"
          >
            <div className="diagram-dialog-header">
              <h2>OCR 对照模式结果</h2>
              <div className="diagram-dialog-actions">
                <button
                  type="button"
                  onClick={() => {
                    setCompareOriginalZoom(1)
                    setCompareTranslatedZoom(1)
                  }}
                >
                  重置缩放
                </button>
                <button type="button" onClick={toggleCompareModalFullscreen}>
                  {isCompareModalFullscreen ? '退出全屏' : '全屏'}
                </button>
                <button type="button" onClick={closeCompareModal}>
                  关闭
                </button>
              </div>
            </div>
            <div className={`compare-stage ${compareResult.layout === 'vertical' ? 'vertical' : 'horizontal'}`}>
              <section className="compare-pane">
                <div className="compare-pane-header">
                  <h3>原图</h3>
                  <div className="compare-pane-actions">
                    <button type="button" onClick={() => adjustCompareZoom('original', -0.12)} aria-label="缩小原图">
                      -
                    </button>
                    <button type="button" onClick={() => adjustCompareZoom('original', 0.12)} aria-label="放大原图">
                      +
                    </button>
                    <button type="button" onClick={() => resetCompareZoom('original')}>
                      重置
                    </button>
                    <button type="button" onClick={() => openCompareImagePreview('original')}>
                      全屏
                    </button>
                  </div>
                </div>
                <div className="compare-image-stage" onWheel={(event) => handleCompareWheel(event, 'original')}>
                  <img
                    src={compareResult.originalImage}
                    alt="OCR 对照模式原图"
                    style={{
                      width: `${compareOriginalZoom * 100}%`,
                      maxWidth: 'none',
                      maxHeight: 'none',
                    }}
                  />
                </div>
              </section>
              <section className="compare-pane">
                <div className="compare-pane-header">
                  <h3>译文覆盖图</h3>
                  <div className="compare-pane-actions">
                    <button type="button" onClick={() => adjustCompareZoom('translated', -0.12)} aria-label="缩小译文图">
                      -
                    </button>
                    <button type="button" onClick={() => adjustCompareZoom('translated', 0.12)} aria-label="放大译文图">
                      +
                    </button>
                    <button type="button" onClick={() => resetCompareZoom('translated')}>
                      重置
                    </button>
                    <button type="button" onClick={() => openCompareImagePreview('translated')}>
                      全屏
                    </button>
                  </div>
                </div>
                <div className="compare-image-stage" onWheel={(event) => handleCompareWheel(event, 'translated')}>
                  <img
                    src={compareResult.translatedImage}
                    alt="OCR 对照模式译文覆盖图"
                    style={{
                      width: `${compareTranslatedZoom * 100}%`,
                      maxWidth: 'none',
                      maxHeight: 'none',
                    }}
                  />
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
      </div>
    </main>
  )
}

export default App
