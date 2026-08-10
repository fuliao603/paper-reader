/* global process */

import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme } from 'electron'
import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'

let backendServer = null
let mainWindow = null
const jsonWriteQueues = new Map()
const storageMutationQueues = new Map()
const LEGACY_DEFAULT_TRANSLATION_PROMPT =
  '你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'
const DEFAULT_TRANSLATION_PROMPT =
  '你是通用学术翻译助手。请自动识别用户提供文本的源语言，并将其翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、原文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'

function normalizeTranslationPrompt(prompt) {
  const normalizedPrompt = String(prompt || '').trim()
  return !normalizedPrompt || normalizedPrompt === LEGACY_DEFAULT_TRANSLATION_PROMPT
    ? DEFAULT_TRANSLATION_PROMPT
    : normalizedPrompt
}

const DEFAULT_CONFIG = {
  provider: 'deepseek',
  apiKey: '',
  providerApiKeys: {},
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  modelSupportsMultimodal: null,
  temperatureMode: 'auto',
  temperature: 0.2,
  prompt: DEFAULT_TRANSLATION_PROMPT,
  enableMultimodalTranslation: false,
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
const LIBRARY_SCHEMA_VERSION = 2
const LIBRARY_MIGRATION_VERSION = 'unified-literature-v2'
const LITERATURE_STATUS_ACTIVE = 'active'
const LITERATURE_STATUS_RECYCLED = 'recycled'
const PROVIDER_DEFAULTS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  'anthropic-compatible': {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: '',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: '',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: '',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
}
const VALID_PROVIDER_IDS = new Set(Object.keys(PROVIDER_DEFAULTS))

function normalizeProviderApiKeys(config = {}, activeProvider = 'deepseek') {
  const storedApiKeys =
    config.providerApiKeys && typeof config.providerApiKeys === 'object' && !Array.isArray(config.providerApiKeys)
      ? config.providerApiKeys
      : {}
  const providerApiKeys = Object.fromEntries(
    Object.keys(PROVIDER_DEFAULTS)
      .map((provider) => [provider, String(storedApiKeys[provider] || '').trim()])
      .filter(([, apiKey]) => apiKey),
  )
  const activeApiKey = String(config.apiKey || '').trim()
  const legacyDeepseekApiKey = String(config.deepseekApiKey || '').trim()

  if (legacyDeepseekApiKey && !providerApiKeys.deepseek) {
    providerApiKeys.deepseek = legacyDeepseekApiKey
  }
  if (activeApiKey && !providerApiKeys[activeProvider]) {
    providerApiKeys[activeProvider] = activeApiKey
  }

  return providerApiKeys
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

function getBookmarksPath() {
  return path.join(app.getPath('userData'), 'paper-reader-bookmarks.json')
}

function getTableOfContentsPath() {
  return path.join(app.getPath('userData'), 'paper-reader-toc.json')
}

function getPdfSessionPath() {
  return path.join(app.getPath('userData'), 'paper-reader-pdf-session.json')
}

function getLibraryPath() {
  return path.join(app.getPath('userData'), 'paper-reader-library.json')
}

function extractFirstCompleteJson(rawText) {
  const text = String(rawText || '')
  const arrayStart = text.indexOf('[')
  const objectStart = text.indexOf('{')
  const start = arrayStart < 0
    ? objectStart
    : objectStart < 0
      ? arrayStart
      : Math.min(arrayStart, objectStart)
  if (start < 0) return null

  const opening = text[start]
  const closing = opening === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const character = text[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
      continue
    }
    if (character === opening) depth += 1
    if (character === closing) depth -= 1

    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1))
      } catch {
        return null
      }
    }
  }

  return null
}

function writeJsonFileAtomic(filePath, data) {
  const previousWrite = jsonWriteQueues.get(filePath) || Promise.resolve()
  const nextWrite = previousWrite
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

      try {
        await fs.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        await fs.rename(tempPath, filePath)
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        throw error
      }
    })

  jsonWriteQueues.set(filePath, nextWrite)
  return nextWrite.finally(() => {
    if (jsonWriteQueues.get(filePath) === nextWrite) {
      jsonWriteQueues.delete(filePath)
    }
  })
}

async function readJsonFileWithRecovery(filePath, fallbackValue, label) {
  try {
    const rawText = await fs.readFile(filePath, 'utf8')

    try {
      return JSON.parse(rawText)
    } catch (error) {
      const recovered = extractFirstCompleteJson(rawText)
      if (recovered === null) throw error

      const backupPath = `${filePath}.corrupt-${Date.now()}.bak`
      await fs.writeFile(backupPath, rawText, 'utf8')
      await writeJsonFileAtomic(filePath, recovered)
      console.warn(`[storage] Recovered corrupted ${label}; backup saved to ${backupPath}`)
      return recovered
    }
  } catch (error) {
    if (error.code === 'ENOENT') return fallbackValue
    throw error
  }
}

function runStorageMutation(storagePath, operation) {
  const previousMutation = storageMutationQueues.get(storagePath) || Promise.resolve()
  const nextMutation = previousMutation
    .catch(() => undefined)
    .then(operation)

  storageMutationQueues.set(storagePath, nextMutation)
  return nextMutation.finally(() => {
    if (storageMutationQueues.get(storagePath) === nextMutation) {
      storageMutationQueues.delete(storagePath)
    }
  })
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
  const rawProvider = String(config.provider || '').trim()
  const provider = VALID_PROVIDER_IDS.has(rawProvider) ? rawProvider : 'deepseek'
  const providerDefaults = PROVIDER_DEFAULTS[provider]
  const providerApiKeys = normalizeProviderApiKeys(config, provider)

  return {
    provider,
    apiKey: providerApiKeys[provider] || '',
    providerApiKeys,
    baseUrl: String(config.baseUrl || config.deepseekBaseUrl || providerDefaults.baseUrl).trim(),
    model: String(config.model || config.deepseekModel || providerDefaults.model).trim(),
    modelSupportsMultimodal:
      typeof config.modelSupportsMultimodal === 'boolean'
        ? config.modelSupportsMultimodal
        : null,
    temperatureMode: config.temperatureMode === 'custom' ? 'custom' : 'auto',
    temperature: Number.isFinite(Number(config.temperature))
      ? Math.max(0, Math.min(2, Number(config.temperature)))
      : 0.2,
    prompt: normalizeTranslationPrompt(config.prompt),
    enableMultimodalTranslation: config.enableMultimodalTranslation === true,
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

function createLibraryFolderId() {
  return `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeLibraryFolder(folder = {}, index = 0) {
  const name = String(folder.name || '').trim()

  if (!name) return null

  const now = Date.now()

  return {
    id: String(folder.id || createLibraryFolderId()),
    name,
    parentId: folder.parentId ? String(folder.parentId) : null,
    order: Number.isFinite(Number(folder.order))
      ? Number(folder.order)
      : Number.isFinite(Number(folder.sortOrder))
        ? Number(folder.sortOrder)
        : index,
    expanded: typeof folder.expanded === 'boolean' ? folder.expanded : !folder.collapsed,
    createdAt: Number(folder.createdAt) || now,
    updatedAt: Number(folder.updatedAt) || now,
  }
}

function normalizeLibraryDocument(document = {}, index = 0) {
  const filePath = String(document.filePath || '').trim()
  const fileName = String(document.fileName || (filePath ? path.basename(filePath) : '')).trim()
  const fileSize = Math.max(0, Number(document.fileSize) || 0)
  const now = Date.now()
  const literatureId = String(
    document.literatureId ||
    document.documentId ||
    document.id ||
    createDocumentId(filePath, fileName, fileSize),
  ).trim()

  if (!literatureId || !fileName) return null

  const status = document.status === LITERATURE_STATUS_RECYCLED
    ? LITERATURE_STATUS_RECYCLED
    : LITERATURE_STATUS_ACTIVE
  const rawFolderId = document.folderId ? String(document.folderId) : null
  const previousFolderId = document.previousFolderId ? String(document.previousFolderId) : null
  const createdAt = Number(document.createdAt || document.importedAt) || now

  return {
    id: literatureId,
    literatureId,
    documentId: literatureId,
    filePath,
    fileName,
    displayName: String(document.displayName || fileName).trim() || fileName,
    fingerprint: String(document.fingerprint || '').trim(),
    fileSize,
    folderId: status === LITERATURE_STATUS_ACTIVE ? rawFolderId : null,
    previousFolderId: status === LITERATURE_STATUS_RECYCLED ? (previousFolderId || rawFolderId) : previousFolderId,
    status,
    recycledAt: status === LITERATURE_STATUS_RECYCLED ? (Number(document.recycledAt) || now) : null,
    importedAt: Number(document.importedAt) || createdAt,
    createdAt,
    updatedAt: Number(document.updatedAt) || now,
    order: Number.isFinite(Number(document.order))
      ? Number(document.order)
      : Number.isFinite(Number(document.sortOrder))
        ? Number(document.sortOrder)
        : index,
  }
}

function normalizeLibraryData(data = {}) {
  const rawFolders = Array.isArray(data.folders) ? data.folders : []
  const legacyFolderByDocumentId = new Map()
  rawFolders.forEach((folder) => {
    const folderId = String(folder?.id || '')
    if (!folderId) return
    ;(Array.isArray(folder.documentIds) ? folder.documentIds : []).forEach((documentId) => {
      legacyFolderByDocumentId.set(String(documentId), folderId)
    })
  })

  const folders = rawFolders.map(normalizeLibraryFolder).filter(Boolean)
  const folderIds = new Set(folders.map((folder) => folder.id))
  const normalizedFolders = folders.map((folder) => ({
    ...folder,
    parentId: folder.parentId && folderIds.has(folder.parentId) && folder.parentId !== folder.id
      ? folder.parentId
      : null,
  }))
  const parentById = new Map(normalizedFolders.map((folder) => [folder.id, folder.parentId]))
  normalizedFolders.forEach((folder) => {
    const visited = new Set([folder.id])
    let parentId = folder.parentId
    while (parentId) {
      if (visited.has(parentId)) {
        folder.parentId = null
        parentById.set(folder.id, null)
        break
      }
      visited.add(parentId)
      parentId = parentById.get(parentId) || null
    }
  })

  const seenDocuments = new Set()
  const documents = (Array.isArray(data.documents) ? data.documents : [])
    .map((document, index) => normalizeLibraryDocument({
      ...document,
      folderId: document?.folderId || legacyFolderByDocumentId.get(String(document?.documentId || document?.literatureId || document?.id || '')) || null,
    }, index))
    .filter(Boolean)
    .map((document) => ({
      ...document,
      folderId: document.status === LITERATURE_STATUS_ACTIVE && folderIds.has(document.folderId) ? document.folderId : null,
      previousFolderId: folderIds.has(document.previousFolderId) ? document.previousFolderId : null,
    }))
    .filter((document) => {
      if (seenDocuments.has(document.literatureId)) return false
      seenDocuments.add(document.literatureId)
      return true
    })

  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    migrationVersion: String(data.migrationVersion || ''),
    folders: normalizedFolders.sort((a, b) => {
      if (a.parentId !== b.parentId) return String(a.parentId || '').localeCompare(String(b.parentId || ''))
      return a.order - b.order || a.createdAt - b.createdAt
    }),
    documents: documents.sort((a, b) => a.order - b.order || b.importedAt - a.importedAt),
  }
}

function normalizeSessionResult(result) {
  if (!result || typeof result !== 'object') return null

  const type = String(result.type || '')
  if (!HISTORY_TYPES.has(type)) return null

  const normalized = {
    type,
    title: typeof result.title === 'string' ? result.title : '',
    pageNumber: Number.isFinite(Number(result.pageNumber)) ? Number(result.pageNumber) : undefined,
    selectedText: typeof result.selectedText === 'string' ? result.selectedText : undefined,
    translation: typeof result.translation === 'string' ? result.translation : undefined,
    ocrText: typeof result.ocrText === 'string' ? result.ocrText : undefined,
    screenshotDataUrl: typeof result.screenshotDataUrl === 'string' ? result.screenshotDataUrl : undefined,
    diagramResultImage: typeof result.diagramResultImage === 'string' ? result.diagramResultImage : undefined,
    compareOriginalImage: typeof result.compareOriginalImage === 'string' ? result.compareOriginalImage : undefined,
    compareTranslatedImage: typeof result.compareTranslatedImage === 'string' ? result.compareTranslatedImage : undefined,
    compareLayout: result.compareLayout === 'vertical' ? 'vertical' : result.compareLayout === 'horizontal' ? 'horizontal' : undefined,
    timestamp: Number.isFinite(Number(result.timestamp)) ? Number(result.timestamp) : undefined,
  }

  if (result.ocrSelectionRect && typeof result.ocrSelectionRect === 'object') {
    normalized.ocrSelectionRect = result.ocrSelectionRect
  }

  return normalized
}

function normalizeSessionOcrResult(result) {
  if (!result || typeof result !== 'object') return null

  return {
    status: typeof result.status === 'string' ? result.status : 'idle',
    mode: typeof result.mode === 'string' ? result.mode : 'sidebar',
    image: typeof result.image === 'string' ? result.image : '',
    text: typeof result.text === 'string' ? result.text : '',
    translation: typeof result.translation === 'string' ? result.translation : '',
    error: typeof result.error === 'string' ? result.error : '',
  }
}

function normalizePdfSessionTab(tab = {}) {
  const filePath = String(tab.filePath || tab.document?.filePath || '').trim()
  const fileName = String(tab.fileName || tab.document?.fileName || (filePath ? path.basename(filePath) : '')).trim()
  const fileSize = Math.max(0, Number(tab.fileSize || tab.document?.fileSize) || 0)

  if (!filePath || !fileName) return null

  const documentId = String(tab.documentId || tab.document?.documentId || createDocumentId(filePath, fileName, fileSize))
  const currentPage = Math.max(1, Number(tab.currentPage) || Number(tab.lastPage) || 1)
  const totalPages = Number(tab.totalPages)
  const scale = Math.min(300, Math.max(50, Number(tab.scale) || 100))
  const scrollTop = Math.max(0, Number(tab.scrollTop) || 0)
  const openedAt = Number(tab.openedAt || Date.now())
  const updatedAt = Number(tab.updatedAt || openedAt)

  return {
    id: String(tab.id || documentId),
    documentId,
    filePath,
    fileName,
    fileSize,
    currentPage,
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null,
    scale,
    scrollTop,
    rightPanelResult: normalizeSessionResult(tab.rightPanelResult),
    ocrResult: normalizeSessionOcrResult(tab.ocrResult),
    rightPanelTab: ['result', 'history', 'notes', 'bookmarks'].includes(tab.rightPanelTab) ? tab.rightPanelTab : 'result',
    rightPanelVisible: tab.rightPanelVisible !== false,
    openedAt: Number.isFinite(openedAt) ? openedAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }
}

function normalizePdfSession(session = {}) {
  const tabs = Array.isArray(session.tabs)
    ? session.tabs.map(normalizePdfSessionTab).filter(Boolean)
    : []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const activeTabId = tabIds.has(String(session.activeTabId || ''))
    ? String(session.activeTabId)
    : tabs[0]?.id || ''

  return {
    schemaVersion: 1,
    activeTabId,
    tabs,
    updatedAt: Number(session.updatedAt) || Date.now(),
  }
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
    literatureId: documentId,
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
    literatureId: documentId,
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
    literatureId: documentId,
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
      highlightId: typeof item.highlightId === 'string' ? item.highlightId : base.id,
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

function normalizeBookmarkItem(item = {}) {
  if (!item || typeof item !== 'object') return null

  const documentId = String(item.documentId || '').trim()
  const pageNumber = Math.floor(Number(item.pageNumber))
  const title = String(item.title || '').replace(/\s+/g, ' ').trim()
  if (!documentId || !Number.isFinite(pageNumber) || pageNumber < 1 || !title) return null

  const now = Date.now()
  const createdAt = Number(item.createdAt || now)
  const updatedAt = Number(item.updatedAt || createdAt)

  return {
    id: String(item.id || `${pageNumber}-${createdAt}-${Math.random().toString(36).slice(2, 8)}`),
    documentId,
    literatureId: documentId,
    filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
    fileName: typeof item.fileName === 'string' ? item.fileName : undefined,
    pageNumber,
    title: title.slice(0, 120),
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
  }
}

function normalizeBookmarkItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .map(normalizeBookmarkItem)
    .filter(Boolean)
    .sort((a, b) => a.pageNumber - b.pageNumber || b.updatedAt - a.updatedAt)
}

function normalizeDocumentBookmarks(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

  return Object.fromEntries(
    Object.entries(data)
      .map(([documentId, value]) => {
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const filePath = typeof container.filePath === 'string' ? container.filePath : ''
        const fileName = typeof container.fileName === 'string' ? container.fileName : ''
        const items = normalizeBookmarkItems(Array.isArray(container.items) ? container.items : [])
          .map((item) => normalizeBookmarkItem({
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

function normalizeTocItem(item = {}, inheritedLevel = 1, index = 0) {
  if (!item || typeof item !== 'object') return null

  const title = String(item.title || '').replace(/\s+/g, ' ').trim()
  const legacyPageNumber = Math.floor(Number(item.pageStart ?? item.pageNumber ?? item.page) || 1)
  const rawPageIndex = Number(item.pageIndex)
  const pageIndex = Number.isFinite(rawPageIndex)
    ? Math.max(0, Math.floor(rawPageIndex))
    : Math.max(0, legacyPageNumber - 1)
  const level = Math.max(1, Math.min(3, Math.floor(Number(item.level) || inheritedLevel)))
  const confidence = Number(item.confidence)
  const rawChildren = Array.isArray(item.children)
    ? item.children
    : Array.isArray(item.subsections)
      ? item.subsections
      : []
  if (!title) return null

  return {
    id: String(item.id || `toc-${pageIndex}-${level}-${index}`),
    title: title.slice(0, 180),
    level,
    pageNumber: pageIndex + 1,
    pageIndex,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.75,
    children: rawChildren
      .map((child, childIndex) => normalizeTocItem(child, Math.min(3, level + 1), childIndex))
      .filter(Boolean),
  }
}

function normalizeTocItems(items) {
  if (!Array.isArray(items)) return []

  return items
    .map((item, index) => normalizeTocItem(item, 1, index))
    .filter(Boolean)
    .sort((a, b) => a.pageIndex - b.pageIndex)
}

function normalizeTocFingerprint(fingerprint = {}, fallback = {}) {
  const source = fingerprint && typeof fingerprint === 'object' && !Array.isArray(fingerprint)
    ? fingerprint
    : {}
  return {
    filePath: String(source.filePath || fallback.filePath || ''),
    fileSize: Math.max(0, Number(source.fileSize ?? fallback.fileSize) || 0),
    modifiedTime: Math.max(0, Number(source.modifiedTime ?? fallback.modifiedTime) || 0),
    fileHash: String(source.fileHash || fallback.fileHash || ''),
  }
}

function normalizeDocumentTableOfContents(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}

  return Object.fromEntries(
    Object.entries(data)
      .map(([documentId, value]) => {
        const container = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
        const filePath = typeof container.filePath === 'string' ? container.filePath : ''
        const fileName = typeof container.fileName === 'string' ? container.fileName : ''
        const source = ['native', 'toc-page', 'toc-page-ai', 'body', 'body-ai', 'ocr-ai', 'ocr', 'unavailable'].includes(container.source)
          ? container.source
          : 'unavailable'
        const documentType = ['paper', 'book', 'unknown'].includes(container.documentType)
          ? container.documentType
          : 'unknown'
        const pageOffset = Number(container.pageOffset)
        const items = normalizeTocItems(container.items)

        if (!items.length && !filePath && !fileName) return null

        return [documentId, {
          filePath,
          fileName,
          lastUpdatedAt: Number(container.lastUpdatedAt) || 0,
          source,
          version: Number(container.version || container.algorithmVersion) || 0,
          documentType,
          pageOffset: Number.isFinite(pageOffset) ? pageOffset : null,
          userModified: container.userModified === true,
          fingerprint: normalizeTocFingerprint(container.fingerprint, {
            filePath,
            fileSize: container.fileSize,
            modifiedTime: container.modifiedTime,
            fileHash: container.fileHash,
          }),
          items,
        }]
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
    return normalizeConfig(await readJsonFileWithRecovery(getConfigPath(), DEFAULT_CONFIG, 'config'))
  } catch (error) {
    throw new Error(`读取配置失败：${error.message}`, { cause: error })
  }
}

async function saveConfig(config) {
  try {
    const nextConfig = normalizeConfig(config)
    await writeJsonFileAtomic(getConfigPath(), nextConfig)
    return nextConfig
  } catch (error) {
    throw new Error(`保存配置失败：${error.message}`, { cause: error })
  }
}

async function readGlossary() {
  try {
    return normalizeGlossaryEntries(await readJsonFileWithRecovery(getGlossaryPath(), [], 'glossary'))
  } catch (error) {
    throw new Error(`读取术语库失败：${error.message}`, { cause: error })
  }
}

async function saveGlossary(glossary) {
  const nextGlossary = normalizeGlossaryEntries(glossary)
  await writeJsonFileAtomic(getGlossaryPath(), nextGlossary)
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
    return normalizeHistoryItems(await readJsonFileWithRecovery(getHistoryPath(), [], 'translation history'))
  } catch (error) {
    throw new Error(`读取翻译历史失败：${error.message}`, { cause: error })
  }
}

async function saveHistory(history) {
  const nextHistory = normalizeHistoryItems(history)
  await writeJsonFileAtomic(getHistoryPath(), nextHistory)
  return nextHistory
}

async function clearHistory() {
  await saveHistory([])
  return []
}

async function readBrowsingHistory() {
  try {
    return normalizeBrowsingHistory(
      await readJsonFileWithRecovery(getBrowsingHistoryPath(), [], 'browsing history'),
    )
  } catch (error) {
    throw new Error(`读取最近打开记录失败：${error.message}`, { cause: error })
  }
}

async function saveBrowsingHistory(history) {
  const nextHistory = normalizeBrowsingHistory(history)
  await writeJsonFileAtomic(getBrowsingHistoryPath(), nextHistory)
  await pruneDocumentTranslationHistories(nextHistory)
  return nextHistory
}

async function readPdfSession() {
  try {
    return normalizePdfSession(await readJsonFileWithRecovery(getPdfSessionPath(), {}, 'PDF session'))
  } catch (error) {
    throw new Error(`璇诲彇 PDF 浼氳瘽澶辫触锛?{error.message}`, { cause: error })
  }
}

async function savePdfSession(session = {}) {
  const nextSession = normalizePdfSession({
    ...session,
    updatedAt: Date.now(),
  })

  await writeJsonFileAtomic(getPdfSessionPath(), nextSession)

  return nextSession
}

async function updateBrowsingRecord(record) {
  return runStorageMutation(getBrowsingHistoryPath(), async () => {
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
  })
}

async function deleteBrowsingRecord(id) {
  return runStorageMutation(getBrowsingHistoryPath(), async () => {
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
  })
}

async function clearBrowsingHistory() {
  return runStorageMutation(getBrowsingHistoryPath(), async () => {
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
  })
}

async function readDocumentTranslationHistories() {
  try {
    return normalizeDocumentTranslationHistories(
      await readJsonFileWithRecovery(getDocumentTranslationHistoryPath(), {}, 'document translation history'),
    )
  } catch (error) {
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

  await writeJsonFileAtomic(getDocumentTranslationHistoryPath(), nextData)
  return nextData
}

async function pruneDocumentTranslationHistories(recentBrowsingRecords) {
  const histories = await readDocumentTranslationHistories()
  const recentDocumentIds = new Set(normalizeBrowsingHistory(recentBrowsingRecords).map((record) => record.documentId))
  const nextHistories = Object.fromEntries(
    Object.entries(histories).filter(([documentId]) => recentDocumentIds.has(documentId)),
  )

  await writeJsonFileAtomic(getDocumentTranslationHistoryPath(), nextHistories)
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
    return normalizeDocumentNotes(await readJsonFileWithRecovery(getNotesPath(), {}, 'document notes'))
  } catch (error) {
    throw new Error(`读取文献笔记失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentNotesData(data) {
  const nextData = normalizeDocumentNotes(data)
  await writeJsonFileAtomic(getNotesPath(), nextData)
  return nextData
}

async function readDocumentBookmarks() {
  try {
    return normalizeDocumentBookmarks(await readJsonFileWithRecovery(getBookmarksPath(), {}, 'document bookmarks'))
  } catch (error) {
    throw new Error(`读取文献书签失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentBookmarksData(data) {
  const nextData = normalizeDocumentBookmarks(data)
  await writeJsonFileAtomic(getBookmarksPath(), nextData)
  return nextData
}

async function readDocumentTableOfContents() {
  try {
    return normalizeDocumentTableOfContents(
      await readJsonFileWithRecovery(getTableOfContentsPath(), {}, 'document table of contents'),
    )
  } catch (error) {
    throw new Error(`读取文献目录失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentTableOfContentsData(data) {
  const nextData = normalizeDocumentTableOfContents(data)
  await writeJsonFileAtomic(getTableOfContentsPath(), nextData)
  return nextData
}

async function readDocumentAnnotations() {
  try {
    return normalizeDocumentAnnotations(
      await readJsonFileWithRecovery(getAnnotationsPath(), {}, 'document annotations'),
    )
  } catch (error) {
    throw new Error(`读取文献批注失败：${error.message}`, { cause: error })
  }
}

async function saveDocumentAnnotationsData(data) {
  const nextData = normalizeDocumentAnnotations(data)
  await writeJsonFileAtomic(getAnnotationsPath(), nextData)
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

  if (deletedAnnotation?.type === 'text-highlight') {
    const notes = await readDocumentNotes()
    if (notes[documentId]) {
      notes[documentId].items = normalizeNoteItems(notes[documentId].items || [])
        .map((item) => (
          item.id === deletedAnnotation.noteId ||
          item.highlightId === deletedAnnotation.id ||
          item.highlightId === deletedAnnotation.highlightId
            ? { ...item, highlightId: undefined, updatedAt: Date.now() }
            : item
        ))
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

async function getDocumentBookmarks(documentId) {
  const bookmarks = await readDocumentBookmarks()
  return normalizeBookmarkItems(bookmarks[documentId]?.items || [])
}

async function saveDocumentBookmarks(documentId, payload = {}) {
  const bookmarks = await readDocumentBookmarks()
  const current = bookmarks[documentId] || {}
  const filePath = String(payload.filePath || current.filePath || '')
  const fileName = String(payload.fileName || current.fileName || '')
  const items = normalizeBookmarkItems(payload.items || [])
    .map((item) => normalizeBookmarkItem({ ...item, documentId, filePath: item.filePath || filePath, fileName: item.fileName || fileName }))
    .filter(Boolean)

  bookmarks[documentId] = {
    filePath,
    fileName,
    lastUpdatedAt: Date.now(),
    items,
  }

  const savedBookmarks = await saveDocumentBookmarksData(bookmarks)
  return savedBookmarks[documentId]?.items || []
}

async function addDocumentBookmark(bookmark) {
  const normalizedBookmark = normalizeBookmarkItem({
    ...bookmark,
    id: bookmark?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    createdAt: bookmark?.createdAt || Date.now(),
    updatedAt: bookmark?.updatedAt || Date.now(),
  })

  if (!normalizedBookmark) return []

  const currentBookmarks = await getDocumentBookmarks(normalizedBookmark.documentId)
  return saveDocumentBookmarks(normalizedBookmark.documentId, {
    filePath: normalizedBookmark.filePath,
    fileName: normalizedBookmark.fileName,
    items: [normalizedBookmark, ...currentBookmarks.filter((item) => item.id !== normalizedBookmark.id)],
  })
}

async function deleteDocumentBookmark(documentId, bookmarkId) {
  const bookmarks = await readDocumentBookmarks()
  const current = bookmarks[documentId]

  if (!current) return []

  current.items = normalizeBookmarkItems(current.items || []).filter((item) => item.id !== bookmarkId)
  current.lastUpdatedAt = Date.now()
  bookmarks[documentId] = current
  const savedBookmarks = await saveDocumentBookmarksData(bookmarks)
  return savedBookmarks[documentId]?.items || []
}

async function clearDocumentBookmarks(documentId) {
  const bookmarks = await readDocumentBookmarks()

  if (bookmarks[documentId]) {
    bookmarks[documentId] = {
      ...bookmarks[documentId],
      lastUpdatedAt: Date.now(),
      items: [],
    }
    await saveDocumentBookmarksData(bookmarks)
  }

  return []
}

async function getDocumentTableOfContents(documentId) {
  const tableOfContents = await readDocumentTableOfContents()
  const current = tableOfContents[documentId] || {}

  return {
    source: current.source || 'unavailable',
    version: Number(current.version) || 0,
    documentType: current.documentType || 'unknown',
    pageOffset: Number.isFinite(current.pageOffset) ? current.pageOffset : null,
    userModified: current.userModified === true,
    fingerprint: normalizeTocFingerprint(current.fingerprint, current),
    items: normalizeTocItems(current.items),
    lastUpdatedAt: Number(current.lastUpdatedAt) || 0,
  }
}

async function saveDocumentTableOfContents(documentId, payload = {}) {
  const tableOfContents = await readDocumentTableOfContents()
  const current = tableOfContents[documentId] || {}

  tableOfContents[documentId] = {
    filePath: String(payload.filePath || current.filePath || ''),
    fileName: String(payload.fileName || current.fileName || ''),
    lastUpdatedAt: Date.now(),
    source: ['native', 'toc-page', 'toc-page-ai', 'body', 'body-ai', 'ocr-ai', 'ocr', 'unavailable'].includes(payload.source)
      ? payload.source
      : current.source || 'unavailable',
    version: Number(payload.version || payload.algorithmVersion) || Number(current.version) || 0,
    documentType: ['paper', 'book', 'unknown'].includes(payload.documentType)
      ? payload.documentType
      : current.documentType || 'unknown',
    pageOffset: Number.isFinite(payload.pageOffset)
      ? payload.pageOffset
      : Number.isFinite(current.pageOffset)
        ? current.pageOffset
        : null,
    userModified: payload.userModified === true,
    fingerprint: normalizeTocFingerprint(payload.fingerprint, {
      filePath: payload.filePath || current.filePath,
      fileSize: payload.fileSize,
      modifiedTime: payload.modifiedTime,
      fileHash: payload.fileHash,
    }),
    items: normalizeTocItems(payload.items),
  }

  const savedTableOfContents = await saveDocumentTableOfContentsData(tableOfContents)
  return savedTableOfContents[documentId] || { source: 'unavailable', version: 0, items: [], lastUpdatedAt: 0 }
}

async function readLibraryData() {
  try {
    const rawLibrary = await readJsonFileWithRecovery(getLibraryPath(), {}, 'library')
    const library = normalizeLibraryData(rawLibrary)

    if (
      Number(rawLibrary?.schemaVersion) >= LIBRARY_SCHEMA_VERSION &&
      rawLibrary?.migrationVersion === LIBRARY_MIGRATION_VERSION
    ) {
      return library
    }

    const [histories, notes, annotations, bookmarks, browsingHistory] = await Promise.all([
      readDocumentTranslationHistories(),
      readDocumentNotes(),
      readDocumentAnnotations(),
      readDocumentBookmarks(),
      readBrowsingHistory(),
    ])
    const documentsById = new Map(library.documents.map((document) => [document.literatureId, document]))
    const browsingById = new Map(browsingHistory.map((record) => [record.documentId, record]))
    const recordSources = [histories, notes, annotations, bookmarks]
    const recordIds = new Set([
      ...recordSources.flatMap((source) => Object.keys(source)),
      ...browsingHistory.map((record) => record.documentId),
    ])
    const literatureIdMap = new Map()

    recordIds.forEach((sourceLiteratureId) => {
      if (!sourceLiteratureId) return

      const containers = recordSources.map((source) => source[sourceLiteratureId] || {})
      const browsingRecord = browsingById.get(sourceLiteratureId) || {}
      const filePath = String(
        browsingRecord.filePath || containers.find((container) => container.filePath)?.filePath || '',
      ).trim()
      const fileName = String(
        browsingRecord.fileName ||
        containers.find((container) => container.fileName)?.fileName ||
        (filePath ? path.basename(filePath) : sourceLiteratureId),
      ).trim()
      const matched = findMatchingLiterature(Array.from(documentsById.values()), {
        literatureId: sourceLiteratureId,
        filePath,
        fileName,
        fileSize: browsingRecord.fileSize,
      })
      if (matched) {
        literatureIdMap.set(sourceLiteratureId, matched.literatureId)
        return
      }
      const migrated = normalizeLibraryDocument({
        literatureId: sourceLiteratureId,
        filePath,
        fileName,
        fileSize: browsingRecord.fileSize,
        status: LITERATURE_STATUS_ACTIVE,
        folderId: null,
        createdAt: browsingRecord.createdAt || browsingRecord.lastOpenedAt,
        updatedAt: Math.max(
          Number(browsingRecord.lastOpenedAt) || 0,
          ...containers.map((container) => Number(container.lastUpdatedAt || container.lastOpenedAt) || 0),
        ),
        order: documentsById.size,
      })
      if (migrated) {
        documentsById.set(migrated.literatureId, migrated)
        literatureIdMap.set(sourceLiteratureId, migrated.literatureId)
      }
    })

    const migratedLibrary = normalizeLibraryData({
      ...library,
      migrationVersion: LIBRARY_MIGRATION_VERSION,
      documents: Array.from(documentsById.values()),
    })
    migratedLibrary.migrationVersion = LIBRARY_MIGRATION_VERSION

    const migrationTimestamp = Date.now()
    const migrationPaths = [
      getLibraryPath(),
      getDocumentTranslationHistoryPath(),
      getNotesPath(),
      getAnnotationsPath(),
      getBookmarksPath(),
      getBrowsingHistoryPath(),
    ]
    await Promise.all(migrationPaths.map((filePath) => backupMigrationFile(filePath, migrationTimestamp)))
    await writeJsonFileAtomic(
      getDocumentTranslationHistoryPath(),
      remapDocumentContainers(histories, literatureIdMap, normalizeDocumentTranslationHistories),
    )
    await writeJsonFileAtomic(
      getNotesPath(),
      remapDocumentContainers(notes, literatureIdMap, normalizeDocumentNotes),
    )
    await writeJsonFileAtomic(
      getAnnotationsPath(),
      remapDocumentContainers(annotations, literatureIdMap, normalizeDocumentAnnotations),
    )
    await writeJsonFileAtomic(
      getBookmarksPath(),
      remapDocumentContainers(bookmarks, literatureIdMap, normalizeDocumentBookmarks),
    )
    await writeJsonFileAtomic(
      getBrowsingHistoryPath(),
      normalizeBrowsingHistory(browsingHistory.map((record) => ({
        ...record,
        documentId: literatureIdMap.get(record.documentId) || record.documentId,
      }))),
    )
    await writeJsonFileAtomic(getLibraryPath(), migratedLibrary)
    return migratedLibrary
  } catch (error) {
    throw new Error(`读取文献库失败：${error.message}`, { cause: error })
  }
}

async function saveLibraryData(data) {
  const nextData = normalizeLibraryData(data)
  await writeJsonFileAtomic(getLibraryPath(), nextData)
  return nextData
}

function runLibraryMutation(operation) {
  return runStorageMutation(getLibraryPath(), operation)
}

function remapDocumentContainers(data, literatureIdMap, normalizer) {
  const merged = {}
  Object.entries(data).forEach(([sourceId, container]) => {
    const literatureId = literatureIdMap.get(sourceId) || sourceId
    const current = merged[literatureId] || {}
    const seenItems = new Set()
    const items = [...(current.items || []), ...(container.items || [])]
      .map((item) => ({ ...item, documentId: literatureId, literatureId }))
      .filter((item) => {
        const key = String(item.id || JSON.stringify(item))
        if (seenItems.has(key)) return false
        seenItems.add(key)
        return true
      })
    merged[literatureId] = {
      ...container,
      ...current,
      filePath: current.filePath || container.filePath || '',
      fileName: current.fileName || container.fileName || '',
      lastOpenedAt: Math.max(Number(current.lastOpenedAt) || 0, Number(container.lastOpenedAt) || 0),
      lastUpdatedAt: Math.max(Number(current.lastUpdatedAt) || 0, Number(container.lastUpdatedAt) || 0),
      items,
    }
  })
  return normalizer(merged)
}

async function backupMigrationFile(filePath, migrationTimestamp) {
  try {
    const stat = await fs.stat(filePath)
    if (stat.isFile()) {
      await fs.copyFile(filePath, `${filePath}.pre-${LIBRARY_MIGRATION_VERSION}-${migrationTimestamp}.bak`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

function getNormalizedPathKey(filePath = '') {
  const normalizedPath = String(filePath || '').trim()
  return normalizedPath ? path.normalize(normalizedPath).toLowerCase() : ''
}

function findMatchingLiterature(documents, candidate = {}) {
  const literatureId = String(candidate.literatureId || candidate.documentId || candidate.id || '').trim()
  if (literatureId) {
    const byId = documents.find((document) => document.literatureId === literatureId)
    if (byId) return byId
  }

  const fingerprint = String(candidate.fingerprint || '').trim()
  if (fingerprint) {
    const byFingerprint = documents.find((document) => document.fingerprint && document.fingerprint === fingerprint)
    if (byFingerprint) return byFingerprint
  }

  const filePathKey = getNormalizedPathKey(candidate.filePath)
  if (filePathKey) {
    const byPath = documents.find((document) => getNormalizedPathKey(document.filePath) === filePathKey)
    if (byPath) return byPath
  }

  const fileName = String(candidate.fileName || '').trim().toLowerCase()
  const fileSize = Math.max(0, Number(candidate.fileSize) || 0)
  if (fileName && fileSize) {
    const byNameAndSize = documents.find((document) => (
      document.fileName.toLowerCase() === fileName && Number(document.fileSize) === fileSize
    ))
    if (byNameAndSize) return byNameAndSize
  }

  if (fileName) {
    const byName = documents.filter((document) => document.fileName.toLowerCase() === fileName)
    if (byName.length === 1 && !filePathKey && !fileSize) return byName[0]
  }

  return null
}

async function createFileFingerprint(filePath, fileSize = 0) {
  const normalizedPath = String(filePath || '').trim()
  if (!normalizedPath) return ''

  const handle = await fs.open(normalizedPath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return ''
    const chunkSize = Math.min(64 * 1024, stat.size)
    const firstChunk = Buffer.alloc(chunkSize)
    const lastChunk = Buffer.alloc(chunkSize)
    if (chunkSize) {
      await handle.read(firstChunk, 0, chunkSize, 0)
      await handle.read(lastChunk, 0, chunkSize, Math.max(0, stat.size - chunkSize))
    }
    return crypto
      .createHash('sha256')
      .update(String(fileSize || stat.size))
      .update(firstChunk)
      .update(lastChunk)
      .digest('hex')
  } finally {
    await handle.close()
  }
}

async function getEnrichedLibrary() {
  const [library, browsingHistory, histories, notes, annotations, bookmarks] = await Promise.all([
    readLibraryData(),
    readBrowsingHistory(),
    readDocumentTranslationHistories(),
    readDocumentNotes(),
    readDocumentAnnotations(),
    readDocumentBookmarks(),
  ])
  const browsingByDocumentId = new Map(browsingHistory.map((record) => [record.documentId, record]))
  const enrichedDocuments = library.documents.map((document) => {
    const literatureId = document.literatureId
    const browsingRecord = browsingByDocumentId.get(literatureId)
    const historyItems = normalizeHistoryItems(histories[literatureId]?.items || [])
    const noteItems = normalizeNoteItems(notes[literatureId]?.items || [])
    const annotationItems = normalizeAnnotationItems(annotations[literatureId]?.items || [])
    const bookmarkItems = normalizeBookmarkItems(bookmarks[literatureId]?.items || [])

    return {
      ...document,
      totalPages: browsingRecord?.totalPages || null,
      lastPage: browsingRecord?.lastPage || 1,
      scale: browsingRecord?.scale || 100,
      lastOpenedAt: browsingRecord?.lastOpenedAt || null,
      historyCount: historyItems.length,
      notesCount: noteItems.length,
      annotationsCount: annotationItems.length,
      bookmarksCount: bookmarkItems.length,
      recordCount: historyItems.length + noteItems.length + annotationItems.length + bookmarkItems.length,
    }
  })

  return {
    schemaVersion: library.schemaVersion,
    migrationVersion: library.migrationVersion,
    folders: library.folders,
    documents: enrichedDocuments.filter((document) => document.status === LITERATURE_STATUS_ACTIVE),
    literatures: enrichedDocuments,
    recycledDocuments: enrichedDocuments
      .filter((document) => document.status === LITERATURE_STATUS_RECYCLED)
      .sort((a, b) => (b.recycledAt || 0) - (a.recycledAt || 0)),
  }
}

async function upsertLibraryDocument(document = {}) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    let fingerprint = String(document.fingerprint || '').trim()
    if (!fingerprint && document.filePath) {
      try {
        fingerprint = await createFileFingerprint(document.filePath, document.fileSize)
      } catch {
        fingerprint = ''
      }
    }
    const normalizedDocument = normalizeLibraryDocument({ ...document, fingerprint })

    if (!normalizedDocument) {
      throw new Error('无法添加文献到文献库')
    }

    const existing = findMatchingLiterature(library.documents, normalizedDocument)
    const nextDocument = existing
      ? {
          ...existing,
          ...normalizedDocument,
          id: existing.literatureId,
          literatureId: existing.literatureId,
          documentId: existing.literatureId,
          status: existing.status,
          folderId: existing.status === LITERATURE_STATUS_ACTIVE ? existing.folderId : null,
          previousFolderId: existing.previousFolderId,
          recycledAt: existing.recycledAt,
          importedAt: existing.importedAt || normalizedDocument.importedAt,
          order: existing.order,
          updatedAt: Date.now(),
        }
      : {
          ...normalizedDocument,
          folderId: null,
          status: LITERATURE_STATUS_ACTIVE,
          order: library.documents.length,
          updatedAt: Date.now(),
        }
    const nextDocuments = existing
      ? library.documents.map((item) => (item.literatureId === existing.literatureId ? nextDocument : item))
      : [nextDocument, ...library.documents]

    await saveLibraryData({ ...library, documents: nextDocuments })
    return getEnrichedLibrary()
  })
}

async function importLibraryPdfs() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入文献到文献库',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })

  if (result.canceled || !result.filePaths.length) {
    return { canceled: true, ...(await getEnrichedLibrary()) }
  }

  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const nextDocuments = [...library.documents]

    for (const filePath of result.filePaths) {
      const stat = await fs.stat(filePath)

      if (!stat.isFile()) continue

      const normalizedPath = String(filePath || '').trim()
      const fileName = path.basename(normalizedPath)
      const fileSize = stat.size
      const documentId = await resolveDocumentIdForPdf(normalizedPath, fileName, fileSize)
      const fingerprint = await createFileFingerprint(normalizedPath, fileSize)
      const existing = findMatchingLiterature(nextDocuments, {
        literatureId: documentId,
        filePath: normalizedPath,
        fileName,
        fileSize,
        fingerprint,
      })
      const literatureId = existing?.literatureId || documentId
      const nextDocument = normalizeLibraryDocument({
        ...(existing || {}),
        id: literatureId,
        literatureId,
        documentId: literatureId,
        filePath: normalizedPath,
        fileName,
        displayName: existing?.displayName || fileName,
        fingerprint,
        fileSize,
        folderId: existing?.folderId || null,
        status: existing?.status || LITERATURE_STATUS_ACTIVE,
        previousFolderId: existing?.previousFolderId || null,
        recycledAt: existing?.recycledAt || null,
        importedAt: existing?.importedAt || Date.now(),
        updatedAt: Date.now(),
        order: existing?.order ?? nextDocuments.length,
      })
      if (existing) {
        const existingIndex = nextDocuments.findIndex((document) => document.literatureId === existing.literatureId)
        nextDocuments.splice(existingIndex, 1, nextDocument)
      } else {
        nextDocuments.push(nextDocument)
      }
    }

    await saveLibraryData({ ...library, documents: nextDocuments })
    return { canceled: false, ...(await getEnrichedLibrary()) }
  })
}

async function createLibraryFolder(input) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const folderInput = typeof input === 'string' ? { name: input } : (input || {})
    const name = folderInput.name
    const normalizedName = String(name || '').trim()
    const parentId = folderInput.parentId && library.folders.some((folder) => folder.id === String(folderInput.parentId))
      ? String(folderInput.parentId)
      : null

    if (!normalizedName) {
      throw new Error('文件夹名称不能为空')
    }

    if (library.folders.some((folder) => (
      folder.parentId === parentId && folder.name.trim().toLowerCase() === normalizedName.toLowerCase()
    ))) {
      throw new Error('已存在同名文件夹')
    }

    const siblingCount = library.folders.filter((folder) => folder.parentId === parentId).length
    const folder = normalizeLibraryFolder({
      name: normalizedName,
      parentId,
      order: siblingCount,
      expanded: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const nextFolders = library.folders.map((item) => (
      item.id === parentId
        ? { ...item, expanded: true, updatedAt: Date.now() }
        : item
    ))

    await saveLibraryData({ ...library, folders: [...nextFolders, folder] })
    return getEnrichedLibrary()
  })
}

async function updateLibraryFolder(folderId, updates = {}) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const normalizedFolderId = String(folderId || '')
    const currentFolder = library.folders.find((folder) => folder.id === normalizedFolderId)
    if (!currentFolder) throw new Error('文件夹不存在')

    let parentId = currentFolder.parentId
    if (Object.hasOwn(updates, 'parentId')) {
      const requestedParentId = updates.parentId ? String(updates.parentId) : null
      if (requestedParentId === normalizedFolderId) throw new Error('不能将文件夹移动到自身')
      if (requestedParentId && !library.folders.some((folder) => folder.id === requestedParentId)) {
        throw new Error('目标文件夹不存在')
      }
      let ancestorId = requestedParentId
      while (ancestorId) {
        if (ancestorId === normalizedFolderId) throw new Error('不能将文件夹移动到其子文件夹')
        ancestorId = library.folders.find((folder) => folder.id === ancestorId)?.parentId || null
      }
      parentId = requestedParentId
    }

    const name = String(updates.name || currentFolder.name).trim() || currentFolder.name
    if (library.folders.some((folder) => (
      folder.id !== normalizedFolderId &&
      folder.parentId === parentId &&
      folder.name.trim().toLowerCase() === name.toLowerCase()
    ))) {
      throw new Error('同一层级已存在同名文件夹')
    }
    const nextFolders = library.folders.map((folder) => (
      folder.id === normalizedFolderId
        ? {
            ...folder,
            name,
            parentId,
            order: Number.isFinite(Number(updates.order)) ? Number(updates.order) : folder.order,
            expanded: typeof updates.expanded === 'boolean'
              ? updates.expanded
              : typeof updates.collapsed === 'boolean'
                ? !updates.collapsed
                : folder.expanded,
            updatedAt: Date.now(),
          }
        : folder
    ))

    await saveLibraryData({ ...library, folders: nextFolders })
    return getEnrichedLibrary()
  })
}

async function reorderLibraryFolder(folderId, targetFolderId, placement = 'before') {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const normalizedFolderId = String(folderId || '')
    const normalizedTargetFolderId = String(targetFolderId || '')
    const current = library.folders.find((folder) => folder.id === normalizedFolderId)
    const target = library.folders.find((folder) => folder.id === normalizedTargetFolderId)
    if (!current) throw new Error('文件夹不存在')
    if (!target) throw new Error('排序目标文件夹不存在')
    if (current.id === target.id) return getEnrichedLibrary()
    if (current.parentId !== target.parentId) {
      throw new Error('只能调整同级文件夹的顺序')
    }

    const siblings = library.folders
      .filter((folder) => folder.parentId === current.parentId)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    const remainingSiblings = siblings.filter((folder) => folder.id !== current.id)
    const targetIndex = remainingSiblings.findIndex((folder) => folder.id === target.id)
    const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
    const reorderedSiblings = [...remainingSiblings]
    reorderedSiblings.splice(insertIndex, 0, current)
    const orderById = new Map(reorderedSiblings.map((folder, index) => [folder.id, index]))
    const updatedAt = Date.now()

    const nextFolders = library.folders.map((folder) => {
      if (orderById.has(folder.id)) {
        return { ...folder, order: orderById.get(folder.id), updatedAt }
      }
      return folder
    })
    await saveLibraryData({ ...library, folders: nextFolders })
    return getEnrichedLibrary()
  })
}

async function moveLibraryFolder(folderId, parentId = null) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const normalizedFolderId = String(folderId || '')
    const current = library.folders.find((folder) => folder.id === normalizedFolderId)
    if (!current) throw new Error('文件夹不存在')

    const requestedParentId = parentId ? String(parentId) : null
    if (requestedParentId === current.id) throw new Error('不能将文件夹移动到自身')
    if (requestedParentId && !library.folders.some((folder) => folder.id === requestedParentId)) {
      throw new Error('目标文件夹不存在')
    }
    if (requestedParentId === current.parentId) {
      throw new Error('文件夹已经位于该层级')
    }

    let ancestorId = requestedParentId
    while (ancestorId) {
      if (ancestorId === current.id) throw new Error('不能将文件夹移动到其子文件夹')
      ancestorId = library.folders.find((folder) => folder.id === ancestorId)?.parentId || null
    }

    if (library.folders.some((folder) => (
      folder.id !== current.id
      && folder.parentId === requestedParentId
      && folder.name.trim().toLowerCase() === current.name.trim().toLowerCase()
    ))) {
      throw new Error('目标层级已存在同名文件夹')
    }

    const sourceSiblings = library.folders
      .filter((folder) => folder.parentId === current.parentId && folder.id !== current.id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    const targetSiblings = library.folders
      .filter((folder) => folder.parentId === requestedParentId && folder.id !== current.id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    const sourceOrderById = new Map(sourceSiblings.map((folder, index) => [folder.id, index]))
    const targetOrderById = new Map(targetSiblings.map((folder, index) => [folder.id, index]))
    const updatedAt = Date.now()

    const nextFolders = library.folders.map((folder) => {
      if (folder.id === current.id) {
        return { ...folder, parentId: requestedParentId, order: targetSiblings.length, updatedAt }
      }
      if (folder.parentId === current.parentId && sourceOrderById.has(folder.id)) {
        return { ...folder, order: sourceOrderById.get(folder.id), updatedAt }
      }
      if (folder.parentId === requestedParentId && targetOrderById.has(folder.id)) {
        return { ...folder, order: targetOrderById.get(folder.id), updatedAt }
      }
      if (folder.id === requestedParentId) {
        return { ...folder, expanded: true, updatedAt }
      }
      return folder
    })

    await saveLibraryData({ ...library, folders: nextFolders })
    return getEnrichedLibrary()
  })
}

async function deleteLibraryFolder(folderId) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const normalizedFolderId = String(folderId || '')
    const folderExists = library.folders.some((folder) => folder.id === normalizedFolderId)

    if (!folderExists) {
      throw new Error('\u6587\u4ef6\u5939\u4e0d\u5b58\u5728')
    }

    const removedFolderIds = new Set([normalizedFolderId])
    let foundChildren = true
    while (foundChildren) {
      foundChildren = false
      library.folders.forEach((folder) => {
        if (folder.parentId && removedFolderIds.has(folder.parentId) && !removedFolderIds.has(folder.id)) {
          removedFolderIds.add(folder.id)
          foundChildren = true
        }
      })
    }

    const nextDocuments = library.documents.map((document) => (
      document.status === LITERATURE_STATUS_ACTIVE && removedFolderIds.has(document.folderId)
        ? { ...document, folderId: '', updatedAt: Date.now() }
        : document
    ))

    await saveLibraryData({
      ...library,
      folders: library.folders.filter((folder) => !removedFolderIds.has(folder.id)),
      documents: nextDocuments,
    })
    return getEnrichedLibrary()
  })
}

async function moveLibraryDocuments(documentIds = [], folderId = '') {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const ids = new Set((Array.isArray(documentIds) ? documentIds : []).map(String))
    const folderIds = new Set(library.folders.map((folder) => folder.id))
    const normalizedFolderId = folderIds.has(String(folderId)) ? String(folderId) : null

    if (!ids.size) return getEnrichedLibrary()

    const nextDocuments = library.documents.map((document) => (
      ids.has(document.literatureId) && document.status === LITERATURE_STATUS_ACTIVE
        ? { ...document, folderId: normalizedFolderId, updatedAt: Date.now() }
        : document
    ))

    await saveLibraryData({ ...library, documents: nextDocuments })
    return getEnrichedLibrary()
  })
}

async function deleteLibraryDocuments(documentIds = []) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const ids = new Set((Array.isArray(documentIds) ? documentIds : []).map(String))

    if (!ids.size) return getEnrichedLibrary()

    const recycledAt = Date.now()
    await saveLibraryData({
      ...library,
      documents: library.documents.map((document) => (
        ids.has(document.literatureId) && document.status === LITERATURE_STATUS_ACTIVE
          ? {
              ...document,
              previousFolderId: document.folderId,
              folderId: null,
              status: LITERATURE_STATUS_RECYCLED,
              recycledAt,
              updatedAt: recycledAt,
            }
        : document
      )),
    })
    await runStorageMutation(getBrowsingHistoryPath(), async () => {
      const browsingHistory = await readBrowsingHistory()
      await writeJsonFileAtomic(
        getBrowsingHistoryPath(),
        normalizeBrowsingHistory(browsingHistory.filter((record) => !ids.has(record.documentId))),
      )
    })
    return getEnrichedLibrary()
  })
}

async function updateLibraryDocument(literatureId, updates = {}) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const normalizedId = String(literatureId || '')
    const current = library.documents.find((document) => document.literatureId === normalizedId)
    if (!current) throw new Error('文献不存在')

    const displayName = String(updates.displayName || updates.fileName || current.displayName || current.fileName).trim()
    const nextDocuments = library.documents.map((document) => (
      document.literatureId === normalizedId
        ? {
            ...document,
            displayName: displayName || document.displayName,
            updatedAt: Date.now(),
          }
        : document
    ))
    await saveLibraryData({ ...library, documents: nextDocuments })
    return getEnrichedLibrary()
  })
}

async function restoreLibraryDocuments(documentIds = []) {
  return runLibraryMutation(async () => {
    const library = await readLibraryData()
    const ids = new Set((Array.isArray(documentIds) ? documentIds : [documentIds]).map(String))
    const folderIds = new Set(library.folders.map((folder) => folder.id))
    const now = Date.now()
    const nextDocuments = library.documents.map((document) => {
      if (!ids.has(document.literatureId) || document.status !== LITERATURE_STATUS_RECYCLED) return document
      return {
        ...document,
        status: LITERATURE_STATUS_ACTIVE,
        folderId: folderIds.has(document.previousFolderId) ? document.previousFolderId : null,
        previousFolderId: null,
        recycledAt: null,
        updatedAt: now,
      }
    })
    await saveLibraryData({ ...library, documents: nextDocuments })
    return getEnrichedLibrary()
  })
}

function omitDocumentContainers(source, ids) {
  return Object.fromEntries(Object.entries(source).filter(([documentId]) => !ids.has(documentId)))
}

async function permanentlyDeleteLibraryDocuments(documentIds = []) {
  return runLibraryMutation(async () => {
    const ids = new Set((Array.isArray(documentIds) ? documentIds : [documentIds]).map(String).filter(Boolean))
    if (!ids.size) return getEnrichedLibrary()

    const [library, histories, notes, annotations, bookmarks, tableOfContents, browsingHistory, pdfSession, globalHistory] = await Promise.all([
      readLibraryData(),
      readDocumentTranslationHistories(),
      readDocumentNotes(),
      readDocumentAnnotations(),
      readDocumentBookmarks(),
      readDocumentTableOfContents(),
      readBrowsingHistory(),
      readPdfSession(),
      readHistory(),
    ])
    const nextLibrary = {
      ...library,
      documents: library.documents.filter((document) => !ids.has(document.literatureId)),
    }
    const nextHistories = omitDocumentContainers(histories, ids)
    const nextNotes = omitDocumentContainers(notes, ids)
    const nextAnnotations = omitDocumentContainers(annotations, ids)
    const nextBookmarks = omitDocumentContainers(bookmarks, ids)
    const nextTableOfContents = omitDocumentContainers(tableOfContents, ids)
    const nextBrowsingHistory = browsingHistory.filter((record) => !ids.has(record.documentId))
    const nextGlobalHistory = globalHistory.filter((item) => !ids.has(String(item.documentId || item.literatureId || '')))
    const nextTabs = (pdfSession.tabs || []).filter((tab) => !ids.has(tab.documentId))
    const nextPdfSession = {
      ...pdfSession,
      tabs: nextTabs,
      activeTabId: nextTabs.some((tab) => tab.id === pdfSession.activeTabId) ? pdfSession.activeTabId : (nextTabs[0]?.id || ''),
    }

    const writes = [
      [getLibraryPath(), normalizeLibraryData(nextLibrary)],
      [getDocumentTranslationHistoryPath(), normalizeDocumentTranslationHistories(nextHistories)],
      [getNotesPath(), normalizeDocumentNotes(nextNotes)],
      [getAnnotationsPath(), normalizeDocumentAnnotations(nextAnnotations)],
      [getBookmarksPath(), normalizeDocumentBookmarks(nextBookmarks)],
      [getTableOfContentsPath(), normalizeDocumentTableOfContents(nextTableOfContents)],
      [getBrowsingHistoryPath(), normalizeBrowsingHistory(nextBrowsingHistory)],
      [getPdfSessionPath(), normalizePdfSession(nextPdfSession)],
      [getHistoryPath(), normalizeHistoryItems(nextGlobalHistory)],
    ]
    const rollbackWrites = [
      [getLibraryPath(), library],
      [getDocumentTranslationHistoryPath(), histories],
      [getNotesPath(), notes],
      [getAnnotationsPath(), annotations],
      [getBookmarksPath(), bookmarks],
      [getTableOfContentsPath(), tableOfContents],
      [getBrowsingHistoryPath(), browsingHistory],
      [getPdfSessionPath(), pdfSession],
      [getHistoryPath(), globalHistory],
    ]

    try {
      for (const [filePath, value] of writes) {
        await writeJsonFileAtomic(filePath, value)
      }
    } catch (error) {
      await Promise.allSettled(rollbackWrites.map(([filePath, value]) => writeJsonFileAtomic(filePath, value)))
      throw new Error(`永久删除失败：${error.message}`, { cause: error })
    }

    return getEnrichedLibrary()
  })
}

async function deleteLiterature(literatureIds, mode = 'recycle') {
  return mode === 'permanent'
    ? permanentlyDeleteLibraryDocuments(literatureIds)
    : deleteLibraryDocuments(literatureIds)
}

function collectDescendantFolderIds(folders, folderId) {
  const ids = new Set(folderId ? [String(folderId)] : [])
  let changed = true
  while (changed) {
    changed = false
    folders.forEach((folder) => {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    })
  }
  return ids
}

function getExportRecordPage(item) {
  return Math.max(1, Number(item?.pageNumber) || 1)
}

function formatMarkdownRecord(item) {
  const page = getExportRecordPage(item)
  const createdAt = Number(item?.createdAt || item?.timestamp || item?.updatedAt) || 0
  const body = String(
    item?.noteText || item?.translation || item?.selectedText || item?.ocrText || item?.title || '',
  ).trim()
  return `- 第 ${page} 页${createdAt ? ` · ${formatExportDateText(new Date(createdAt))}` : ''}${body ? `\n\n  ${body.replace(/\n/g, '\n  ')}` : ''}`
}

function buildLiteratureMarkdown(document, payload, folderPath) {
  const lines = [
    `# ${document.displayName || document.fileName}`,
    '',
    `- 文件夹：${folderPath}`,
    `- 文件名：${document.fileName}`,
    `- 导出时间：${formatExportDateText()}`,
  ]
  if (document.status === LITERATURE_STATUS_RECYCLED) {
    lines.push('- 状态：回收箱')
    lines.push(`- 原文件夹：${folderPath}`)
    lines.push(`- 移入时间：${formatExportDateText(new Date(document.recycledAt || Date.now()))}`)
  }

  const sections = [
    ['笔记', payload.data.notes || []],
    ['翻译记录', payload.data.translationHistory || []],
    ['高亮', (payload.data.annotations || []).filter((item) => item.type === 'text-highlight')],
    ['批注', (payload.data.annotations || []).filter((item) => item.type !== 'text-highlight')],
    ['书签', payload.data.bookmarks || []],
  ]
  sections.forEach(([title, items]) => {
    if (!items.length) return
    lines.push('', `## ${title}`, '')
    items
      .slice()
      .sort((a, b) => getExportRecordPage(a) - getExportRecordPage(b) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      .forEach((item) => lines.push(formatMarkdownRecord(item), ''))
  })
  return `${lines.join('\n').trim()}\n`
}

function filterLiteratureExportPayload(payload, selectedContents) {
  const contents = new Set(Array.isArray(selectedContents) ? selectedContents : [])
  const includeAll = !contents.size
  const annotations = payload.data.annotations || []
  return {
    ...payload,
    data: {
      ...payload.data,
      notes: includeAll || contents.has('notes') ? (payload.data.notes || []) : [],
      translationHistory: includeAll || contents.has('translations') ? (payload.data.translationHistory || []) : [],
      annotations: annotations.filter((annotation) => (
        annotation.type === 'text-highlight'
          ? includeAll || contents.has('highlights')
          : includeAll || contents.has('annotations')
      )),
      bookmarks: includeAll || contents.has('bookmarks') ? (payload.data.bookmarks || []) : [],
    },
  }
}

function escapeLiteratureHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildLiteraturePdfHtml(document, payload, folderPath) {
  const sections = [
    ['笔记', payload.data.notes || []],
    ['翻译记录', payload.data.translationHistory || []],
    ['高亮', (payload.data.annotations || []).filter((item) => item.type === 'text-highlight')],
    ['批注', (payload.data.annotations || []).filter((item) => item.type !== 'text-highlight')],
    ['书签', payload.data.bookmarks || []],
  ].filter(([, items]) => items.length)
  const sectionHtml = sections.map(([title, items]) => `
    <section>
      <h2>${escapeLiteratureHtml(title)}</h2>
      ${items.slice().sort((a, b) => getExportRecordPage(a) - getExportRecordPage(b) || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)).map((item) => `
        <article>
          <strong>第 ${getExportRecordPage(item)} 页</strong>
          <p>${escapeLiteratureHtml(item.noteText || item.translation || item.selectedText || item.ocrText || item.title || '').replace(/\n/g, '<br>')}</p>
        </article>`).join('')}
    </section>`).join('')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 18mm; }
    body { color: #20231f; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; font-size: 12px; line-height: 1.65; }
    h1 { margin: 0 0 10px; font-size: 24px; } h2 { margin: 22px 0 8px; font-size: 16px; border-bottom: 1px solid #d9ddd7; padding-bottom: 5px; }
    .meta { color: #666d65; margin-bottom: 18px; } article { break-inside: avoid; padding: 7px 0; border-bottom: 1px solid #edf0ec; }
    article p { margin: 3px 0 0; white-space: normal; }
  </style></head><body><h1>${escapeLiteratureHtml(document.displayName || document.fileName)}</h1>
  <div class="meta">文件夹：${escapeLiteratureHtml(folderPath)}<br>文件名：${escapeLiteratureHtml(document.fileName)}<br>导出时间：${escapeLiteratureHtml(formatExportDateText())}</div>
  ${sectionHtml}</body></html>`
}

async function getAvailableExportFilePath(directory, baseName, extension, usedPaths) {
  const safeBaseName = sanitizeExportName(baseName, 'document')
  let suffix = 0
  while (true) {
    const candidateName = `${safeBaseName}${suffix ? `_${suffix + 1}` : ''}${extension}`
    const candidatePath = path.join(directory, candidateName)
    const key = candidatePath.toLowerCase()
    if (!usedPaths.has(key)) {
      try {
        await fs.access(candidatePath)
      } catch {
        usedPaths.add(key)
        return candidatePath
      }
    }
    suffix += 1
  }
}

async function exportLiteratureScope(options = {}) {
  const library = await readLibraryData()
  const scope = options.scope === 'recycle'
    ? 'recycle'
    : options.scope === 'all'
      ? 'all'
      : options.scope === 'selection'
        ? 'selection'
        : 'folder'
  const includeDescendants = options.includeDescendants !== false
  const selectedIds = new Set((Array.isArray(options.literatureIds) ? options.literatureIds : []).map(String))
  let documents
  let rootName
  let rootFolderPath = ''

  if (scope === 'recycle') {
    documents = library.documents
      .filter((document) => document.status === LITERATURE_STATUS_RECYCLED)
      .filter((document) => !selectedIds.size || selectedIds.has(document.literatureId))
      .sort((a, b) => (b.recycledAt || 0) - (a.recycledAt || 0))
    rootName = '回收箱'
  } else if (scope === 'selection') {
    documents = library.documents.filter((document) => selectedIds.has(document.literatureId))
    rootName = String(options.outputName || '导出文件').trim() || '导出文件'
  } else if (scope === 'all') {
    documents = library.documents.filter((document) => document.status === LITERATURE_STATUS_ACTIVE)
    rootName = '全部文献'
  } else {
    const folderId = options.folderId ? String(options.folderId) : null
    const folder = library.folders.find((item) => item.id === folderId)
    const folderIds = folderId
      ? includeDescendants
        ? collectDescendantFolderIds(library.folders, folderId)
        : new Set([folderId])
      : new Set()
    documents = library.documents.filter((document) => (
      document.status === LITERATURE_STATUS_ACTIVE &&
      (folderId ? folderIds.has(document.folderId) : !document.folderId)
    ))
    rootName = folder?.name || '未分类'
    rootFolderPath = folder ? getLibraryFolderPath(library.folders, folder.id) : '未分类'
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: scope === 'recycle' ? '导出回收箱' : scope === 'all' ? '导出全部文献' : '导出文件夹',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const requestedRootName = String(options.outputName || rootName).trim() || rootName
  const rootDirectory = path.join(result.filePaths[0], sanitizeExportName(requestedRootName, scope === 'recycle' ? '回收箱' : '导出文件'))
  await fs.mkdir(rootDirectory, { recursive: true })
  const formats = new Set(Array.isArray(options.formats) && options.formats.length ? options.formats : ['markdown', 'json'])
  const usedPaths = new Set()
  const failures = []
  const indexRows = []
  let exportedDocuments = 0
  let exportedRecords = 0

  for (const document of documents) {
    const folderPath = getLibraryFolderPath(
      library.folders,
      document.status === LITERATURE_STATUS_ACTIVE ? document.folderId : document.previousFolderId,
    )
    const scopedFolderPath = rootFolderPath && folderPath.startsWith(`${rootFolderPath}/`)
      ? folderPath.slice(rootFolderPath.length + 1)
      : folderPath === rootFolderPath
        ? ''
        : folderPath
    const relativeFolderPath = scope === 'recycle'
      ? ''
      : document.status === LITERATURE_STATUS_RECYCLED
        ? '回收箱'
        : scopedFolderPath === '未分类'
          ? ''
          : scopedFolderPath.split('/').filter(Boolean).map((name) => sanitizeExportName(name, 'folder')).join(path.sep)
    const outputDirectory = relativeFolderPath ? path.join(rootDirectory, relativeFolderPath) : rootDirectory
    await fs.mkdir(outputDirectory, { recursive: true })

    try {
      const payload = filterLiteratureExportPayload(
        await collectDocumentExportData(document.literatureId, 'full'),
        options.contents,
      )
      const recordCount = (payload.data.translationHistory?.length || 0) +
        (payload.data.notes?.length || 0) +
        (payload.data.annotations?.length || 0) +
        (payload.data.bookmarks?.length || 0)
      exportedRecords += recordCount
      const baseName = `${document.displayName || document.fileName}_${getShortDocumentId(document.literatureId)}`

      if (formats.has('markdown')) {
        const markdownPath = await getAvailableExportFilePath(outputDirectory, baseName, '.md', usedPaths)
        await fs.writeFile(markdownPath, buildLiteratureMarkdown(document, payload, folderPath), 'utf8')
      }
      if (formats.has('json')) {
        const jsonPath = await getAvailableExportFilePath(outputDirectory, baseName, '.paperreader.json', usedPaths)
        const exportObject = buildSingleDocumentExport(document.literatureId, 'full', payload)
        await fs.writeFile(jsonPath, JSON.stringify(exportObject, null, 2), 'utf8')
      }
      if (formats.has('pdf')) {
        const pdfPath = await getAvailableExportFilePath(outputDirectory, baseName, '.pdf', usedPaths)
        const pdfBuffer = await printHtmlToPdfBuffer(buildLiteraturePdfHtml(document, payload, folderPath))
        await fs.writeFile(pdfPath, pdfBuffer)
      }
      if (formats.has('original')) {
        try {
          if (!document.filePath) throw new Error('原始文献路径不存在')
          const sourceStat = await fs.stat(document.filePath)
          if (!sourceStat.isFile()) throw new Error('原始文献不存在')
          const extension = path.extname(document.fileName) || '.pdf'
          const originalPath = await getAvailableExportFilePath(outputDirectory, path.basename(document.fileName, extension), extension, usedPaths)
          await fs.copyFile(document.filePath, originalPath)
        } catch (error) {
          failures.push({ literatureId: document.literatureId, fileName: document.fileName, error: error.message })
        }
      }
      indexRows.push(`- ${document.displayName || document.fileName} · ${folderPath} · ${recordCount}`)
      exportedDocuments += 1
    } catch (error) {
      failures.push({ literatureId: document.literatureId, fileName: document.fileName, error: error.message })
    }
  }

  const readmeLines = [
    `# ${rootName}`,
    '',
    ...indexRows,
  ]
  if (failures.length) {
    readmeLines.push('', '## 失败', '', ...failures.map((item) => `- ${item.fileName}：${item.error}`))
  }
  await fs.writeFile(path.join(rootDirectory, 'README.md'), `${readmeLines.join('\n').trim()}\n`, 'utf8')

  return {
    canceled: false,
    outputDir: rootDirectory,
    documents: exportedDocuments,
    records: exportedRecords,
    failures,
  }
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

function cleanExportFileName(value, fallback = '合并导出') {
  let stripped = String(value || '')
    .replace(/\.paperreader\.json$/i, '')
    .replace(/\.json$/i, '')
    .trim()

  const typePrefix = '(?:翻译历史|笔记|批注|书签|完整备份|混合合集|翻译历史合集|笔记合集|批注合集|书签合集|完整备份合集)'
  const paperReaderPrefix = '(?:paper\\s*reader|paperreader)'
  const prefixPatterns = [
    new RegExp(`^${typePrefix}[_\\-\\s]*${paperReaderPrefix}[_\\-\\s]*`, 'i'),
    new RegExp(`^${paperReaderPrefix}[_\\-\\s]*${typePrefix}?[_\\-\\s]*`, 'i'),
    new RegExp(`^${paperReaderPrefix}[_\\-\\s]*`, 'i'),
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of prefixPatterns) {
      const nextValue = stripped.replace(pattern, '').trim()
      if (nextValue !== stripped) {
        stripped = nextValue
        changed = true
      }
    }
  }

  return sanitizeExportName(stripped || fallback, fallback)
}

function getShortDocumentId(documentId = '') {
  return String(documentId || 'document').slice(0, 10) || 'document'
}

function getExportTypeLabel(exportType) {
  if (exportType === 'translation-history') return '翻译历史'
  if (exportType === 'notes') return '笔记'
  if (exportType === 'annotations') return '批注'
  if (exportType === 'bookmarks') return '书签'
  if (exportType === 'mixed') return '混合'
  if (exportType === 'merged') return '合并文件'
  return '完整备份'
}

function normalizeDataExportType(exportType) {
  return ['translation-history', 'notes', 'annotations', 'bookmarks', 'full'].includes(exportType) ? exportType : 'full'
}

function getExportFileBaseName({ exportType, exportMode, fileName, documentId, userExportName, timestamp, merged = false }) {
  const cleanedUserExportName = cleanExportFileName(userExportName, '未命名合集')

  if (merged) {
    return `${cleanedUserExportName || '合并导出'}_${timestamp}`
  }

  const label = getExportTypeLabel(exportType)
  if (exportMode === 'multi-document') {
    return `${label}合集_${cleanedUserExportName}_${timestamp}`
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

function getLibraryFolderPath(folders, folderId) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const names = []
  const visited = new Set()
  let currentId = folderId
  while (currentId && byId.has(currentId) && !visited.has(currentId)) {
    visited.add(currentId)
    const folder = byId.get(currentId)
    names.unshift(folder.name)
    currentId = folder.parentId
  }
  return names.join('/') || '未分类'
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
  const [library, histories, notesData, annotationsData, bookmarksData, browsingHistory] = await Promise.all([
    readLibraryData(),
    readDocumentTranslationHistories(),
    readDocumentNotes(),
    readDocumentAnnotations(),
    readDocumentBookmarks(),
    readBrowsingHistory(),
  ])
  const browsingRecord = browsingHistory.find((record) => record.documentId === documentId)
  const historyContainer = histories[documentId] || {}
  const noteContainer = notesData[documentId] || {}
  const annotationContainer = annotationsData[documentId] || {}
  const bookmarkContainer = bookmarksData[documentId] || {}
  const historyItems = normalizeHistoryItems(historyContainer.items || [])
  const noteItems = normalizeNoteItems(noteContainer.items || [])
  const annotationItems = normalizeAnnotationItems(annotationContainer.items || [])
  const bookmarkItems = normalizeBookmarkItems(bookmarkContainer.items || [])
  const storedLiterature = library.documents.find((item) => item.literatureId === documentId)
  const recordDocument = buildDocumentMeta(documentId, {
    filePath: historyContainer.filePath || noteContainer.filePath || annotationContainer.filePath || bookmarkContainer.filePath,
    fileName: historyContainer.fileName || noteContainer.fileName || annotationContainer.fileName || bookmarkContainer.fileName,
    lastUpdatedAt: Math.max(
      Number(historyContainer.lastOpenedAt) || 0,
      Number(noteContainer.lastUpdatedAt) || 0,
      Number(annotationContainer.lastUpdatedAt) || 0,
      Number(bookmarkContainer.lastUpdatedAt) || 0,
    ),
  }, browsingRecord)
  const document = storedLiterature
    ? {
        ...recordDocument,
        ...storedLiterature,
        documentId: storedLiterature.literatureId,
        literatureId: storedLiterature.literatureId,
        fileName: storedLiterature.displayName || storedLiterature.fileName,
        sourceFileName: storedLiterature.fileName,
        folderPath: getLibraryFolderPath(library.folders, storedLiterature.status === LITERATURE_STATUS_ACTIVE
          ? storedLiterature.folderId
          : storedLiterature.previousFolderId),
      }
    : recordDocument

  return {
    document,
    data: {
      translationHistory: ['notes', 'annotations', 'bookmarks'].includes(exportType) ? [] : historyItems,
      notes: ['translation-history', 'annotations', 'bookmarks'].includes(exportType) ? [] : noteItems,
      annotations: exportType === 'translation-history'
        ? []
        : exportType === 'notes'
          ? getRelatedAnnotations(noteItems, annotationItems)
          : exportType === 'bookmarks'
            ? []
            : annotationItems,
      bookmarks: ['translation-history', 'notes', 'annotations'].includes(exportType) ? [] : bookmarkItems,
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
  const cleanedUserExportName = cleanExportFileName(userExportName, '未命名合集')
  const exportName = getExportFileBaseName({
    exportType,
    exportMode: 'multi-document',
    userExportName: cleanedUserExportName,
    timestamp,
    merged,
  })

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appName: EXPORT_APP_NAME,
    exportType,
    exportMode: 'multi-document',
    exportName,
    userExportName: cleanedUserExportName,
    createdAt: now.getTime(),
    createdAtText: formatExportDateText(now),
    documents: documents.map((entry) => ({
      ...entry,
      entryExportType: entry.entryExportType || entry.exportType || exportType,
      entryExportName: entry.entryExportName || entry.exportName,
    })),
  }
}

function getBackupFolderIds(folders, documents) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const ids = new Set()
  documents.forEach((document) => {
    let folderId = document.status === LITERATURE_STATUS_RECYCLED ? document.previousFolderId : document.folderId
    while (folderId && byId.has(folderId) && !ids.has(folderId)) {
      ids.add(folderId)
      folderId = byId.get(folderId).parentId
    }
  })
  return ids
}

async function collectApplicationBackupState(documentIds = []) {
  const selectedIds = new Set((Array.isArray(documentIds) ? documentIds : []).map(String))
  const [library, browsingHistory, pdfSession, tableOfContents, config] = await Promise.all([
    readLibraryData(),
    readBrowsingHistory(),
    readPdfSession(),
    readDocumentTableOfContents(),
    readConfig(),
  ])
  const documents = library.documents.filter((document) => !selectedIds.size || selectedIds.has(document.literatureId))
  const includedIds = new Set(documents.map((document) => document.literatureId))
  const folderIds = getBackupFolderIds(library.folders, documents)
  const safeConfig = { ...config }
  delete safeConfig.apiKey
  delete safeConfig.providerApiKeys

  return {
    backupVersion: 1,
    createdAt: Date.now(),
    library: {
      schemaVersion: library.schemaVersion,
      migrationVersion: library.migrationVersion,
      folders: library.folders.filter((folder) => folderIds.has(folder.id)),
      documents,
    },
    browsingHistory: browsingHistory.filter((record) => includedIds.has(record.documentId)),
    pdfSession: {
      ...pdfSession,
      tabs: (pdfSession.tabs || []).filter((tab) => includedIds.has(tab.documentId)),
      activeTabId: '',
    },
    tableOfContents: Object.fromEntries(Object.entries(tableOfContents).filter(([documentId]) => includedIds.has(documentId))),
    config: safeConfig,
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

  const targetFilePath = exportObject.exportMode === 'multi-document'
    ? path.join(path.dirname(result.filePath), `${cleanExportFileName(path.basename(result.filePath), exportObject.exportName)}${EXPORT_EXTENSION}`)
    : result.filePath

  await fs.writeFile(targetFilePath, `${JSON.stringify(exportObject, null, 2)}\n`, 'utf8')
  return { canceled: false, filePath: targetFilePath, exportName: exportObject.exportName }
}

async function writeExportJsonDirect(exportObject, targetDir) {
  await fs.mkdir(targetDir, { recursive: true })
  const filePath = path.join(targetDir, `${exportObject.exportName}${EXPORT_EXTENSION}`)
  await fs.writeFile(filePath, `${JSON.stringify(exportObject, null, 2)}\n`, 'utf8')
  return filePath
}

function getMarkdownBaseName(value, fallback = 'PaperReader_Markdown') {
  const stripped = String(value || '')
    .replace(/\.md$/i, '')
    .trim()

  return sanitizeExportName(stripped || fallback, fallback)
}

function ensureMarkdownExtension(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.md') ? filePath : `${filePath}.md`
}

async function getAvailableMarkdownPath(outputDir, baseName, usedPaths = new Set()) {
  let index = 1

  while (true) {
    const suffix = index === 1 ? '' : `_${index}`
    const candidate = path.join(outputDir, `${baseName}${suffix}.md`)
    const key = candidate.toLowerCase()

    if (!usedPaths.has(key)) {
      try {
        await fs.access(candidate)
      } catch {
        usedPaths.add(key)
        return candidate
      }
    }

    index += 1
  }
}

async function saveMarkdownFile(payload = {}) {
  const markdown = String(payload.markdown || '').trim()
  if (!markdown) throw new Error('暂无可导出的 Markdown 内容')

  const defaultDir = await getValidExportDefaultDir()
  const defaultName = getMarkdownBaseName(payload.defaultFileName || 'PaperReader_Markdown')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Markdown 文件',
    defaultPath: path.join(defaultDir, `${defaultName}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })

  if (result.canceled || !result.filePath) return { canceled: true }

  const targetFilePath = ensureMarkdownExtension(result.filePath)
  await fs.writeFile(targetFilePath, `${markdown}\n`, 'utf8')
  return { canceled: false, filePath: targetFilePath }
}

async function saveMarkdownBatchFiles(payload = {}) {
  const files = Array.isArray(payload.files)
    ? payload.files
      .map((file) => ({
        fileName: getMarkdownBaseName(file?.fileName || file?.defaultFileName || 'PaperReader_Markdown'),
        markdown: String(file?.markdown || '').trim(),
        relativePath: String(file?.relativePath || ''),
      }))
      .filter((file) => file.markdown)
    : []

  if (!files.length) throw new Error('暂无可导出的 Markdown 内容')

  const defaultDir = await getValidExportDefaultDir()
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Markdown 导出目录',
    defaultPath: defaultDir,
    properties: ['openDirectory', 'createDirectory'],
  })

  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const outputDir = payload.outputName
    ? path.join(result.filePaths[0], sanitizeExportName(payload.outputName, '批量导出'))
    : result.filePaths[0]
  await fs.mkdir(outputDir, { recursive: true })

  const usedPaths = new Set()
  const filePaths = []
  const errors = []
  for (const file of files) {
    try {
      const relativePath = file.relativePath.split(/[\\/]+/).filter(Boolean).map((segment) => sanitizeExportName(segment, 'folder'))
      const fileOutputDir = relativePath.length ? path.join(outputDir, ...relativePath) : outputDir
      await fs.mkdir(fileOutputDir, { recursive: true })
      const targetFilePath = await getAvailableMarkdownPath(fileOutputDir, file.fileName, usedPaths)
      await fs.writeFile(targetFilePath, `${file.markdown}\n`, 'utf8')
      filePaths.push(targetFilePath)
    } catch (error) {
      errors.push({ fileName: file.fileName, error: getErrorMessage(error) })
    }
  }

  return {
    canceled: false,
    outputDir,
    filePaths,
    errors,
    error: !filePaths.length && errors.length ? '全部 Markdown 文件导出失败' : undefined,
  }
}

function getPdfReportBaseName(value, fallback = 'PaperReader_Report') {
  const stripped = String(value || '')
    .replace(/\.pdf$/i, '')
    .trim()

  return sanitizeExportName(stripped || fallback, fallback)
}

function ensurePdfExtension(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.pdf') ? filePath : `${filePath}.pdf`
}

async function getAvailablePdfReportPath(outputDir, baseName, usedPaths = new Set()) {
  let index = 1

  while (true) {
    const suffix = index === 1 ? '' : `_${index}`
    const candidate = path.join(outputDir, `${baseName}${suffix}.pdf`)
    const key = candidate.toLowerCase()

    if (!usedPaths.has(key)) {
      try {
        await fs.access(candidate)
      } catch {
        usedPaths.add(key)
        return candidate
      }
    }

    index += 1
  }
}

function getErrorMessage(error) {
  return error?.message || String(error)
}

function waitForWindowLoad(win) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      finish(new Error('PDF 打印页面加载超时'))
    }, 15000)

    function cleanup() {
      clearTimeout(timeout)
      win.webContents.removeListener('did-finish-load', handleFinish)
      win.webContents.removeListener('did-fail-load', handleFail)
      win.webContents.removeListener('render-process-gone', handleGone)
    }

    function finish(error) {
      if (settled) return
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    function handleFinish() {
      finish()
    }

    function handleFail(_event, errorCode, errorDescription) {
      finish(new Error(`PDF 打印页面加载失败：${errorCode} ${errorDescription || '未知错误'}`))
    }

    function handleGone(_event, details) {
      finish(new Error(`PDF 打印页面进程异常退出：${details?.reason || '未知原因'}`))
    }

    win.webContents.once('did-finish-load', handleFinish)
    win.webContents.once('did-fail-load', handleFail)
    win.webContents.once('render-process-gone', handleGone)
  })
}

async function waitForPrintReady(win) {
  await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const done = () => requestAnimationFrame(() => resolve(true));
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(done, done);
      } else {
        done();
      }
    })
  `, true)
}

async function printHtmlToPdfBuffer(html) {
  const safeHtml = String(html || '').trim()
  if (!safeHtml) throw new Error('没有可导出的 PDF HTML 内容')

  const tempDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'paper-reader-pdf-'))
  const tempFilePath = path.join(tempDir, 'report.html')
  const printWindow = new BrowserWindow({
    width: 1024,
    height: 1365,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  try {
    await fs.writeFile(tempFilePath, safeHtml, 'utf8')
    const loadPromise = waitForWindowLoad(printWindow)
    await Promise.all([
      loadPromise,
      printWindow.loadFile(tempFilePath),
    ])

    try {
      await waitForPrintReady(printWindow)
    } catch (error) {
      // Font readiness is a rendering hint; printToPDF still works if the check is unavailable.
      console.warn('PDF 打印页面字体等待失败：', error)
    }

    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      pageSize: 'A4',
      margins: {
        marginType: 'default',
      },
    })

    if (!pdfBuffer?.length) throw new Error('PDF 打印结果为空')
    return pdfBuffer
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close()
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch (error) {
      console.warn('清理临时 PDF HTML 文件失败：', error)
    }
  }
}

async function renderHtmlToPdfFile(payload = {}) {
  const html = String(payload.html || '').trim()
  if (!html) throw new Error('没有可导出的 PDF HTML 内容')

  const defaultDir = await getValidExportDefaultDir()
  const defaultName = getPdfReportBaseName(payload.defaultFileName || 'PaperReader_Report')
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PDF 报告',
    defaultPath: path.join(defaultDir, `${defaultName}.pdf`),
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  })

  if (result.canceled || !result.filePath) return { canceled: true }

  const targetFilePath = ensurePdfExtension(result.filePath)
  const pdfBuffer = await printHtmlToPdfBuffer(html)
  await fs.writeFile(targetFilePath, pdfBuffer)
  return { canceled: false, filePath: targetFilePath }
}

async function renderHtmlToPdfFiles(payload = {}) {
  const files = Array.isArray(payload.files)
    ? payload.files
      .map((file) => ({
        fileName: getPdfReportBaseName(file?.fileName || file?.defaultFileName || 'PaperReader_Report'),
        html: String(file?.html || '').trim(),
        relativePath: String(file?.relativePath || ''),
      }))
    : []

  if (!files.length) throw new Error('没有可导出的 PDF HTML 内容')

  const defaultDir = await getValidExportDefaultDir()
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 PDF 报告导出目录',
    defaultPath: defaultDir,
    properties: ['openDirectory', 'createDirectory'],
  })

  if (result.canceled || !result.filePaths[0]) return { canceled: true }

  const outputDir = payload.outputName
    ? path.join(result.filePaths[0], sanitizeExportName(payload.outputName, '批量导出'))
    : result.filePaths[0]
  await fs.mkdir(outputDir, { recursive: true })

  const usedPaths = new Set()
  const filePaths = []
  const errors = []
  for (const file of files) {
    if (!file.html) {
      errors.push({ fileName: file.fileName, error: '没有可导出的 PDF HTML 内容' })
      continue
    }

    try {
      const relativePath = file.relativePath.split(/[\\/]+/).filter(Boolean).map((segment) => sanitizeExportName(segment, 'folder'))
      const fileOutputDir = relativePath.length ? path.join(outputDir, ...relativePath) : outputDir
      await fs.mkdir(fileOutputDir, { recursive: true })
      const targetFilePath = await getAvailablePdfReportPath(fileOutputDir, file.fileName, usedPaths)
      const pdfBuffer = await printHtmlToPdfBuffer(file.html)
      await fs.writeFile(targetFilePath, pdfBuffer)
      filePaths.push(targetFilePath)
    } catch (error) {
      console.error(`导出 PDF 报告失败：${file.fileName}`, error)
      errors.push({ fileName: file.fileName, error: getErrorMessage(error) })
    }
  }

  return {
    canceled: false,
    outputDir,
    filePaths,
    errors,
    error: !filePaths.length && errors.length ? '全部 PDF 报告导出失败' : undefined,
  }
}

async function savePdfReport(payload = {}) {
  try {
    return await renderHtmlToPdfFile(payload)
  } catch (error) {
    console.error('导出 PDF 报告失败：', error)
    return { canceled: false, error: getErrorMessage(error) }
  }
}

async function saveBatchPdfReports(payload = {}) {
  try {
    return await renderHtmlToPdfFiles(payload)
  } catch (error) {
    console.error('批量导出 PDF 报告失败：', error)
    return { canceled: false, error: getErrorMessage(error), errors: [] }
  }
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

function bookmarkSignature(item) {
  return [
    item.pageNumber || '',
    item.title || '',
  ].join('|')
}

async function importExportDocuments(documents, forcedDocumentId = null, forcedType = null) {
  const [library, histories, notesData, annotationsData, bookmarksData] = await Promise.all([
    readLibraryData(),
    readDocumentTranslationHistories(),
    readDocumentNotes(),
    readDocumentAnnotations(),
    readDocumentBookmarks(),
  ])
  let nextLiteratures = [...library.documents]
  const importType = forcedType ? normalizeDataExportType(forcedType) : null
  const summary = {
    documents: 0,
    addedLiteratures: 0,
    mergedLiteratures: 0,
    translationHistory: 0,
    notes: 0,
    annotations: 0,
    bookmarks: 0,
    skipped: 0,
  }
  const touchedDocuments = new Set()

  documents.forEach((entry) => {
    const sourceDocument = entry.document || {}
    const sourceLiteratureId = String(sourceDocument.literatureId || sourceDocument.documentId || '').trim()
    const requestedLiteratureId = forcedDocumentId || sourceLiteratureId || createDocumentId(
      sourceDocument.filePath,
      sourceDocument.fileName,
      sourceDocument.fileSize,
    )
    if (!requestedLiteratureId) return

    const matchedLiterature = forcedDocumentId
      ? nextLiteratures.find((item) => item.literatureId === forcedDocumentId)
      : findMatchingLiterature(nextLiteratures, { ...sourceDocument, literatureId: requestedLiteratureId })
    const documentId = matchedLiterature?.literatureId || requestedLiteratureId
    const importedStatus = sourceDocument.status === LITERATURE_STATUS_RECYCLED
      ? LITERATURE_STATUS_RECYCLED
      : LITERATURE_STATUS_ACTIVE
    if (matchedLiterature) {
      summary.mergedLiteratures += 1
      nextLiteratures = nextLiteratures.map((item) => (
        item.literatureId === matchedLiterature.literatureId
          ? {
              ...item,
              filePath: item.filePath || String(sourceDocument.filePath || ''),
              fileName: item.fileName || String(sourceDocument.fileName || documentId),
              displayName: item.displayName || String(sourceDocument.displayName || sourceDocument.fileName || documentId),
              fingerprint: item.fingerprint || String(sourceDocument.fingerprint || ''),
              fileSize: item.fileSize || Number(sourceDocument.fileSize) || 0,
              updatedAt: Date.now(),
            }
          : item
      ))
    } else {
      const newLiterature = normalizeLibraryDocument({
        ...sourceDocument,
        id: documentId,
        literatureId: documentId,
        documentId,
        fileName: sourceDocument.fileName || documentId,
        status: importedStatus,
        folderId: importedStatus === LITERATURE_STATUS_ACTIVE ? null : null,
        previousFolderId: importedStatus === LITERATURE_STATUS_RECYCLED ? sourceDocument.previousFolderId : null,
        recycledAt: importedStatus === LITERATURE_STATUS_RECYCLED ? (sourceDocument.recycledAt || Date.now()) : null,
        order: nextLiteratures.length,
      })
      if (newLiterature) {
        nextLiteratures.push(newLiterature)
        summary.addedLiteratures += 1
      }
    }

    const document = {
      literatureId: documentId,
      documentId,
      filePath: String(sourceDocument.filePath || ''),
      fileName: String(sourceDocument.fileName || documentId),
      fileSize: Number(sourceDocument.fileSize) || 0,
      lastUpdatedAt: Number(sourceDocument.lastUpdatedAt) || Date.now(),
    }
    const data = entry.data || {}
    const incomingHistory = ['notes', 'annotations', 'bookmarks'].includes(importType) ? [] : normalizeHistoryItems(data.translationHistory || [])
      .map((item) => normalizeDocumentHistoryItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)
    const incomingNotes = ['translation-history', 'annotations', 'bookmarks'].includes(importType) ? [] : normalizeNoteItems(data.notes || [])
      .map((item) => normalizeNoteItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)
    const incomingAnnotations = ['translation-history', 'bookmarks'].includes(importType) ? [] : normalizeAnnotationItems(data.annotations || [])
      .map((item) => normalizeAnnotationItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
      .filter(Boolean)
    const incomingBookmarks = ['translation-history', 'notes', 'annotations'].includes(importType) ? [] : normalizeBookmarkItems(data.bookmarks || [])
      .map((item) => normalizeBookmarkItem({ ...item, documentId, filePath: document.filePath, fileName: document.fileName }))
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

    if (incomingBookmarks.length) {
      const current = bookmarksData[documentId] || { filePath: document.filePath, fileName: document.fileName, items: [] }
      const merged = uniqueByIdAndSignature(normalizeBookmarkItems(current.items || []), incomingBookmarks, bookmarkSignature)
      bookmarksData[documentId] = {
        filePath: current.filePath || document.filePath,
        fileName: current.fileName || document.fileName,
        lastUpdatedAt: Date.now(),
        items: normalizeBookmarkItems(merged.items),
      }
      summary.bookmarks += merged.imported
      summary.skipped += merged.skipped
    }

    touchedDocuments.add(documentId)
  })

  await saveDocumentTranslationHistories(histories, { prune: false })
  await saveDocumentNotesData(notesData)
  await saveDocumentAnnotationsData(annotationsData)
  await saveDocumentBookmarksData(bookmarksData)
  await saveLibraryData({ ...library, documents: nextLiteratures })
  summary.documents = touchedDocuments.size
  return summary
}

async function exportCurrentDocumentData(documentId, exportType) {
  const nextExportType = normalizeDataExportType(exportType)
  const payload = await collectDocumentExportData(documentId, nextExportType)
  if (nextExportType === 'translation-history' && !payload.data.translationHistory.length) {
    throw new Error('暂无可导出的翻译历史')
  }
  if (nextExportType === 'notes' && !payload.data.notes.length) {
    throw new Error('暂无可导出的笔记')
  }
  if (nextExportType === 'annotations' && !payload.data.annotations.length) {
    throw new Error('暂无可导出的批注')
  }
  if (nextExportType === 'bookmarks' && !payload.data.bookmarks.length) {
    throw new Error('暂无可导出的书签')
  }
  const exportObject = buildSingleDocumentExport(documentId, nextExportType, payload)
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
  const library = await getEnrichedLibrary()
  return library.literatures
    .map((document) => ({
      ...document,
      documentId: document.literatureId,
      sourceFileName: document.fileName,
      fileName: document.displayName || document.fileName,
      lastUpdatedAt: document.updatedAt || document.lastOpenedAt || document.createdAt,
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === LITERATURE_STATUS_ACTIVE ? -1 : 1
      if (a.status === LITERATURE_STATUS_RECYCLED) return (b.recycledAt || 0) - (a.recycledAt || 0)
      return b.lastUpdatedAt - a.lastUpdatedAt
    })
}

async function batchExportPaperReaderData(options = {}) {
  const documentIds = Array.isArray(options.documentIds) ? options.documentIds : []
  const exportType = normalizeDataExportType(options.exportType)
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
  if (options.includeAppState === true && exportType === 'full') {
    exportObject.backupType = 'application'
    exportObject.applicationState = await collectApplicationBackupState(documentIds)
  }
  const saved = await writeExportJson(exportObject)
  return { ...saved, filePaths: saved.filePath ? [saved.filePath] : [] }
}

function getFolderDepth(folder, byId) {
  let depth = 0
  let parentId = folder.parentId
  const visited = new Set([folder.id])
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId)
    depth += 1
    parentId = byId.get(parentId).parentId
  }
  return depth
}

async function mergeApplicationBackupStates(states, existingLiteratureIds) {
  const applicationStates = states.filter((state) => state?.backupVersion === 1 && state.library)
  if (!applicationStates.length) return { folders: 0, restoredStates: 0 }

  const [currentLibrary, currentBrowsing, currentToc, currentConfig] = await Promise.all([
    readLibraryData(),
    readBrowsingHistory(),
    readDocumentTableOfContents(),
    readConfig(),
  ])
  let nextFolders = [...currentLibrary.folders]
  let nextDocuments = [...currentLibrary.documents]
  const nextBrowsing = [...currentBrowsing]
  const nextToc = { ...currentToc }
  const literatureIdMap = new Map()
  let addedFolders = 0

  for (const state of applicationStates) {
    const sourceFolders = normalizeLibraryData(state.library).folders
    const sourceFolderById = new Map(sourceFolders.map((folder) => [folder.id, folder]))
    const folderIdMap = new Map()
    const orderedFolders = sourceFolders.slice().sort((a, b) => getFolderDepth(a, sourceFolderById) - getFolderDepth(b, sourceFolderById) || a.order - b.order)

    orderedFolders.forEach((folder) => {
      const mappedParentId = folder.parentId ? (folderIdMap.get(folder.parentId) || null) : null
      const exact = nextFolders.find((item) => item.id === folder.id)
      const sameSibling = nextFolders.find((item) => (
        (item.parentId || null) === mappedParentId && item.name.trim().toLowerCase() === folder.name.trim().toLowerCase()
      ))
      if (exact || sameSibling) {
        folderIdMap.set(folder.id, (exact || sameSibling).id)
        return
      }
      const id = nextFolders.some((item) => item.id === folder.id)
        ? `${folder.id}-import-${Date.now()}-${addedFolders}`
        : folder.id
      nextFolders.push({ ...folder, id, parentId: mappedParentId, order: nextFolders.filter((item) => (item.parentId || null) === mappedParentId).length })
      folderIdMap.set(folder.id, id)
      addedFolders += 1
    })

    const sourceDocuments = normalizeLibraryData(state.library).documents
    sourceDocuments.forEach((sourceDocument) => {
      const target = findMatchingLiterature(nextDocuments, sourceDocument)
      if (!target) return
      literatureIdMap.set(sourceDocument.literatureId, target.literatureId)
      if (existingLiteratureIds.has(target.literatureId)) return
      nextDocuments = nextDocuments.map((document) => {
        if (document.literatureId !== target.literatureId) return document
        const sourceFolderId = sourceDocument.status === LITERATURE_STATUS_RECYCLED
          ? sourceDocument.previousFolderId
          : sourceDocument.folderId
        const mappedFolderId = sourceFolderId ? (folderIdMap.get(sourceFolderId) || null) : null
        return {
          ...document,
          status: sourceDocument.status,
          folderId: sourceDocument.status === LITERATURE_STATUS_ACTIVE ? mappedFolderId : null,
          previousFolderId: sourceDocument.status === LITERATURE_STATUS_RECYCLED ? mappedFolderId : null,
          recycledAt: sourceDocument.status === LITERATURE_STATUS_RECYCLED ? sourceDocument.recycledAt : null,
        }
      })
    })

    ;(state.browsingHistory || []).forEach((record) => {
      const documentId = literatureIdMap.get(record.documentId) || record.documentId
      if (!nextBrowsing.some((item) => item.documentId === documentId)) {
        nextBrowsing.push({ ...record, documentId, id: documentId })
      }
    })
    Object.entries(state.tableOfContents || {}).forEach(([sourceId, value]) => {
      const documentId = literatureIdMap.get(sourceId) || sourceId
      if (!nextToc[documentId]) nextToc[documentId] = value
    })
  }

  const importedConfig = applicationStates.find((state) => state.config)?.config || {}
  const nextConfig = existingLiteratureIds.size
    ? {
        ...currentConfig,
        exportDefaultDir: currentConfig.exportDefaultDir || String(importedConfig.exportDefaultDir || ''),
      }
    : {
        ...currentConfig,
        ...importedConfig,
        apiKey: currentConfig.apiKey,
        providerApiKeys: currentConfig.providerApiKeys,
      }
  const writes = [
    [getLibraryPath(), normalizeLibraryData({ ...currentLibrary, folders: nextFolders, documents: nextDocuments })],
    [getBrowsingHistoryPath(), normalizeBrowsingHistory(nextBrowsing)],
    [getTableOfContentsPath(), normalizeDocumentTableOfContents(nextToc)],
    [getConfigPath(), normalizeConfig(nextConfig)],
  ]
  const rollback = [
    [getLibraryPath(), currentLibrary],
    [getBrowsingHistoryPath(), currentBrowsing],
    [getTableOfContentsPath(), currentToc],
    [getConfigPath(), currentConfig],
  ]
  try {
    for (const [filePath, value] of writes) await writeJsonFileAtomic(filePath, value)
  } catch (error) {
    await Promise.allSettled(rollback.map(([filePath, value]) => writeJsonFileAtomic(filePath, value)))
    throw new Error(`恢复应用状态失败：${error.message}`, { cause: error })
  }
  return { folders: addedFolders, restoredStates: applicationStates.length }
}

async function batchImportPaperReaderData() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Paper Reader 导出文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Paper Reader 导出文件', extensions: ['paperreader.json', 'json'] }],
  })
  if (result.canceled || !result.filePaths.length) return { canceled: true }

  const allDocuments = []
  const applicationStates = []
  for (const filePath of result.filePaths) {
    const exportObject = await readExportFile(filePath)
    allDocuments.push(...getExportDocuments(exportObject))
    if (exportObject.backupType === 'application' && exportObject.applicationState) {
      applicationStates.push(exportObject.applicationState)
    }
  }
  const existingLibrary = await readLibraryData()
  const existingLiteratureIds = new Set(existingLibrary.documents.map((document) => document.literatureId))
  const summary = await importExportDocuments(allDocuments)
  const restored = await mergeApplicationBackupStates(applicationStates, existingLiteratureIds)
  summary.folders = restored.folders
  summary.restoredStates = restored.restoredStates
  return { canceled: false, summary }
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

function getPdfNumberValue(value) {
  if (typeof value?.asNumber === 'function') return value.asNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function getPdfArrayNumbers(array) {
  if (!(array instanceof PDFArray)) return []

  const values = []
  for (let index = 0; index < array.size(); index += 1) {
    const value = getPdfNumberValue(array.lookup(index))
    if (!Number.isFinite(value)) return []
    values.push(value)
  }
  return values
}

function arePdfRectsClose(firstRect = [], secondRect = []) {
  if (firstRect.length !== 4 || secondRect.length !== 4) return false

  const tolerance = 2
  return firstRect.every((value, index) => Math.abs(value - secondRect[index]) <= tolerance)
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
    updatedAt: Date.now(),
  }
}

async function deletePdfHighlightAnnotation(annotation) {
  const filePath = String(annotation?.pdfFilePath || annotation?.filePath || '').trim()
  const pdfAnnotationId = String(annotation?.pdfAnnotationId || '').trim()
  if (!filePath) {
    throw new Error('当前 PDF 路径无效，无法删除 PDF 本体高亮')
  }
  if (!pdfAnnotationId && !Array.isArray(annotation?.rects)) {
    throw new Error('该高亮没有可删除的 PDF 本体批注信息')
  }

  const pdfDoc = await PDFDocument.load(await fs.readFile(filePath), { ignoreEncryption: true })
  let removed = false
  const pageIndex = Math.max(0, Number(annotation?.pageNumber || 1) - 1)

  for (const [currentPageIndex, page] of pdfDoc.getPages().entries()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (!annots) continue
    const pageSize = page.getSize()
    const expectedGeometry = currentPageIndex === pageIndex
      ? getPdfHighlightGeometry(annotation, pageSize.width, pageSize.height)
      : null

    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annot = pdfDoc.context.lookup(annots.get(index))
      const subtype = annot?.lookup?.(PDFName.of('Subtype'))
      if (String(subtype) !== '/Highlight') continue

      const nm = annot?.lookup?.(PDFName.of('NM'))
      const rect = getPdfArrayNumbers(annot?.lookup?.(PDFName.of('Rect')))
      const matchesId = Boolean(pdfAnnotationId && getPdfStringValue(nm) === pdfAnnotationId)
      const matchesGeometry = Boolean(!matchesId && expectedGeometry && arePdfRectsClose(rect, expectedGeometry.rect))

      if (matchesId || matchesGeometry) {
        annots.remove(index)
        removed = true
      }
    }
  }

  if (!removed) throw new Error('未在 PDF 文件本体中找到对应高亮')

  const nextBytes = await pdfDoc.save()
  await fs.writeFile(filePath, nextBytes)
  return {
    removed: true,
    filePath,
    dataUrl: `data:application/pdf;base64,${Buffer.from(nextBytes).toString('base64')}`,
  }
}

function getFilePathKey(filePath) {
  return String(filePath || '').trim().toLowerCase()
}

function isSameStoredFilePath(container, filePathKey) {
  return Boolean(filePathKey && getFilePathKey(container?.filePath) === filePathKey)
}

async function mergeDocumentDataForPath(canonicalDocumentId, normalizedPath, fileName, stores) {
  const filePathKey = getFilePathKey(normalizedPath)
  if (!canonicalDocumentId || !filePathKey) return

  const { annotations, notes, histories, bookmarks, tableOfContents } = stores
  const annotationEntries = Object.entries(annotations).filter(([, container]) => isSameStoredFilePath(container, filePathKey))
  if (annotationEntries.some(([documentId]) => documentId !== canonicalDocumentId)) {
    const canonical = annotations[canonicalDocumentId] || { filePath: normalizedPath, fileName, items: [] }
    let items = normalizeAnnotationItems(canonical.items || [])
    let lastUpdatedAt = Number(canonical.lastUpdatedAt) || 0

    for (const [documentId, container] of annotationEntries) {
      if (documentId === canonicalDocumentId) continue
      const merged = uniqueByIdAndSignature(items, normalizeAnnotationItems(container.items || []), annotationSignature)
      items = normalizeAnnotationItems(merged.items)
      lastUpdatedAt = Math.max(lastUpdatedAt, Number(container.lastUpdatedAt) || 0)
      delete annotations[documentId]
    }

    annotations[canonicalDocumentId] = {
      filePath: canonical.filePath || normalizedPath,
      fileName: canonical.fileName || fileName,
      lastUpdatedAt: Math.max(lastUpdatedAt, Date.now()),
      items,
    }
    await saveDocumentAnnotationsData(annotations)
  }

  const noteEntries = Object.entries(notes).filter(([, container]) => isSameStoredFilePath(container, filePathKey))
  if (noteEntries.some(([documentId]) => documentId !== canonicalDocumentId)) {
    const canonical = notes[canonicalDocumentId] || { filePath: normalizedPath, fileName, items: [] }
    let items = normalizeNoteItems(canonical.items || [])
    let lastUpdatedAt = Number(canonical.lastUpdatedAt) || 0

    for (const [documentId, container] of noteEntries) {
      if (documentId === canonicalDocumentId) continue
      const merged = uniqueByIdAndSignature(items, normalizeNoteItems(container.items || []), noteSignature)
      items = normalizeNoteItems(merged.items)
      lastUpdatedAt = Math.max(lastUpdatedAt, Number(container.lastUpdatedAt) || 0)
      delete notes[documentId]
    }

    notes[canonicalDocumentId] = {
      filePath: canonical.filePath || normalizedPath,
      fileName: canonical.fileName || fileName,
      lastUpdatedAt: Math.max(lastUpdatedAt, Date.now()),
      items,
    }
    await saveDocumentNotesData(notes)
  }

  const historyEntries = Object.entries(histories).filter(([, container]) => isSameStoredFilePath(container, filePathKey))
  if (historyEntries.some(([documentId]) => documentId !== canonicalDocumentId)) {
    const canonical = histories[canonicalDocumentId] || { filePath: normalizedPath, fileName, items: [] }
    let items = normalizeHistoryItems(canonical.items || [])
    let lastOpenedAt = Number(canonical.lastOpenedAt) || 0

    for (const [documentId, container] of historyEntries) {
      if (documentId === canonicalDocumentId) continue
      const merged = uniqueByIdAndSignature(items, normalizeHistoryItems(container.items || []), historySignature)
      items = normalizeHistoryItems(merged.items).slice(0, HISTORY_LIMIT)
      lastOpenedAt = Math.max(lastOpenedAt, Number(container.lastOpenedAt) || 0)
      delete histories[documentId]
    }

    histories[canonicalDocumentId] = {
      filePath: canonical.filePath || normalizedPath,
      fileName: canonical.fileName || fileName,
      lastOpenedAt: Math.max(lastOpenedAt, Date.now()),
      items,
    }
    await saveDocumentTranslationHistories(histories, { prune: false })
  }

  const bookmarkEntries = Object.entries(bookmarks).filter(([, container]) => isSameStoredFilePath(container, filePathKey))
  if (bookmarkEntries.some(([documentId]) => documentId !== canonicalDocumentId)) {
    const canonical = bookmarks[canonicalDocumentId] || { filePath: normalizedPath, fileName, items: [] }
    let items = normalizeBookmarkItems(canonical.items || [])
    let lastUpdatedAt = Number(canonical.lastUpdatedAt) || 0

    for (const [documentId, container] of bookmarkEntries) {
      if (documentId === canonicalDocumentId) continue
      const merged = uniqueByIdAndSignature(items, normalizeBookmarkItems(container.items || []), bookmarkSignature)
      items = normalizeBookmarkItems(merged.items)
      lastUpdatedAt = Math.max(lastUpdatedAt, Number(container.lastUpdatedAt) || 0)
      delete bookmarks[documentId]
    }

    bookmarks[canonicalDocumentId] = {
      filePath: canonical.filePath || normalizedPath,
      fileName: canonical.fileName || fileName,
      lastUpdatedAt: Math.max(lastUpdatedAt, Date.now()),
      items,
    }
    await saveDocumentBookmarksData(bookmarks)
  }

  const tocEntries = Object.entries(tableOfContents).filter(([, container]) => isSameStoredFilePath(container, filePathKey))
  if (tocEntries.some(([documentId]) => documentId !== canonicalDocumentId)) {
    const candidates = [
      [canonicalDocumentId, tableOfContents[canonicalDocumentId]],
      ...tocEntries,
    ]
      .filter(([, container]) => container)
      .sort(([, first], [, second]) =>
        normalizeTocItems(second.items).length - normalizeTocItems(first.items).length ||
        Number(second.lastUpdatedAt || 0) - Number(first.lastUpdatedAt || 0),
      )
    const selected = candidates[0]?.[1] || {}

    tocEntries.forEach(([documentId]) => {
      if (documentId !== canonicalDocumentId) delete tableOfContents[documentId]
    })
    tableOfContents[canonicalDocumentId] = {
      filePath: selected.filePath || normalizedPath,
      fileName: selected.fileName || fileName,
      lastUpdatedAt: Math.max(Number(selected.lastUpdatedAt) || 0, Date.now()),
      source: selected.source || 'unavailable',
      version: Number(selected.version) || 0,
      documentType: selected.documentType || 'unknown',
      pageOffset: Number.isFinite(selected.pageOffset) ? selected.pageOffset : null,
      userModified: selected.userModified === true,
      fingerprint: normalizeTocFingerprint(selected.fingerprint, selected),
      items: normalizeTocItems(selected.items),
    }
    await saveDocumentTableOfContentsData(tableOfContents)
  }
}

async function resolveDocumentIdForPdf(filePath, fileName, fileSize) {
  const normalizedPath = String(filePath || '').trim()
  const filePathKey = getFilePathKey(normalizedPath)

  if (filePathKey) {
    const [annotations, notes, histories, bookmarks, tableOfContents, browsingHistory] = await Promise.all([
      readDocumentAnnotations(),
      readDocumentNotes(),
      readDocumentTranslationHistories(),
      readDocumentBookmarks(),
      readDocumentTableOfContents(),
      readBrowsingHistory(),
    ])
    const candidates = new Map()
    const addCandidate = (documentId, score, updatedAt = 0) => {
      if (!documentId) return
      const current = candidates.get(documentId) || { documentId, score: 0, updatedAt: 0 }
      current.score += score
      current.updatedAt = Math.max(current.updatedAt, Number(updatedAt) || 0)
      candidates.set(documentId, current)
    }

    for (const [documentId, container] of Object.entries(annotations)) {
      if (isSameStoredFilePath(container, filePathKey)) {
        addCandidate(documentId, 4000 + normalizeAnnotationItems(container.items || []).length * 20, container.lastUpdatedAt)
      }
    }

    for (const [documentId, container] of Object.entries(notes)) {
      if (isSameStoredFilePath(container, filePathKey)) {
        addCandidate(documentId, 3000 + normalizeNoteItems(container.items || []).length * 10, container.lastUpdatedAt)
      }
    }

    for (const [documentId, container] of Object.entries(histories)) {
      if (isSameStoredFilePath(container, filePathKey)) {
        addCandidate(documentId, 2000 + normalizeHistoryItems(container.items || []).length, container.lastOpenedAt)
      }
    }

    for (const [documentId, container] of Object.entries(bookmarks)) {
      if (isSameStoredFilePath(container, filePathKey)) {
        addCandidate(documentId, 1500 + normalizeBookmarkItems(container.items || []).length * 10, container.lastUpdatedAt)
      }
    }

    for (const [documentId, container] of Object.entries(tableOfContents)) {
      if (isSameStoredFilePath(container, filePathKey)) {
        addCandidate(documentId, 1400 + normalizeTocItems(container.items || []).length * 8, container.lastUpdatedAt)
      }
    }

    for (const record of browsingHistory) {
      if (getFilePathKey(record.filePath) === filePathKey) {
        addCandidate(record.documentId, 1000, record.lastOpenedAt)
      }
    }

    if (candidates.size) {
      const canonicalDocumentId = Array.from(candidates.values())
        .sort((first, second) => second.score - first.score || second.updatedAt - first.updatedAt)[0].documentId

      await mergeDocumentDataForPath(canonicalDocumentId, normalizedPath, fileName, {
        annotations,
        notes,
        histories,
        bookmarks,
        tableOfContents,
      })
      return canonicalDocumentId
    }
  }

  return createDocumentId(normalizedPath, fileName, fileSize)
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
    const modifiedTime = Math.max(0, Number(stat.mtimeMs) || 0)
    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
    const documentId = await resolveDocumentIdForPdf(normalizedPath, fileName, fileSize)

    return {
      filePath: normalizedPath,
      fileName,
      fileSize,
      modifiedTime,
      fileHash,
      documentId,
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

function getBackendBaseUrl() {
  return `http://localhost:${process.env.PORT || 3001}`
}

async function postBackendJson(route, payload = {}) {
  const response = await fetch(`${getBackendBaseUrl()}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || `Local AI request failed: ${response.status}`)
  }

  return data
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', async () => readConfig())
  ipcMain.handle('config:save', async (_event, config) => saveConfig(config))
  ipcMain.handle('ai:translate-text', async (_event, payload) => postBackendJson('/ai/translate-text', payload))
  ipcMain.handle('ai:translate-image-ocr', async (_event, payload) => postBackendJson('/ai/translate-image-ocr', payload))
  ipcMain.handle('ai:translate-image-diagram', async (_event, payload) => postBackendJson('/ai/translate-image-diagram', payload))
  ipcMain.handle('ai:recognize-toc', async (_event, payload) => postBackendJson('/ai/recognize-toc', payload))
  ipcMain.handle('ai:list-models', async (_event, payload) => postBackendJson('/ai/models', payload))
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
  ipcMain.handle('library:get', async () => getEnrichedLibrary())
  ipcMain.handle('library:import-pdfs', async () => importLibraryPdfs())
  ipcMain.handle('library:upsert-document', async (_event, document) => upsertLibraryDocument(document))
  ipcMain.handle('library:create-folder', async (_event, input) => createLibraryFolder(input))
  ipcMain.handle('library:update-folder', async (_event, folderId, updates) => updateLibraryFolder(folderId, updates))
  ipcMain.handle('library:reorder-folder', async (_event, folderId, targetFolderId, placement) => (
    reorderLibraryFolder(folderId, targetFolderId, placement)
  ))
  ipcMain.handle('library:move-folder', async (_event, folderId, parentId) => moveLibraryFolder(folderId, parentId))
  ipcMain.handle('library:delete-folder', async (_event, folderId) => deleteLibraryFolder(folderId))
  ipcMain.handle('library:update-document', async (_event, literatureId, updates) => updateLibraryDocument(literatureId, updates))
  ipcMain.handle('library:move-documents', async (_event, documentIds, folderId) => moveLibraryDocuments(documentIds, folderId))
  ipcMain.handle('library:delete-documents', async (_event, documentIds) => deleteLibraryDocuments(documentIds))
  ipcMain.handle('library:delete-literature', async (_event, literatureIds, mode) => deleteLiterature(literatureIds, mode))
  ipcMain.handle('library:restore-documents', async (_event, documentIds) => restoreLibraryDocuments(documentIds))
  ipcMain.handle('library:permanently-delete-documents', async (_event, documentIds) => permanentlyDeleteLibraryDocuments(documentIds))
  ipcMain.handle('library:export-scope', async (_event, options) => exportLiteratureScope(options))
  ipcMain.handle('pdf-session:get', async () => readPdfSession())
  ipcMain.handle('pdf-session:save', async (_event, session) => savePdfSession(session))
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
  ipcMain.handle('document-bookmarks:get', async (_event, documentId) => getDocumentBookmarks(documentId))
  ipcMain.handle('document-bookmarks:save', async (_event, documentId, payload) => saveDocumentBookmarks(documentId, payload))
  ipcMain.handle('document-bookmarks:add', async (_event, bookmark) => addDocumentBookmark(bookmark))
  ipcMain.handle('document-bookmarks:delete', async (_event, documentId, bookmarkId) => deleteDocumentBookmark(documentId, bookmarkId))
  ipcMain.handle('document-bookmarks:clear', async (_event, documentId) => clearDocumentBookmarks(documentId))
  ipcMain.handle('document-toc:get', async (_event, documentId) => getDocumentTableOfContents(documentId))
  ipcMain.handle('document-toc:save', async (_event, documentId, payload) => saveDocumentTableOfContents(documentId, payload))
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
  ipcMain.handle('paperreader-export:get-default-dir', async () => getValidExportDefaultDir())
  ipcMain.handle('paperreader-export:set-default-dir', async (_event, dirPath) => setExportDefaultDir(dirPath))
  ipcMain.handle('paperreader-export:select-default-dir', async () => selectExportDefaultDir())
  ipcMain.handle('paperreader-export:reset-default-dir', async () => resetExportDefaultDir())
  ipcMain.handle('markdown:save-file', async (_event, payload) => saveMarkdownFile(payload))
  ipcMain.handle('markdown:save-batch-files', async (_event, payload) => saveMarkdownBatchFiles(payload))
  ipcMain.handle('pdf-report:save-file', async (_event, payload) => savePdfReport(payload))
  ipcMain.handle('pdf-report:save-batch-files', async (_event, payload) => saveBatchPdfReports(payload))
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
    title: ' ',
    icon: getAppIconPath(),
    backgroundColor: '#eef2f6',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow.setTitle(' ')
  })

  mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))
}

app.whenReady().then(async () => {
  try {
    nativeTheme.themeSource = 'light'
    Menu.setApplicationMenu(null)
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
