/* global process */

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'

let backendServer = null
let mainWindow = null

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  prompt: '',
  rightPanelWidth: 420,
  exportDefaultDir: '',
}
const HISTORY_LIMIT = 50
const BROWSING_HISTORY_LIMIT = 30
const HISTORY_TYPES = new Set(['text-selection', 'ocr-text', 'ocr-diagram', 'ocr-compare'])
const NOTE_TYPES = new Set(['page-note', 'text-selection-note', 'ocr-text-note', 'ocr-diagram-note', 'ocr-compare-note', 'annotation-note'])
const ANNOTATION_TYPES = new Set(['text-highlight', 'ocr-note-tag'])
const EXPORT_SCHEMA_VERSION = 1
const EXPORT_APP_NAME = 'Paper Reader'
const EXPORT_EXTENSION = '.paperreader.json'
const PROVIDER_DEFAULTS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
}

function getEnvPath() {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), '.env')
  }

  return path.join(app.getAppPath(), '.env')
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function getGlossaryPath() {
  return path.join(app.getPath('userData'), 'glossary.json')
}

function getHistoryPath() {
  return path.join(app.getPath('userData'), 'paper-reader-history.json')
}

function getBrowsingHistoryPath() {
  return path.join(app.getPath('userData'), 'paper-reader-browsing-history.json')
}

function getDocumentTranslationHistoryPath() {
  return path.join(app.getPath('userData'), 'paper-reader-document-translation-history.json')
}

function getNotesPath() {
  return path.join(app.getPath('userData'), 'paper-reader-notes.json')
}

function getAnnotationsPath() {
  return path.join(app.getPath('userData'), 'paper-reader-annotations.json')
}

function getAppIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'build', 'icon.ico')
  }

  return path.join(app.getAppPath(), 'build', 'icon.ico')
}

function createDocumentId(filePath, fileName = '', fileSize = 0) {
  return crypto
    .createHash('sha256')
    .update(`${filePath || ''}|${fileName || ''}|${Number(fileSize) || 0}`)
    .digest('hex')
    .slice(0, 24)
}

function normalizeConfig(config = {}) {
  const provider = ['deepseek', 'openrouter', 'custom'].includes(config.provider)
    ? config.provider
    : 'deepseek'
  const providerDefaults = PROVIDER_DEFAULTS[provider]

  return {
    provider,
    apiKey: String(config.apiKey || config.deepseekApiKey || '').trim(),
    baseUrl: String(config.baseUrl || config.deepseekBaseUrl || providerDefaults.baseUrl).trim(),
    model: String(config.model || config.deepseekModel || providerDefaults.model).trim(),
    prompt: String(config.prompt || '').trim(),
    rightPanelWidth: Math.min(700, Math.max(280, Number(config.rightPanelWidth) || 420)),
    exportDefaultDir: String(config.exportDefaultDir || '').trim(),
  }
}

function normalizeGlossaryEntries(entries) {
  if (!Array.isArray(entries)) return []

  const seenTerms = new Set()

  return entries
    .map((entry) => ({
      source: String(entry.source || entry[0] || '').trim(),
      target: String(entry.target || entry[1] || '').trim(),
    }))
    .filter((entry) => entry.source && entry.target)
    .filter((entry) => {
      const key = entry.source.toLowerCase()

      if (seenTerms.has(key)) return false

      seenTerms.add(key)
      return true
    })
}

function normalizeHistoryItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => {
      if (!item || !HISTORY_TYPES.has(item.type)) return null

      const createdAt = Number(item.createdAt || item.timestamp || Date.now())
      const pageNumber = Number(item.pageNumber)

      return {
        id: String(item.id || `${createdAt}`),
        documentId: typeof item.documentId === 'string' ? item.documentId : undefined,
        filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
        fileName: typeof item.fileName === 'string' ? item.fileName : undefined,
        type: item.type,
        title: String(item.title || ''),
        pageNumber: Number.isFinite(pageNumber) ? pageNumber : null,
        selectedText: typeof item.selectedText === 'string' ? item.selectedText : undefined,
        translation: typeof item.translation === 'string' ? item.translation : undefined,
        ocrText: typeof item.ocrText === 'string' ? item.ocrText : undefined,
        screenshotDataUrl: typeof item.screenshotDataUrl === 'string' ? item.screenshotDataUrl : undefined,
        diagramResultImage: typeof item.diagramResultImage === 'string' ? item.diagramResultImage : undefined,
        compareOriginalImage: typeof item.compareOriginalImage === 'string' ? item.compareOriginalImage : undefined,
        compareTranslatedImage: typeof item.compareTranslatedImage === 'string' ? item.compareTranslatedImage : undefined,
        compareLayout: item.compareLayout === 'vertical' ? 'vertical' : item.compareLayout === 'horizontal' ? 'horizontal' : undefined,
        createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HISTORY_LIMIT)
}

function normalizeBrowsingRecord(record = {}) {
  const filePath = String(record.filePath || '').trim()
  const fileName = String(record.fileName || (filePath ? path.basename(filePath) : '')).trim()
  const fileSize = Math.max(0, Number(record.fileSize) || 0)

  if (!filePath || !fileName) return null

  const now = Date.now()
  const documentId = String(record.documentId || createDocumentId(filePath, fileName, fileSize))
  const totalPages = Number(record.totalPages)
  const lastPage = Math.max(1, Number(record.lastPage) || 1)
  const scale = Math.min(300, Math.max(50, Number(record.scale) || 100))
  const rightPanelWidth = Math.min(700, Math.max(280, Number(record.rightPanelWidth) || 420))
  const lastOpenedAt = Number(record.lastOpenedAt || now)
  const createdAt = Number(record.createdAt || now)

  return {
    id: String(record.id || documentId),
    documentId,
    filePath,
    fileName,
    fileSize,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
    lastPage,
    scale,
    rightPanelWidth,
    rightPanelVisible: record.rightPanelVisible !== false,
    lastOpenedAt: Number.isFinite(lastOpenedAt) ? lastOpenedAt : now,
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
  }
}

function normalizeBrowsingHistory(records) {
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

function normalizeDocumentHistoryItem(item = {}) {
  const normalized = normalizeHistoryItems([item])[0]

  if (!normalized) return null

  const documentId = String(item.documentId || '').trim()
  const filePath = String(item.filePath || normalized.filePath || '').trim()
  const fileName = String(item.fileName || normalized.fileName || '').trim()

  if (!documentId) return null

  return {
    ...normalized,
    documentId,
    filePath: filePath || undefined,
    fileName: fileName || undefined,
  }
}

function normalizeDocumentTranslationHistories(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

  return Object.fromEntries(
    Object.entries(data)
      .map(([documentId, value]) => {
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const items = normalizeHistoryItems(Array.isArray(container.items) ? container.items : [])
          .map((item) => normalizeDocumentHistoryItem({ ...item, documentId }))
          .filter(Boolean)
          .slice(0, HISTORY_LIMIT)

        if (!items.length && !container.filePath && !container.fileName) return null

        return [
          documentId,
          {
            filePath: typeof container.filePath === 'string' ? container.filePath : '',
            fileName: typeof container.fileName === 'string' ? container.fileName : '',
            lastOpenedAt: Number(container.lastOpenedAt) || 0,
            items,
          },
        ]
      })
      .filter(Boolean),
  )
}

function normalizeNoteItem(item = {}) {
  if (!item || !NOTE_TYPES.has(item.type)) return null

  const documentId = String(item.documentId || '').trim()
  const filePath = String(item.filePath || '').trim()
  const fileName = String(item.fileName || '').trim()
  const createdAt = Number(item.createdAt || Date.now())
  const updatedAt = Number(item.updatedAt || createdAt)
  const pageNumber = Math.max(1, Number(item.pageNumber) || 1)

  if (!documentId) return null

  return {
    id: String(item.id || `${createdAt}-${Math.random().toString(36).slice(2, 9)}`),
    documentId,
    filePath,
    fileName,
    type: item.type,
    pageNumber,
    title: String(item.title || ''),
    noteText: String(item.noteText || ''),
    selectedText: typeof item.selectedText === 'string' ? item.selectedText : undefined,
    translation: typeof item.translation === 'string' ? item.translation : undefined,
    highlightId: typeof item.highlightId === 'string' ? item.highlightId : undefined,
    color: typeof item.color === 'string' ? item.color : undefined,
    ocrText: typeof item.ocrText === 'string' ? item.ocrText : undefined,
    screenshotDataUrl: typeof item.screenshotDataUrl === 'string' ? item.screenshotDataUrl : undefined,
    diagramResultImage: typeof item.diagramResultImage === 'string' ? item.diagramResultImage : undefined,
    compareOriginalImage: typeof item.compareOriginalImage === 'string' ? item.compareOriginalImage : undefined,
    compareTranslatedImage: typeof item.compareTranslatedImage === 'string' ? item.compareTranslatedImage : undefined,
    compareLayout: item.compareLayout === 'vertical' ? 'vertical' : item.compareLayout === 'horizontal' ? 'horizontal' : undefined,
    sourceHistoryId: typeof item.sourceHistoryId === 'string' ? item.sourceHistoryId : undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }
}

function normalizeAnnotationRect(rect = {}) {
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null

  return { x, y, width, height }
}

function normalizeAnnotationItem(item = {}) {
  if (!item || !ANNOTATION_TYPES.has(item.type)) return null

  const documentId = String(item.documentId || '').trim()
  const filePath = String(item.filePath || '').trim()
  const fileName = String(item.fileName || '').trim()
  const createdAt = Number(item.createdAt || Date.now())
  const updatedAt = Number(item.updatedAt || createdAt)

  if (!documentId) return null

  const base = {
    id: String(item.id || `${createdAt}-${Math.random().toString(36).slice(2, 9)}`),
    documentId,
    filePath,
    fileName,
    type: item.type,
    pageNumber: Math.max(1, Number(item.pageNumber) || 1),
    pageWidth: Number(item.pageWidth) || 1,
    pageHeight: Number(item.pageHeight) || 1,
    noteId: typeof item.noteId === 'string' ? item.noteId : undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }

  if (item.type === 'text-highlight') {
    const rects = Array.isArray(item.rects) ? item.rects.map(normalizeAnnotationRect).filter(Boolean) : []
    if (!rects.length) return null

    return {
      ...base,
      selectedText: String(item.selectedText || ''),
      color: String(item.color || '#fde68a'),
      rects,
      translation: typeof item.translation === 'string' ? item.translation : undefined,
      embeddedInPdf: Boolean(item.embeddedInPdf),
      pdfAnnotationId: typeof item.pdfAnnotationId === 'string' ? item.pdfAnnotationId : undefined,
      pdfFilePath: typeof item.pdfFilePath === 'string' ? item.pdfFilePath : undefined,
      pdfBackupPath: typeof item.pdfBackupPath === 'string' ? item.pdfBackupPath : undefined,
    }
  }

  const rect = normalizeAnnotationRect(item.rect)
  if (!rect) return null

  return {
    ...base,
    rect,
    mode: ['ocr-text', 'ocr-diagram', 'ocr-compare'].includes(item.mode) ? item.mode : 'ocr-text',
  }
}

function normalizeAnnotationItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .map(normalizeAnnotationItem)
    .filter(Boolean)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
}

function normalizeDocumentAnnotations(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

  return Object.fromEntries(
    Object.entries(data)
      .map(([documentId, value]) => {
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const filePath = typeof container.filePath === 'string' ? container.filePath : ''
        const fileName = typeof container.fileName === 'string' ? container.fileName : ''
        const items = normalizeAnnotationItems(Array.isArray(container.items) ? container.items : [])
          .map((item) => normalizeAnnotationItem({
            ...item,
            documentId,
            filePath: item.filePath || filePath,
            fileName: item.fileName || fileName,
          }))
          .filter(Boolean)

        if (!items.length && !filePath && !fileName) return null

        return [documentId, { filePath, fileName, lastUpdatedAt: Number(container.lastUpdatedAt) || 0, items }]
      })
      .filter(Boolean),
  )
}

function normalizeNoteItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .map(normalizeNoteItem)
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function normalizeDocumentNotes(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

  return Object.fromEntries(
    Object.entries(data)
      .map(([documentId, value]) => {
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const filePath = typeof container.filePath === 'string' ? container.filePath : ''
        const fileName = typeof container.fileName === 'string' ? container.fileName : ''
        const items = normalizeNoteItems(Array.isArray(container.items) ? container.items : [])
          .map((item) => normalizeNoteItem({
            ...item,
            documentId,
            filePath: item.filePath || filePath,
            fileName: item.fileName || fileName,
          }))
          .filter(Boolean)

        if (!items.length && !filePath && !fileName) return null

        return [
          documentId,
          {
            filePath,
            fileName,
            lastUpdatedAt: Number(container.lastUpdatedAt) || 0,
            items,
          },
        ]
      })
      .filter(Boolean),
  )
}

function splitCsvLine(line) {
  const cells = []
  let currentCell = ''
  let isQuoted = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const nextCharacter = line[index + 1]

    if (character === '"' && nextCharacter === '"') {
      currentCell += '"'
      index += 1
      continue
    }

    if (character === '"') {
      isQuoted = !isQuoted
      continue
    }

    if (character === ',' && !isQuoted) {
      cells.push(currentCell)
      currentCell = ''
      continue
    }

    currentCell += character
  }

  cells.push(currentCell)
  return cells
}

function parseCsvGlossary(rawText) {
  const rows = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(splitCsvLine)

  const dataRows =
    rows[0]?.[0]?.trim().toLowerCase() === 'source' &&
    ['target', 'chinese'].includes(rows[0]?.[1]?.trim().toLowerCase())
      ? rows.slice(1)
      : rows

  return normalizeGlossaryEntries(dataRows)
}

function parseGlossaryFile(rawText, filePath) {
  if (filePath.toLowerCase().endsWith('.json')) {
    return normalizeGlossaryEntries(JSON.parse(rawText))
  }

  return parseCsvGlossary(rawText)
}

async function readConfig() {
  try {
    const rawConfig = await fs.readFile(getConfigPath(), 'utf8')
    return normalizeConfig(JSON.parse(rawConfig))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...DEFAULT_CONFIG }
    }

    throw new Error(`读取配置失败：${error.message}`, { cause: error })
  }
}

async function saveConfig(config) {
  try {
    const nextConfig = normalizeConfig(config)
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(getConfigPath(), `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8')
    return nextConfig
  } catch (error) {
    throw new Error(`保存配置失败：${error.message}`, { cause: error })
  }
}

async function readGlossary() {
  try {
    const rawGlossary = await fs.readFile(getGlossaryPath(), 'utf8')
    return normalizeGlossaryEntries(JSON.parse(rawGlossary))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw new Error(`读取术语库失败：${error.message}`, { cause: error })
  }
}

async function saveGlossary(glossary) {
  const nextGlossary = normalizeGlossaryEntries(glossary)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getGlossaryPath(), `${JSON.stringify(nextGlossary, null, 2)}\n`, 'utf8')
  return nextGlossary
}

async function importGlossary() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入术语库',
    properties: ['openFile'],
    filters: [
      { name: 'Glossary', extensions: ['csv', 'json'] },
      { name: 'CSV', extensions: ['csv'] },
      { name: 'JSON', extensions: ['json'] },
    ],
  })

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, count: 0, glossary: await readGlossary() }
  }

  try {
    const filePath = result.filePaths[0]
    const rawText = await fs.readFile(filePath, 'utf8')
    const glossary = parseGlossaryFile(rawText, filePath)

    if (!glossary.length) {
      throw new Error('没有找到有效术语。CSV 每行应为 source,target，JSON 应为 [{ "source": "...", "target": "..." }]。')
    }

    const savedGlossary = await saveGlossary(glossary)
    return { canceled: false, count: savedGlossary.length, glossary: savedGlossary }
  } catch (error) {
    throw new Error(`导入术语库失败：${error.message}`, { cause: error })
  }
}

async function clearGlossary() {
  await saveGlossary([])
  return []
}

async function readHistory() {
  try {
    const rawHistory = await fs.readFile(getHistoryPath(), 'utf8')
    return normalizeHistoryItems(JSON.parse(rawHistory))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw new Error(`读取翻译历史失败：${error.message}`, { cause: error })
  }
}

async function saveHistory(history) {
  const nextHistory = normalizeHistoryItems(history)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getHistoryPath(), `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8')
  return nextHistory
}

async function clearHistory() {
  await saveHistory([])
  return []
}

async function readBrowsingHistory() {
  try {
    const rawHistory = await fs.readFile(getBrowsingHistoryPath(), 'utf8')
    return normalizeBrowsingHistory(JSON.parse(rawHistory))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw new Error(`读取最近打开记录失败：${error.message}`, { cause: error })
  }
}

async function saveBrowsingHistory(history) {
  const nextHistory = normalizeBrowsingHistory(history)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getBrowsingHistoryPath(), `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8')
  await pruneDocumentTranslationHistories(nextHistory)
  return nextHistory
}

async function updateBrowsingRecord(record) {
  const normalizedRecord = normalizeBrowsingRecord(record)

  if (!normalizedRecord) {
    return readBrowsingHistory()
  }

  const currentHistory = await readBrowsingHistory()
  const now = Date.now()
  const nextRecord = {
    ...normalizedRecord,
    lastOpenedAt: Number(record.lastOpenedAt) || now,
  }
  const nextHistory = normalizeBrowsingHistory([
    nextRecord,
    ...currentHistory.filter((item) => item.documentId !== nextRecord.documentId && item.filePath !== nextRecord.filePath),
  ])

  return saveBrowsingHistory(nextHistory)
}

async function deleteBrowsingRecord(id) {
  const currentHistory = await readBrowsingHistory()
  const deletedRecord = currentHistory.find((record) => record.id === id || record.documentId === id)
  const nextHistory = currentHistory.filter((record) => record.id !== id && record.documentId !== id)

  await saveBrowsingHistory(nextHistory)

  if (deletedRecord?.documentId) {
    const histories = await readDocumentTranslationHistories()
    delete histories[deletedRecord.documentId]
    await saveDocumentTranslationHistories(histories, { prune: false })
  }

  return nextHistory
}

async function clearBrowsingHistory() {
  const currentHistory = await readBrowsingHistory()
  const documentIds = new Set(currentHistory.map((record) => record.documentId))

  await saveBrowsingHistory([])

  if (documentIds.size) {
    const histories = await readDocumentTranslationHistories()
    for (const documentId of documentIds) {
      delete histories[documentId]
    }
    await saveDocumentTranslationHistories(histories, { prune: false })
  }

  return []
}

async function readDocumentTranslationHistories() {
  try {
    const rawHistory = await fs.readFile(getDocumentTranslationHistoryPath(), 'utf8')
    return normalizeDocumentTranslationHistories(JSON.parse(rawHistory))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}
    }

    throw new Error(`读取文献翻译历史失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentTranslationHistories(data, options = {}) {
  let nextData = normalizeDocumentTranslationHistories(data)

  if (options.prune !== false) {
    const browsingHistory = await readBrowsingHistory()
    const recentDocumentIds = new Set(browsingHistory.map((record) => record.documentId))
    nextData = Object.fromEntries(
      Object.entries(nextData).filter(([documentId]) => recentDocumentIds.has(documentId)),
    )
  }

  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getDocumentTranslationHistoryPath(), `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
  return nextData
}

async function pruneDocumentTranslationHistories(recentBrowsingRecords) {
  const histories = await readDocumentTranslationHistories()
  const recentDocumentIds = new Set(normalizeBrowsingHistory(recentBrowsingRecords).map((record) => record.documentId))
  const nextHistories = Object.fromEntries(
    Object.entries(histories).filter(([documentId]) => recentDocumentIds.has(documentId)),
  )

  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getDocumentTranslationHistoryPath(), `${JSON.stringify(nextHistories, null, 2)}\n`, 'utf8')
  return nextHistories
}

async function getDocumentTranslationHistory(documentId) {
  const histories = await readDocumentTranslationHistories()
  return normalizeHistoryItems(histories[documentId]?.items || [])
}

async function saveDocumentTranslationHistory(documentId, payload = {}) {
  const histories = await readDocumentTranslationHistories()
  const current = histories[documentId] || {}
  const filePath = String(payload.filePath || current.filePath || '')
  const fileName = String(payload.fileName || current.fileName || '')
  const items = normalizeHistoryItems(payload.items || [])
    .map((item) => normalizeDocumentHistoryItem({ ...item, documentId, filePath: item.filePath || filePath, fileName: item.fileName || fileName }))
    .filter(Boolean)
    .slice(0, HISTORY_LIMIT)

  histories[documentId] = {
    filePath,
    fileName,
    lastOpenedAt: Number(payload.lastOpenedAt || current.lastOpenedAt || Date.now()),
    items,
  }

  const savedHistories = await saveDocumentTranslationHistories(histories)
  return savedHistories[documentId]?.items || []
}

async function clearDocumentTranslationHistory(documentId) {
  const histories = await readDocumentTranslationHistories()

  if (histories[documentId]) {
    histories[documentId] = {
      ...histories[documentId],
      items: [],
    }
    await saveDocumentTranslationHistories(histories)
  }

  return []
}

async function clearAllDocumentTranslationHistories() {
  await saveDocumentTranslationHistories({}, { prune: false })
  return {}
}

async function readDocumentNotes() {
  try {
    const rawNotes = await fs.readFile(getNotesPath(), 'utf8')
    return normalizeDocumentNotes(JSON.parse(rawNotes))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {}
    }

    throw new Error(`读取文献笔记失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentNotesData(data) {
  const nextData = normalizeDocumentNotes(data)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getNotesPath(), `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
  return nextData
}

async function readDocumentAnnotations() {
  try {
    const rawAnnotations = await fs.readFile(getAnnotationsPath(), 'utf8')
    return normalizeDocumentAnnotations(JSON.parse(rawAnnotations))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`读取文献批注失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentAnnotationsData(data) {
  const nextData = normalizeDocumentAnnotations(data)
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(getAnnotationsPath(), `${JSON.stringify(nextData, null, 2)}\n`, 'utf8')
  return nextData
}

async function getDocumentAnnotations(documentId) {
  const annotations = await readDocumentAnnotations()
  return normalizeAnnotationItems(annotations[documentId]?.items || [])
}

async function saveDocumentAnnotations(documentId, payload = {}) {
  const annotations = await readDocumentAnnotations()
  const current = annotations[documentId] || {}
  const filePath = String(payload.filePath || current.filePath || '')
  const fileName = String(payload.fileName || current.fileName || '')
  const items = normalizeAnnotationItems(payload.items || [])
    .map((item) => normalizeAnnotationItem({ ...item, documentId, filePath: item.filePath || filePath, fileName: item.fileName || fileName }))
    .filter(Boolean)

  annotations[documentId] = { filePath, fileName, lastUpdatedAt: Date.now(), items }
  const saved = await saveDocumentAnnotationsData(annotations)
  return saved[documentId]?.items || []
}

async function addDocumentAnnotation(annotation) {
  const normalizedAnnotation = normalizeAnnotationItem({
    ...annotation,
    id: annotation?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: annotation?.createdAt || Date.now(),
    updatedAt: annotation?.updatedAt || Date.now(),
  })

  if (!normalizedAnnotation) return []

  const currentAnnotations = await getDocumentAnnotations(normalizedAnnotation.documentId)
  return saveDocumentAnnotations(normalizedAnnotation.documentId, {
    filePath: normalizedAnnotation.filePath,
    fileName: normalizedAnnotation.fileName,
    items: [normalizedAnnotation, ...currentAnnotations.filter((item) => item.id !== normalizedAnnotation.id)],
  })
}

async function updateDocumentAnnotation(annotation) {
  const normalizedAnnotation = normalizeAnnotationItem({ ...annotation, updatedAt: Date.now() })
  if (!normalizedAnnotation) return []

  const currentAnnotations = await getDocumentAnnotations(normalizedAnnotation.documentId)
  return saveDocumentAnnotations(normalizedAnnotation.documentId, {
    filePath: normalizedAnnotation.filePath,
    fileName: normalizedAnnotation.fileName,
    items: currentAnnotations.map((item) => (item.id === normalizedAnnotation.id ? normalizedAnnotation : item)),
  })
}

async function deleteDocumentAnnotation(documentId, annotationId) {
  const currentAnnotations = await getDocumentAnnotations(documentId)
  const deletedAnnotation = currentAnnotations.find((item) => item.id === annotationId)
  const nextAnnotations = await saveDocumentAnnotations(documentId, {
    items: currentAnnotations.filter((item) => item.id !== annotationId),
  })

  if (deletedAnnotation?.type === 'text-highlight' && deletedAnnotation.noteId) {
    const notes = await readDocumentNotes()
    if (notes[documentId]) {
      notes[documentId].items = normalizeNoteItems(notes[documentId].items || [])
        .map((item) => (item.id === deletedAnnotation.noteId ? { ...item, highlightId: undefined, updatedAt: Date.now() } : item))
      notes[documentId].lastUpdatedAt = Date.now()
      await saveDocumentNotesData(notes)
    }
  }

  return nextAnnotations
}

async function getDocumentNotes(documentId) {
  const notes = await readDocumentNotes()
  return normalizeNoteItems(notes[documentId]?.items || [])
}

async function saveDocumentNotes(documentId, payload = {}) {
  const notes = await readDocumentNotes()
  const current = notes[documentId] || {}
  const filePath = String(payload.filePath || current.filePath || '')
  const fileName = String(payload.fileName || current.fileName || '')
  const items = normalizeNoteItems(payload.items || [])
    .map((item) => normalizeNoteItem({ ...item, documentId, filePath: item.filePath || filePath, fileName: item.fileName || fileName }))
    .filter(Boolean)

  notes[documentId] = {
    filePath,
    fileName,
    lastUpdatedAt: Date.now(),
    items,
  }

  const savedNotes = await saveDocumentNotesData(notes)
  return savedNotes[documentId]?.items || []
}

async function addDocumentNote(note) {
  const normalizedNote = normalizeNoteItem({
    ...note,
    id: note?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: note?.createdAt || Date.now(),
    updatedAt: note?.updatedAt || Date.now(),
  })

  if (!normalizedNote) return []

  const currentNotes = await getDocumentNotes(normalizedNote.documentId)
  return saveDocumentNotes(normalizedNote.documentId, {
    filePath: normalizedNote.filePath,
    fileName: normalizedNote.fileName,
    items: [normalizedNote, ...currentNotes.filter((item) => item.id !== normalizedNote.id)],
  })
}

async function updateDocumentNote(note) {
  const normalizedNote = normalizeNoteItem({
    ...note,
    updatedAt: Date.now(),
  })

  if (!normalizedNote) return []

  const currentNotes = await getDocumentNotes(normalizedNote.documentId)
  return saveDocumentNotes(normalizedNote.documentId, {
    filePath: normalizedNote.filePath,
    fileName: normalizedNote.fileName,
    items: currentNotes.map((item) => (item.id === normalizedNote.id ? normalizedNote : item)),
  })
}

async function deleteDocumentNote(documentId, noteId) {
  const notes = await readDocumentNotes()
  const current = notes[documentId]

  if (!current) return []

  current.items = normalizeNoteItems(current.items || []).filter((item) => item.id !== noteId)
  current.lastUpdatedAt = Date.now()
  notes[documentId] = current
  const savedNotes = await saveDocumentNotesData(notes)
  const annotations = await readDocumentAnnotations()
  if (annotations[documentId]) {
    annotations[documentId].items = normalizeAnnotationItems(annotations[documentId].items || [])
      .filter((item) => !(item.type === 'ocr-note-tag' && item.noteId === noteId))
      .map((item) => (item.type === 'text-highlight' && item.noteId === noteId ? { ...item, noteId: undefined } : item))
    annotations[documentId].lastUpdatedAt = Date.now()
    await saveDocumentAnnotationsData(annotations)
  }
  return savedNotes[documentId]?.items || []
}

async function clearDocumentNotes(documentId) {
  const notes = await readDocumentNotes()

  if (notes[documentId]) {
    notes[documentId] = {
      ...notes[documentId],
      lastUpdatedAt: Date.now(),
      items: [],
    }
    await saveDocumentNotesData(notes)
  }

  const annotations = await readDocumentAnnotations()
  if (annotations[documentId]) {
    annotations[documentId].items = normalizeAnnotationItems(annotations[documentId].items || [])
      .filter((item) => item.type !== 'ocr-note-tag')
      .map((item) => (item.type === 'text-highlight' && item.noteId ? { ...item, noteId: undefined, updatedAt: Date.now() } : item))
    annotations[documentId].lastUpdatedAt = Date.now()
    await saveDocumentAnnotationsData(annotations)
  }

  return []
}

function formatExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function formatExportDateText(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function sanitizeExportName(value, fallback = '未命名合集') {
  const cleaned = String(value || fallback)
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  return (cleaned || fallback).slice(0, 40)
}

function getShortDocumentId(documentId = '') {
  return String(documentId || 'document').slice(0, 10) || 'document'
}

function getExportTypeLabel(exportType) {
  if (exportType === 'translation-history') return '翻译历史'
  if (exportType === 'notes') return '笔记'
  if (exportType === 'mixed') return '混合'
  if (exportType === 'merged') return '合并文件'
  return '完整备份'
}

function getExportFileBaseName({ exportType, exportMode, fileName, documentId, userExportName, timestamp, merged = false }) {
  if (merged) {
    const label = exportType === 'mixed' ? '混合合集' : `${getExportTypeLabel(exportType)}合集`
    return `PaperReader_${label}_${sanitizeExportName(userExportName, '未命名合集')}_${timestamp}`
  }

  const label = getExportTypeLabel(exportType)
  if (exportMode === 'multi-document') {
    return `PaperReader_${label}合集_${sanitizeExportName(userExportName, '未命名合集')}_${timestamp}`
  }

  return `PaperReader_${label}_${sanitizeExportName(fileName || 'document')}_${getShortDocumentId(documentId)}_${timestamp}`
}

async function getValidExportDefaultDir() {
  const config = await readConfig()
  const configuredDir = String(config.exportDefaultDir || '').trim()

  if (configuredDir) {
    try {
      const stat = await fs.stat(configuredDir)
      if (stat.isDirectory()) return configuredDir
    } catch {
      // Fall back to Downloads if the configured directory was removed.
    }
  }

  return app.getPath('downloads')
}

async function setExportDefaultDir(dirPath) {
  const nextDir = String(dirPath || '').trim()
  if (nextDir) {
    const stat = await fs.stat(nextDir)
    if (!stat.isDirectory()) throw new Error('请选择有效的文件夹')
  }

  const config = await readConfig()
  return saveConfig({ ...config, exportDefaultDir: nextDir })
}

async function selectExportDefaultDir() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择默认导出位置',
    properties: ['openDirectory', 'createDirectory'],
  })

  if (result.canceled || !result.filePaths[0]) {
    return readConfig()
  }

  return setExportDefaultDir(result.filePaths[0])
}

async function resetExportDefaultDir() {
  const config = await readConfig()
  return saveConfig({ ...config, exportDefaultDir: '' })
}

function buildDocumentMeta(documentId, containers = {}, browsingRecord = null) {
  const filePath = containers.filePath || browsingRecord?.filePath || ''
  const fileName = containers.fileName || browsingRecord?.fileName || (filePath ? path.basename(filePath) : documentId)
  return {
    documentId,
    fileName,
    filePath,
    fileSize: Number(browsingRecord?.fileSize) || 0,
    lastUpdatedAt: Number(containers.lastUpdatedAt || containers.lastOpenedAt || browsingRecord?.lastOpenedAt || Date.now()),
  }
}

function getRelatedAnnotations(notes = [], annotations = []) {
  const noteIds = new Set(notes.map((note) => note.id))
  const highlightIds = new Set(notes.map((note) => note.highlightId).filter(Boolean))

  return annotations.filter((annotation) => {
    if (annotation.type === 'ocr-note-tag') return noteIds.has(annotation.noteId)
    if (annotation.type === 'text-highlight') {
      return noteIds.has(annotation.noteId) || highlightIds.has(annotation.id)
    }
    return false
  })
}

async function collectDocumentExportData(documentId, exportType = 'full') {
  const histories = await readDocumentTranslationHistories()
  const notesData = await readDocumentNotes()
  const annotationsData = await readDocumentAnnotations()
  const browsingHistory = await readBrowsingHistory()
  const browsingRecord = browsingHistory.find((record) => record.documentId === documentId)
  const historyContainer = histories[documentId] || {}
  const noteContainer = notesData[documentId] || {}
  const annotationContainer = annotationsData[documentId] || {}
  const historyItems = normalizeHistoryItems(historyContainer.items || [])
  const noteItems = normalizeNoteItems(noteContainer.items || [])
  const annotationItems = normalizeAnnotationItems(annotationContainer.items || [])
  const document = buildDocumentMeta(documentId, {
    filePath: historyContainer.filePath || noteContainer.filePath || annotationContainer.filePath,
    fileName: historyContainer.fileName || noteContainer.fileName || annotationContainer.fileName,
    lastUpdatedAt: Math.max(
      Number(historyContainer.lastOpenedAt) || 0,
      Number(noteContainer.lastUpdatedAt) || 0,
      Number(annotationContainer.lastUpdatedAt) || 0,
    ),
  }, browsingRecord)

  return {
    document,
    data: {
      translationHistory: exportType === 'notes' ? [] : historyItems,
      notes: exportType === 'translation-history' ? [] : noteItems,
      annotations: exportType === 'translation-history' ? [] : getRelatedAnnotations(noteItems, annotationItems),
    },
  }
}

function buildSingleDocumentExport(documentId, exportType, payload) {
  const now = new Date()
  const timestamp = formatExportTimestamp(now)
  const exportName = getExportFileBaseName({
    exportType,
    exportMode: 'single-document',
    fileName: payload.document.fileName,
    documentId,
    timestamp,
  })

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appName: EXPORT_APP_NAME,
    exportType,
    entryExportType: exportType,
    exportMode: 'single-document',
    exportName,
    entryExportName: exportName,
    userExportName: payload.document.fileName,
    createdAt: now.getTime(),
    createdAtText: formatExportDateText(now),
    document: payload.document,
    data: payload.data,
  }
}

function buildMultiDocumentExport(documents, exportType, userExportName, merged = false) {
  const now = new Date()
  const timestamp = formatExportTimestamp(now)
  const exportName = getExportFileBaseName({
    exportType,
    exportMode: 'multi-document',
    userExportName,
    timestamp,
    merged,
  })

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appName: EXPORT_APP_NAME,
    exportType,
    exportMode: 'multi-document',
    exportName,
    userExportName: sanitizeExportName(userExportName, '未命名合集'),
    createdAt: now.getTime(),
    createdAtText: formatExportDateText(now),
    documents: documents.map((entry) => ({
      ...entry,
      entryExportType: entry.entryExportType || entry.exportType || exportType,
      entryExportName: entry.entryExportName || entry.exportName,
    })),
  }
}

async function writeExportJson(exportObject, targetDir = null) {
  const defaultDir = targetDir || await getValidExportDefaultDir()
  const defaultPath = path.join(defaultDir, `${exportObject.exportName}${EXPORT_EXTENSION}`)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Paper Reader 导出文件',
    defaultPath,
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json'] }],
  })

  if (result.canceled || !result.filePath) return { canceled: true }

  await fs.writeFile(result.filePath, `${JSON.stringify(exportObject, null, 2)}\n`, 'utf8')
  return { canceled: false, filePath: result.filePath, exportName: exportObject.exportName }
}

async function writeExportJsonDirect(exportObject, targetDir) {
  await fs.mkdir(targetDir, { recursive: true })
  const filePath = path.join(targetDir, `${exportObject.exportName}${EXPORT_EXTENSION}`)
  await fs.writeFile(filePath, `${JSON.stringify(exportObject, null, 2)}\n`, 'utf8')
  return filePath
}

function validatePaperReaderExport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('不是有效的 Paper Reader 导出文件')
  }
  if (value.schemaVersion !== EXPORT_SCHEMA_VERSION || value.appName !== EXPORT_APP_NAME) {
    throw new Error('不是有效的 Paper Reader 导出文件')
  }
  return value
}

async function readExportFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return validatePaperReaderExport(JSON.parse(raw))
}

function getExportDocuments(exportObject) {
  const exportData = validatePaperReaderExport(exportObject)
  if (exportData.exportMode === 'single-document') {
    return [{
      exportName: exportData.exportName,
      entryExportName: exportData.entryExportName || exportData.exportName,
      entryExportType: exportData.entryExportType || exportData.exportType,
      sourceExportName: exportData.sourceExportName,
      document: exportData.document,
      data: exportData.data || {},
    }]
  }
  if (exportData.exportMode === 'multi-document' && Array.isArray(exportData.documents)) {
    return exportData.documents.map((entry) => ({
      ...entry,
      entryExportType: entry.entryExportType || entry.exportType || exportData.exportType,
      entryExportName: entry.entryExportName || entry.exportName,
    }))
  }
  throw new Error('不是有效的 Paper Reader 导出文件')
}

function uniqueByIdAndSignature(currentItems, incomingItems, makeSignature) {
  const ids = new Set(currentItems.map((item) => item.id))
  const signatures = new Set(currentItems.map(makeSignature))
  let imported = 0
  let skipped = 0
  const nextItems = [...currentItems]

  incomingItems.forEach((item) => {
    const signature = makeSignature(item)
    if (ids.has(item.id) || signatures.has(signature)) {
      skipped += 1
      return
    }
    ids.add(item.id)
    signatures.add(signature)
    nextItems.unshift(item)
    imported += 1
  })

  return { items: nextItems, imported, skipped }
}

function historySignature(item) {
  return [
    item.type,
    item.pageNumber ?? '',
    item.selectedText || item.ocrText || '',
    item.translation || '',
    item.createdAt || '',
  ].join('|')
}

function noteSignature(item) {
  return [
    item.type,
    item.pageNumber || '',
    item.title || '',
    item.noteText || '',
    item.selectedText || item.ocrText || '',
    item.createdAt || '',
  ].join('|')
}

function annotationSignature(item) {
  return [
    item.type,
    item.pageNumber || '',
    item.selectedText || '',
    item.noteId || '',
    item.highlightId || '',
    JSON.stringify(item.rects || item.rect || {}),
  ].join('|')
}

async function importExportDocuments(documents, forcedDocumentId = null, forcedType = null) {
  const histories = await readDocumentTranslationHistories()
  const notesData = await readDocumentNotes()
  const annotationsData = await readDocumentAnnotations()
  const summary = { documents: 0, translationHistory: 0, notes: 0, annotations: 0, skipped: 0 }
  const touchedDocuments = new Set()

  documents.forEach((entry) => {
    const sourceDocument = entry.document || {}
    const documentId = forcedDocumentId || String(sourceDocument.documentId || '').trim()
    if (!documentId) return

    const document = {
      documentId,
      filePath: String(sourceDocument.filePath || ''),
      fileName: String(sourceDocument.fileName || documentId),
      fileSize: Number(sourceDocument.fileSize) || 0,
      lastUpdatedAt: Number(sourceDocument.lastUpdatedAt) || Date.now(),
    }
    const data = entry.data || {}
    const incomingHistory = forcedType === 'notes' ? [] : normalizeHistoryItems(data.translationHistory || [])
      .map((item) => normalizeDocumentHistoryItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)
    const incomingNotes = forcedType === 'translation-history' ? [] : normalizeNoteItems(data.notes || [])
      .map((item) => normalizeNoteItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)
    const incomingAnnotations = forcedType === 'translation-history' ? [] : normalizeAnnotationItems(data.annotations || [])
      .map((item) => normalizeAnnotationItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)

    if (incomingHistory.length) {
      const current = histories[documentId] || { filePath: document.filePath, fileName: document.fileName, items: [] }
      const merged = uniqueByIdAndSignature(normalizeHistoryItems(current.items || []), incomingHistory, historySignature)
      histories[documentId] = {
        filePath: current.filePath || document.filePath,
        fileName: current.fileName || document.fileName,
        lastOpenedAt: Date.now(),
        items: normalizeHistoryItems(merged.items).slice(0, HISTORY_LIMIT),
      }
      summary.translationHistory += merged.imported
      summary.skipped += merged.skipped
    }

    if (incomingNotes.length) {
      const current = notesData[documentId] || { filePath: document.filePath, fileName: document.fileName, items: [] }
      const merged = uniqueByIdAndSignature(normalizeNoteItems(current.items || []), incomingNotes, noteSignature)
      notesData[documentId] = {
        filePath: current.filePath || document.filePath,
        fileName: current.fileName || document.fileName,
        lastUpdatedAt: Date.now(),
        items: normalizeNoteItems(merged.items),
      }
      summary.notes += merged.imported
      summary.skipped += merged.skipped
    }

    if (incomingAnnotations.length) {
      const current = annotationsData[documentId] || { filePath: document.filePath, fileName: document.fileName, items: [] }
      const merged = uniqueByIdAndSignature(normalizeAnnotationItems(current.items || []), incomingAnnotations, annotationSignature)
      annotationsData[documentId] = {
        filePath: current.filePath || document.filePath,
        fileName: current.fileName || document.fileName,
        lastUpdatedAt: Date.now(),
        items: normalizeAnnotationItems(merged.items),
      }
      summary.annotations += merged.imported
      summary.skipped += merged.skipped
    }

    touchedDocuments.add(documentId)
  })

  await saveDocumentTranslationHistories(histories, { prune: false })
  await saveDocumentNotesData(notesData)
  await saveDocumentAnnotationsData(annotationsData)
  summary.documents = touchedDocuments.size
  return summary
}

async function exportCurrentDocumentData(documentId, exportType) {
  const payload = await collectDocumentExportData(documentId, exportType)
  if (exportType === 'translation-history' && !payload.data.translationHistory.length) {
    throw new Error('暂无可导出的翻译历史')
  }
  if (exportType === 'notes' && !payload.data.notes.length) {
    throw new Error('暂无可导出的笔记')
  }
  const exportObject = buildSingleDocumentExport(documentId, exportType, payload)
  return writeExportJson(exportObject)
}

async function importDataToCurrentDocument(documentId, exportType) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Paper Reader 导出文件',
    properties: ['openFile'],
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json', 'json'] }],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const exportObject = await readExportFile(result.filePaths[0])
  const summary = await importExportDocuments(getExportDocuments(exportObject).slice(0, 1), documentId, exportType)
  return { canceled: false, summary }
}

async function getExportableDocuments() {
  const histories = await readDocumentTranslationHistories()
  const notes = await readDocumentNotes()
  const annotations = await readDocumentAnnotations()
  const browsingHistory = await readBrowsingHistory()
  const ids = new Set([
    ...Object.keys(histories),
    ...Object.keys(notes),
    ...Object.keys(annotations),
    ...browsingHistory.map((record) => record.documentId),
  ])

  return Array.from(ids).map((documentId) => {
    const historyContainer = histories[documentId] || {}
    const noteContainer = notes[documentId] || {}
    const annotationContainer = annotations[documentId] || {}
    const browsingRecord = browsingHistory.find((record) => record.documentId === documentId)
    const document = buildDocumentMeta(documentId, {
      filePath: historyContainer.filePath || noteContainer.filePath || annotationContainer.filePath,
      fileName: historyContainer.fileName || noteContainer.fileName || annotationContainer.fileName,
      lastUpdatedAt: Math.max(
        Number(historyContainer.lastOpenedAt) || 0,
        Number(noteContainer.lastUpdatedAt) || 0,
        Number(annotationContainer.lastUpdatedAt) || 0,
      ),
    }, browsingRecord)
    return {
      ...document,
      historyCount: normalizeHistoryItems(historyContainer.items || []).length,
      notesCount: normalizeNoteItems(noteContainer.items || []).length,
      annotationsCount: normalizeAnnotationItems(annotationContainer.items || []).length,
    }
  }).sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
}

async function batchExportPaperReaderData(options = {}) {
  const documentIds = Array.isArray(options.documentIds) ? options.documentIds : []
  const exportType = ['translation-history', 'notes', 'full'].includes(options.exportType) ? options.exportType : 'full'
  const exportMode = options.exportMode === 'separate' ? 'separate' : 'merged'
  const defaultDir = await getValidExportDefaultDir()
  const outputDirResult = exportMode === 'separate'
    ? await dialog.showOpenDialog(mainWindow, { title: '选择导出目录', defaultPath: defaultDir, properties: ['openDirectory', 'createDirectory'] })
    : null

  if (exportMode === 'separate' && (outputDirResult.canceled || !outputDirResult.filePaths[0])) return { canceled: true }

  const documents = []
  for (const documentId of documentIds) {
    const payload = await collectDocumentExportData(documentId, exportType)
    const singleExport = buildSingleDocumentExport(documentId, exportType, payload)
    documents.push({
      exportName: singleExport.exportName,
      entryExportName: singleExport.exportName,
      entryExportType: exportType,
      sourceExportName: singleExport.sourceExportName,
      document: singleExport.document,
      data: singleExport.data,
    })
  }

  if (exportMode === 'separate') {
    const filePaths = []
    for (const entry of documents) {
      const exportObject = buildSingleDocumentExport(entry.document.documentId, exportType, entry)
      filePaths.push(await writeExportJsonDirect(exportObject, outputDirResult.filePaths[0]))
    }
    return { canceled: false, filePaths, outputDir: outputDirResult.filePaths[0] }
  }

  const exportObject = buildMultiDocumentExport(documents, exportType, options.userExportName || '未命名合集')
  const saved = await writeExportJson(exportObject)
  return { ...saved, filePaths: saved.filePath ? [saved.filePath] : [] }
}

async function batchImportPaperReaderData() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Paper Reader 导出文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json', 'json'] }],
  })
  if (result.canceled || !result.filePaths.length) return { canceled: true }

  const allDocuments = []
  for (const filePath of result.filePaths) {
    const exportObject = await readExportFile(filePath)
    allDocuments.push(...getExportDocuments(exportObject))
  }
  const summary = await importExportDocuments(allDocuments)
  return { canceled: false, summary }
}

function getMergedExportType(documents) {
  const types = new Set(documents.map((entry) => entry.entryExportType || entry.exportType || 'full'))
  if (types.size === 1) return Array.from(types)[0]
  return 'mixed'
}

async function summarizePaperReaderExportFile(filePath) {
  const exportObject = await readExportFile(filePath)
  const documents = getExportDocuments(exportObject)
  return {
    filePath,
    fileName: path.basename(filePath),
    exportType: exportObject.exportType,
    exportMode: exportObject.exportMode,
    exportName: exportObject.exportName,
    documentCount: documents.length,
  }
}

async function selectPaperReaderExportFileForMerge() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Paper Reader 导出文件',
    properties: ['openFile'],
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json', 'json'] }],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  return { canceled: false, file: await summarizePaperReaderExportFile(result.filePaths[0]) }
}

async function mergePaperReaderExportFiles(filePaths = [], userExportName = '未命名合集') {
  const selectedFilePaths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : []
  if (!selectedFilePaths.length) throw new Error('请先添加要合并的导出文件')
  const documents = []
  for (const filePath of selectedFilePaths) {
    const exportObject = await readExportFile(filePath)
    documents.push(...getExportDocuments(exportObject).map((entry) => ({
      ...entry,
      entryExportType: entry.entryExportType || exportObject.exportType,
      entryExportName: entry.entryExportName || entry.exportName || exportObject.exportName,
      sourceExportName: entry.sourceExportName || entry.exportName || exportObject.exportName,
    })))
  }

  const merged = buildMultiDocumentExport(documents, getMergedExportType(documents), userExportName, true)
  const saved = await writeExportJson(merged)
  return { ...saved, documentCount: documents.length }
}

async function splitPaperReaderExportFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要拆分的 Paper Reader 合并文件',
    properties: ['openFile'],
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json', 'json'] }],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const exportObject = await readExportFile(result.filePaths[0])
  const documents = getExportDocuments(exportObject)
  const defaultDir = await getValidExportDefaultDir()
  const outputDirResult = await dialog.showOpenDialog(mainWindow, {
    title: '选择拆分输出目录',
    defaultPath: defaultDir,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (outputDirResult.canceled || !outputDirResult.filePaths[0]) return { canceled: true }

  const filePaths = []
  for (const entry of documents) {
    const exportType = ['translation-history', 'notes', 'full'].includes(entry.entryExportType)
      ? entry.entryExportType
      : (['translation-history', 'notes', 'full'].includes(exportObject.exportType) ? exportObject.exportType : 'full')
    const single = buildSingleDocumentExport(entry.document.documentId, exportType, {
      document: entry.document,
      data: entry.data || {},
    })
    single.sourceExportName = entry.sourceExportName || entry.exportName || exportObject.exportName
    filePaths.push(await writeExportJsonDirect(single, outputDirResult.filePaths[0]))
  }

  return { canceled: false, filePaths, outputDir: outputDirResult.filePaths[0] }
}

function hexToPdfRgb(color = '#FFFF00') {
  const match = String(color).trim().match(/^#?([0-9a-f]{6})$/i)
  const hex = match ? match[1] : 'FFFF00'
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ]
}

function getPdfStringValue(value) {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText()
  return ''
}

function getPdfHighlightGeometry(annotation, pageWidth, pageHeight) {
  const rects = Array.isArray(annotation?.rects) ? annotation.rects : []
  const pdfRects = rects
    .map((rect) => {
      const x = Number(rect.x)
      const y = Number(rect.y)
      const width = Number(rect.width)
      const height = Number(rect.height)
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
      const left = x * pageWidth
      const right = (x + width) * pageWidth
      const top = pageHeight - y * pageHeight
      const bottom = pageHeight - (y + height) * pageHeight
      return {
        left: Math.min(left, right),
        right: Math.max(left, right),
        bottom: Math.min(bottom, top),
        top: Math.max(bottom, top),
      }
    })
    .filter(Boolean)

  if (!pdfRects.length) return null

  const union = pdfRects.reduce((box, rect) => ({
    left: Math.min(box.left, rect.left),
    right: Math.max(box.right, rect.right),
    bottom: Math.min(box.bottom, rect.bottom),
    top: Math.max(box.top, rect.top),
  }), pdfRects[0])

  return {
    rect: [union.left, union.bottom, union.right, union.top],
    quadPoints: pdfRects.flatMap((rect) => [
      rect.left, rect.top,
      rect.right, rect.top,
      rect.left, rect.bottom,
      rect.right, rect.bottom,
    ]),
  }
}

function getPdfAnnotsArray(pdfDoc, page) {
  let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
  if (!annots) {
    annots = pdfDoc.context.obj([])
    page.node.set(PDFName.of('Annots'), annots)
  }
  return annots
}

async function embedPdfHighlightAnnotation(annotation) {
  const filePath = String(annotation?.filePath || '').trim()
  if (!filePath) throw new Error('当前 PDF 路径无效，无法写入 PDF 本体')

  const sourceBytes = await fs.readFile(filePath)
  const backupPath = `${filePath}.paper-reader-backup.pdf`
  try {
    await fs.access(backupPath)
  } catch {
    await fs.copyFile(filePath, backupPath)
  }

  const pdfDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const pageIndex = Math.max(0, Number(annotation.pageNumber || 1) - 1)
  const page = pdfDoc.getPages()[pageIndex]
  if (!page) throw new Error('PDF 页面不存在，无法写入高亮')

  const { width, height } = page.getSize()
  const geometry = getPdfHighlightGeometry(annotation, width, height)
  if (!geometry) throw new Error('高亮坐标无效，无法写入 PDF 本体')

  const pdfAnnotationId = annotation.pdfAnnotationId || `paper-reader-${annotation.id || Date.now()}`
  const color = hexToPdfRgb(annotation.color)
  const annotRef = pdfDoc.context.register(pdfDoc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Highlight'),
    Rect: geometry.rect,
    QuadPoints: geometry.quadPoints,
    C: color,
    CA: 0.5,
    NM: PDFString.of(pdfAnnotationId),
    F: 4,
  }))

  getPdfAnnotsArray(pdfDoc, page).push(annotRef)
  const nextBytes = await pdfDoc.save()
  await fs.writeFile(filePath, nextBytes)

  return {
    ...annotation,
    embeddedInPdf: true,
    pdfAnnotationId,
    pdfFilePath: filePath,
    pdfBackupPath: backupPath,
    updatedAt: Date.now(),
  }
}

async function deletePdfHighlightAnnotation(annotation) {
  const filePath = String(annotation?.pdfFilePath || annotation?.filePath || '').trim()
  const pdfAnnotationId = String(annotation?.pdfAnnotationId || '').trim()
  if (!filePath || !pdfAnnotationId) {
    throw new Error('该高亮没有可删除的 PDF 本体批注信息')
  }

  const pdfDoc = await PDFDocument.load(await fs.readFile(filePath), { ignoreEncryption: true })
  let removed = false

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) continue

    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annot = pdfDoc.context.lookup(annots.get(index))
      const nm = annot?.lookup?.(PDFName.of('NM'))
      if (getPdfStringValue(nm) === pdfAnnotationId) {
        annots.remove(index)
        removed = true
      }
    }
  }

  if (!removed) throw new Error('未在 PDF 文件本体中找到对应高亮')

  await fs.writeFile(filePath, await pdfDoc.save())
  return { removed: true, filePath }
}

async function openPdfFromPath(filePath) {
  const normalizedPath = String(filePath || '').trim()

  if (!normalizedPath) {
    throw new Error('文件不存在或已移动')
  }

  try {
    const stat = await fs.stat(normalizedPath)

    if (!stat.isFile()) {
      throw new Error('文件不存在或已移动')
    }

    const buffer = await fs.readFile(normalizedPath)
    const fileName = path.basename(normalizedPath)
    const fileSize = stat.size

    return {
      filePath: normalizedPath,
      fileName,
      fileSize,
      documentId: createDocumentId(normalizedPath, fileName, fileSize),
      dataUrl: `data:application/pdf;base64,${buffer.toString('base64')}`,
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('文件不存在或已移动', { cause: error })
    }

    throw error
  }
}

async function openPdfDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true }
  }

  return {
    canceled: false,
    ...(await openPdfFromPath(result.filePaths[0])),
  }
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', async () => readConfig())
  ipcMain.handle('config:save', async (_event, config) => saveConfig(config))
  ipcMain.handle('glossary:import', async () => importGlossary())
  ipcMain.handle('glossary:get', async () => readGlossary())
  ipcMain.handle('glossary:clear', async () => clearGlossary())
  ipcMain.handle('history:get', async () => readHistory())
  ipcMain.handle('history:save', async (_event, history) => saveHistory(history))
  ipcMain.handle('history:clear', async () => clearHistory())
  ipcMain.handle('browsing-history:get', async () => readBrowsingHistory())
  ipcMain.handle('browsing-history:save', async (_event, history) => saveBrowsingHistory(history))
  ipcMain.handle('browsing-history:update', async (_event, record) => updateBrowsingRecord(record))
  ipcMain.handle('browsing-history:delete', async (_event, id) => deleteBrowsingRecord(id))
  ipcMain.handle('browsing-history:clear', async () => clearBrowsingHistory())
  ipcMain.handle('pdf:open-dialog', async () => openPdfDialog())
  ipcMain.handle('pdf:open-from-path', async (_event, filePath) => openPdfFromPath(filePath))
  ipcMain.handle('document-history:get-all', async () => readDocumentTranslationHistories())
  ipcMain.handle('document-history:save-all', async (_event, data) => saveDocumentTranslationHistories(data))
  ipcMain.handle('document-history:get', async (_event, documentId) => getDocumentTranslationHistory(documentId))
  ipcMain.handle('document-history:save', async (_event, documentId, payload) => saveDocumentTranslationHistory(documentId, payload))
  ipcMain.handle('document-history:clear', async (_event, documentId) => clearDocumentTranslationHistory(documentId))
  ipcMain.handle('document-history:clear-all', async () => clearAllDocumentTranslationHistories())
  ipcMain.handle('document-notes:get', async (_event, documentId) => getDocumentNotes(documentId))
  ipcMain.handle('document-notes:save', async (_event, documentId, payload) => saveDocumentNotes(documentId, payload))
  ipcMain.handle('document-notes:add', async (_event, note) => addDocumentNote(note))
  ipcMain.handle('document-notes:update', async (_event, note) => updateDocumentNote(note))
  ipcMain.handle('document-notes:delete', async (_event, documentId, noteId) => deleteDocumentNote(documentId, noteId))
  ipcMain.handle('document-notes:clear', async (_event, documentId) => clearDocumentNotes(documentId))
  ipcMain.handle('document-annotations:get', async (_event, documentId) => getDocumentAnnotations(documentId))
  ipcMain.handle('document-annotations:save', async (_event, documentId, payload) => saveDocumentAnnotations(documentId, payload))
  ipcMain.handle('document-annotations:add', async (_event, annotation) => addDocumentAnnotation(annotation))
  ipcMain.handle('document-annotations:update', async (_event, annotation) => updateDocumentAnnotation(annotation))
  ipcMain.handle('document-annotations:delete', async (_event, documentId, annotationId) => deleteDocumentAnnotation(documentId, annotationId))
  ipcMain.handle('pdf-annotations:embed-highlight', async (_event, annotation) => embedPdfHighlightAnnotation(annotation))
  ipcMain.handle('pdf-annotations:delete-highlight', async (_event, annotation) => deletePdfHighlightAnnotation(annotation))
  ipcMain.handle('paperreader-export:current-history', async (_event, documentId) => exportCurrentDocumentData(documentId, 'translation-history'))
  ipcMain.handle('paperreader-export:import-history', async (_event, documentId) => importDataToCurrentDocument(documentId, 'translation-history'))
  ipcMain.handle('paperreader-export:current-notes', async (_event, documentId) => exportCurrentDocumentData(documentId, 'notes'))
  ipcMain.handle('paperreader-export:import-notes', async (_event, documentId) => importDataToCurrentDocument(documentId, 'notes'))
  ipcMain.handle('paperreader-export:get-documents', async () => getExportableDocuments())
  ipcMain.handle('paperreader-export:batch-export', async (_event, options) => batchExportPaperReaderData(options))
  ipcMain.handle('paperreader-export:batch-import', async () => batchImportPaperReaderData())
  ipcMain.handle('paperreader-export:select-merge-file', async () => selectPaperReaderExportFileForMerge())
  ipcMain.handle('paperreader-export:merge-files', async (_event, filePaths, userExportName) => mergePaperReaderExportFiles(filePaths, userExportName))
  ipcMain.handle('paperreader-export:split-file', async () => splitPaperReaderExportFile())
  ipcMain.handle('paperreader-export:get-default-dir', async () => getValidExportDefaultDir())
  ipcMain.handle('paperreader-export:set-default-dir', async (_event, dirPath) => setExportDefaultDir(dirPath))
  ipcMain.handle('paperreader-export:select-default-dir', async () => selectExportDefaultDir())
  ipcMain.handle('paperreader-export:reset-default-dir', async () => resetExportDefaultDir())
}

async function startBackend() {
  process.env.PAPER_READER_ENV_PATH = getEnvPath()
  process.env.PAPER_READER_CONFIG_PATH = getConfigPath()
  process.env.PAPER_READER_GLOSSARY_PATH = getGlossaryPath()

  const { startServer } = await import('../server/index.js')
  backendServer = await startServer({ port: process.env.PORT || 3001 })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Paper Reader',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
}

app.whenReady().then(async () => {
  try {
    registerIpcHandlers()
    await startBackend()
    createWindow()
  } catch (error) {
    console.error(error)
    dialog.showErrorBox(
      'Paper Reader failed to start',
      'The local translation server could not start. Check that port 3001 is free.',
    )
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (backendServer) {
    backendServer.close()
    backendServer = null
  }
})
