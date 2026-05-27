export const HISTORY_LIMIT = 50
export const BROWSING_HISTORY_LIMIT = 30

export const HISTORY_TYPE_LABELS = {
  'text-selection': '划词翻译',
  'ocr-text': '文本 OCR',
  'ocr-diagram': '图解 OCR',
  'ocr-compare': '对照 OCR',
}

const HISTORY_TYPES = new Set(Object.keys(HISTORY_TYPE_LABELS))

function toOptionalString(value) {
  return typeof value === 'string' && value ? value : undefined
}

export function normalizeHistoryItem(result, pageNumber = null) {
  if (!result || !HISTORY_TYPES.has(result.type)) return null

  const createdAt = Number(result.createdAt || result.timestamp || Date.now())
  const normalized = {
    id: result.id || `${createdAt}-${Math.random().toString(36).slice(2, 9)}`,
    documentId: typeof result.documentId === 'string' ? result.documentId : undefined,
    filePath: typeof result.filePath === 'string' ? result.filePath : undefined,
    fileName: typeof result.fileName === 'string' ? result.fileName : undefined,
    type: result.type,
    title: result.title || HISTORY_TYPE_LABELS[result.type],
    pageNumber: Number.isFinite(Number(result.pageNumber))
      ? Number(result.pageNumber)
      : Number.isFinite(Number(pageNumber))
        ? Number(pageNumber)
        : null,
    createdAt,
  }

  if (result.type === 'text-selection') {
    normalized.selectedText = toOptionalString(result.selectedText)
    normalized.translation = toOptionalString(result.translation)
  }

  if (result.type === 'ocr-text') {
    normalized.ocrText = toOptionalString(result.ocrText)
    normalized.translation = toOptionalString(result.translation)
    normalized.screenshotDataUrl = toOptionalString(result.screenshotDataUrl)
  }

  if (result.type === 'ocr-diagram') {
    normalized.screenshotDataUrl = toOptionalString(result.screenshotDataUrl)
    normalized.diagramResultImage = toOptionalString(result.diagramResultImage)
  }

  if (result.type === 'ocr-compare') {
    normalized.compareOriginalImage = toOptionalString(result.compareOriginalImage)
    normalized.compareTranslatedImage = toOptionalString(result.compareTranslatedImage)
    normalized.compareLayout = result.compareLayout === 'vertical' ? 'vertical' : 'horizontal'
  }

  return isSuccessfulHistoryItem(normalized) ? normalized : null
}

export function normalizeHistoryList(history) {
  if (!Array.isArray(history)) return []

  return history
    .map((item) => normalizeHistoryItem(item, item?.pageNumber))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HISTORY_LIMIT)
}

export function restoreHistoryItem(item) {
  const normalized = normalizeHistoryItem(item, item?.pageNumber)

  if (!normalized) return null

  return {
    id: normalized.id,
    documentId: normalized.documentId,
    filePath: normalized.filePath,
    fileName: normalized.fileName,
    type: normalized.type,
    title: normalized.title,
    selectedText: normalized.selectedText,
    translation: normalized.translation,
    ocrText: normalized.ocrText,
    screenshotDataUrl: normalized.screenshotDataUrl,
    diagramResultImage: normalized.diagramResultImage,
    compareOriginalImage: normalized.compareOriginalImage,
    compareTranslatedImage: normalized.compareTranslatedImage,
    compareLayout: normalized.compareLayout,
    timestamp: normalized.createdAt,
  }
}

export function createDocumentId(filePath = '', fileName = '', fileSize = 0) {
  const source = `${filePath}|${fileName}|${Number(fileSize) || 0}`
  let hash = 0

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0
  }

  return `doc-${hash.toString(36)}-${Math.abs(source.length).toString(36)}`
}

export function normalizeBrowsingRecord(record = {}) {
  const filePath = typeof record.filePath === 'string' ? record.filePath : ''
  const fileName = typeof record.fileName === 'string' ? record.fileName : filePath.split(/[\\/]/).pop() || ''
  const fileSize = Math.max(0, Number(record.fileSize) || 0)

  if (!filePath || !fileName) return null

  const now = Date.now()
  const documentId = record.documentId || createDocumentId(filePath, fileName, fileSize)
  const totalPages = Number(record.totalPages)
  const lastPage = Math.max(1, Number(record.lastPage) || 1)

  return {
    id: record.id || documentId,
    documentId,
    filePath,
    fileName,
    fileSize,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
    lastPage,
    scale: Math.min(300, Math.max(50, Number(record.scale) || 100)),
    rightPanelWidth: Math.min(700, Math.max(280, Number(record.rightPanelWidth) || 420)),
    rightPanelVisible: record.rightPanelVisible !== false,
    lastOpenedAt: Number(record.lastOpenedAt) || now,
    createdAt: Number(record.createdAt) || now,
  }
}

export function normalizeBrowsingHistory(records) {
  if (!Array.isArray(records)) return []

  const seen = new Set()

  return records
    .map(normalizeBrowsingRecord)
    .filter(Boolean)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .filter((record) => {
      const key = record.filePath.toLowerCase()

      if (seen.has(key)) return false

      seen.add(key)
      return true
    })
    .slice(0, BROWSING_HISTORY_LIMIT)
}

export function getHistoryPreview(item) {
  if (item.type === 'text-selection') {
    return item.selectedText || item.translation || '划词翻译结果'
  }

  if (item.type === 'ocr-text') {
    return item.ocrText || item.translation || '文本 OCR 结果'
  }

  if (item.type === 'ocr-diagram') {
    return '图解结果图片'
  }

  if (item.type === 'ocr-compare') {
    return '对照结果图片'
  }

  return item.title || '历史记录'
}

export function formatHistoryTime(createdAt) {
  const date = new Date(createdAt)

  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (isToday) return time

  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${time}`
}

function isSuccessfulHistoryItem(item) {
  if (item.type === 'text-selection') {
    return Boolean(item.translation)
  }

  if (item.type === 'ocr-text') {
    return Boolean(item.translation && item.screenshotDataUrl)
  }

  if (item.type === 'ocr-diagram') {
    return Boolean(item.diagramResultImage)
  }

  if (item.type === 'ocr-compare') {
    return Boolean(item.compareOriginalImage && item.compareTranslatedImage)
  }

  return false
}
