import { useCallback, useEffect, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import { createWorker } from 'tesseract.js'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'
import './App.css'
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
const DEFAULT_TRANSLATION_PROMPT =
  '你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'
const DEFAULT_CONTENT_EXPORT_OPTIONS = {
  exportHistories: true,
  exportAnnotations: true,
  exportNotes: true,
}
const CONTENT_EXPORT_OPTION_ITEMS = [
  { key: 'exportHistories', label: '翻译历史' },
  { key: 'exportAnnotations', label: '批注' },
  { key: 'exportNotes', label: '笔记' },
]
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
    presets: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
    presets: [
      'openrouter/auto',
      'openai/gpt-5.2',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4.5',
      'qwen/qwen3',
      'deepseek/deepseek-v4-flash',
    ],
  },
  custom: {
    label: 'OpenAI-compatible \u81ea\u5b9a\u4e49\u63a5\u53e3',
    baseUrl: '',
    model: '',
    presets: [],
  },
}
const DEFAULT_SETTINGS = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: PROVIDERS.deepseek.baseUrl,
  model: PROVIDERS.deepseek.model,
  prompt: DEFAULT_TRANSLATION_PROMPT,
  enableMultimodalTranslation: false,
  rightPanelWidth: 420,
  exportDefaultDir: '',
}
const navIconProps = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}
const MODULE_NAV_ITEMS = [
  {
    id: 'reader',
    label: '阅读',
    icon: (
      <svg {...navIconProps}>
        <path d="M12 6.4C10.4 5 7.6 4.5 4.6 5v12.6c3-.5 5.8 0 7.4 1.4 1.6-1.4 4.4-1.9 7.4-1.4V5c-3-.5-5.8 0-7.4 1.4Z" />
        <path d="M12 6.4v12.6" />
      </svg>
    ),
  },
  {
    id: 'library',
    label: '文献库',
    icon: (
      <svg {...navIconProps}>
        <rect x="4" y="4" width="7" height="7" rx="1.4" />
        <rect x="13" y="4" width="7" height="7" rx="1.4" />
        <rect x="4" y="13" width="7" height="7" rx="1.4" />
        <rect x="13" y="13" width="7" height="7" rx="1.4" />
      </svg>
    ),
  },
  {
    id: 'importExport',
    label: '历史笔记管理',
    icon: (
      <svg {...navIconProps}>
        <path d="M7 8.5h11l-3-3M17 15.5H6l3 3" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: '设置',
    icon: (
      <svg {...navIconProps}>
        <circle cx="12" cy="12" r="2.9" />
        <path d="M19.3 13.4a7.6 7.6 0 0 0 0-2.8l1.8-1.3-1.6-2.8-2.1.8a7.5 7.5 0 0 0-2.4-1.4L14.5 3h-3l-.5 2.1a7.5 7.5 0 0 0-2.4 1.4l-2.1-.8L2.9 8.5l1.8 1.3a7.6 7.6 0 0 0 0 2.8l-1.8 1.3 1.6 2.8 2.1-.8a7.5 7.5 0 0 0 2.4 1.4l.5 2.1h3l.5-2.1a7.5 7.5 0 0 0 2.4-1.4l2.1.8 1.6-2.8-1.8-1.3Z" />
      </svg>
    ),
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
  const ocrStartPointRef = useRef(null)
  const panelResizeStartRef = useRef(null)
  const settingsFormRef = useRef(DEFAULT_SETTINGS)
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
  const mergeNameInputRef = useRef(null)
  const libraryFolderNameInputRef = useRef(null)
  const retainedRightPanelActionsRef = useRef(null)

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
  const [selectedLibraryFolderId, setSelectedLibraryFolderId] = useState('all')
  const [librarySearch, setLibrarySearch] = useState('')
  const [librarySort, setLibrarySort] = useState('recent')
  const [selectedLibraryDocumentIds, setSelectedLibraryDocumentIds] = useState([])
  const [libraryStatus, setLibraryStatus] = useState('')
  const [libraryContextMenu, setLibraryContextMenu] = useState(null)
  const [libraryMoveDialog, setLibraryMoveDialog] = useState(null)
  const [libraryFolderDialogOpen, setLibraryFolderDialogOpen] = useState(false)
  const [libraryFolderNameDraft, setLibraryFolderNameDraft] = useState('')
  const [libraryFolderNameError, setLibraryFolderNameError] = useState('')
  const [pageNumber, setPageNumber] = useState(1)
  const [numPages, setNumPages] = useState(null)
  const [selectedText, setSelectedText] = useState('')
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
  const [rightPanelTab, setRightPanelTab] = useState('result')
  const [documentNotes, setDocumentNotes] = useState([])
  const [selectedNoteId, setSelectedNoteId] = useState('')
  const [noteDialog, setNoteDialog] = useState(null)
  const [noteDraft, setNoteDraft] = useState({ title: '', noteText: '' })
  const [notesStatus, setNotesStatus] = useState('')
  const [historyStatus, setHistoryStatus] = useState('')
  const [exportStatus, setExportStatus] = useState('')
  const [, setIsHistoryImportExportBusy] = useState(false)
  const [, setIsNotesImportExportBusy] = useState(false)
  const [exportableDocuments, setExportableDocuments] = useState([])
  const [selectedExportDocumentIds, setSelectedExportDocumentIds] = useState([])
  const [selectedMarkdownDocumentIds, setSelectedMarkdownDocumentIds] = useState([])
  const [isMarkdownExporting, setIsMarkdownExporting] = useState(false)
  const [markdownExportOptions, setMarkdownExportOptions] = useState(DEFAULT_CONTENT_EXPORT_OPTIONS)
  const [selectedPdfReportDocumentIds, setSelectedPdfReportDocumentIds] = useState([])
  const [isPdfReportExporting, setIsPdfReportExporting] = useState(false)
  const [pdfReportExportOptions, setPdfReportExportOptions] = useState(DEFAULT_CONTENT_EXPORT_OPTIONS)
  const [batchExportType, setBatchExportType] = useState('full')
  const [batchExportMode, setBatchExportMode] = useState('merged')
  const [batchExportName, setBatchExportName] = useState('')
  const [mergeExportFiles, setMergeExportFiles] = useState([])
  const [mergeNameDialog, setMergeNameDialog] = useState(null)
  const [mergeNameDraft, setMergeNameDraft] = useState('我的合集')
  const [exportDefaultDir, setExportDefaultDir] = useState('')
  const [isAnnotationToolbarOpen, setIsAnnotationToolbarOpen] = useState(false)
  const [annotationColor, setAnnotationColor] = useState(null)
  const [pdfHighlightWriteMode, setPdfHighlightWriteMode] = useState('ask')
  const [documentAnnotations, setDocumentAnnotations] = useState([])
  const [previewHighlight, setPreviewHighlight] = useState(null)
  const [activeAnnotationId, setActiveAnnotationId] = useState('')
  const [highlightContextMenu, setHighlightContextMenu] = useState(null)
  const [annotationStatus, setAnnotationStatus] = useState('')
  const [isHistoryBatchSelecting, setIsHistoryBatchSelecting] = useState(false)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([])
  const [isNotesBatchSelecting, setIsNotesBatchSelecting] = useState(false)
  const [selectedNoteIds, setSelectedNoteIds] = useState([])
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
  const [glossary, setGlossary] = useState([])
  const [glossaryStatus, setGlossaryStatus] = useState('未导入术语库')
  const [isGlossaryVisible, setIsGlossaryVisible] = useState(false)
  const [settingsTab, setSettingsTab] = useState('model')
  const [importExportTab, setImportExportTab] = useState('importExport')
  const [activeModule, setActiveModule] = useState('reader')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [rightPanelWidth, setRightPanelWidth] = useState(DEFAULT_SETTINGS.rightPanelWidth)
  const [rightPanelVisible, setRightPanelVisible] = useState(true)
  const [isResizingPanel, setIsResizingPanel] = useState(false)

  function clearTranslation() {
    requestIdRef.current += 1
    setSelectedText('')
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

  function clearNoteDialogBlockers() {
    if (selectionFrameRef.current) {
      cancelAnimationFrame(selectionFrameRef.current)
      selectionFrameRef.current = null
    }

    requestIdRef.current += 1
    window.getSelection()?.removeAllRanges()
    isSelectingRef.current = false
    ocrStartPointRef.current = null
    panelResizeStartRef.current = null
    document.body.classList.remove('resizing-panel')

    setSelectedText('')
    setHighlightRects([])
    setPreviewHighlight(null)
    setActiveAnnotationId('')
    setHighlightContextMenu(null)
    setIsAnnotationToolbarOpen(false)
    setAnnotationStatus('')
    setIsOcrMode(false)
    setIsOcrMenuOpen(false)
    setIsOcrDragging(false)
    setOcrRect(null)
    setLibraryContextMenu(null)
    setLibraryMoveDialog(null)
    setIsRecentOpen(false)
    setIsResizingPanel(false)
    setDraggingTabId('')
    setDragOverTabId('')
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
    setSelectedNoteId('')
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
    setDocumentAnnotations([])
    setSelectedNoteId('')
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
                  ×
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
    if (!Array.isArray(notes)) return []

    return notes
      .filter(Boolean)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
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
    setNoteDialog(null)
    setNoteDraft({ title: '', noteText: '' })
  }

  function openNoteDialog(mode, note) {
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
    if (!Array.isArray(annotations)) return []

    return annotations
      .filter(Boolean)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
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

  async function maybeEmbedHighlightInPdf(annotation) {
    if (!annotation || annotation.type !== 'text-highlight' || !window.electronAPI?.embedPdfHighlightAnnotation) return annotation
    if (!currentDocument?.filePath || currentDocument.filePath === currentDocument.fileName) return annotation

    let nextWriteMode = pdfHighlightWriteMode
    if (nextWriteMode === 'ask') {
      const shouldWrite = window.confirm(
        '是否将后续高亮写入 PDF 文件本体？写入后用其他 PDF 软件打开也能看到。建议先备份原文件。\n\n确定：写入当前 PDF，并自动创建 .paper-reader-backup.pdf 备份。\n取消：仅在 Paper Reader 内显示高亮。',
      )
      nextWriteMode = shouldWrite ? 'write' : 'internal'
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

  function getActiveHighlight() {
    return documentAnnotations.find((item) => item.id === activeAnnotationId && item.type === 'text-highlight')
  }

  async function translateActiveHighlight() {
    const highlight = getActiveHighlight()

    if (!highlight?.selectedText) {
      setAnnotationStatus('请先选择需要批注的文字')
      return
    }

    setAnnotationStatus('翻译中...')

    try {
      const nextTranslation = await requestTranslation(highlight.selectedText)
      const nextResult = {
        type: 'text-selection',
        title: '批注翻译结果',
        selectedText: highlight.selectedText,
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

  function addNoteForActiveHighlight() {
    const highlight = getActiveHighlight()

    if (!highlight) {
      setAnnotationStatus('请先选择需要批注的文字')
      return
    }

    openAnnotationNoteDialog(highlight)
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
    const menuHeight = 46

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
    return `导入 ${summary.documents || 0} 篇文献，翻译历史 ${summary.translationHistory || 0} 条，笔记 ${summary.notes || 0} 条，批注 ${summary.annotations || 0} 条，跳过重复 ${summary.skipped || 0} 条`
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
    if (window.electronAPI?.getDocumentAnnotations) {
      const nextAnnotations = await window.electronAPI.getDocumentAnnotations(currentDocument.documentId)
      setDocumentAnnotations(normalizeAnnotationList(Array.isArray(nextAnnotations) ? nextAnnotations : []))
    }
  }

  const updateLibraryState = useCallback((library) => {
    setLibraryFolders(Array.isArray(library?.folders) ? library.folders : [])
    setLibraryDocuments(Array.isArray(library?.documents) ? library.documents : [])
    setSelectedLibraryDocumentIds((currentIds) => (
      currentIds.filter((id) => library?.documents?.some?.((document) => document.documentId === id))
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
      const nextDocuments = Array.isArray(documents) ? documents : []
      setExportableDocuments(nextDocuments)
      setExportDefaultDir(defaultDir || '')
      setSelectedExportDocumentIds((currentIds) => currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id)))
      setSelectedMarkdownDocumentIds((currentIds) => currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id)))
      setSelectedPdfReportDocumentIds((currentIds) => currentIds.filter((id) => nextDocuments.some((document) => document.documentId === id)))
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
    try {
      const result = await window.electronAPI.batchImportPaperReaderData()
      if (!result?.canceled) {
        await Promise.all([loadExportSettingsData(), refreshCurrentDocumentData()])
        setExportStatus(formatImportExportSummary(result.summary))
      }
    } catch (error) {
      setExportStatus(error.message || '批量导入失败')
    }
  }

  async function batchExportPaperReaderData() {
    if (!selectedExportDocumentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }

    setExportStatus('')
    try {
      const result = await window.electronAPI.batchExportPaperReaderData({
        documentIds: selectedExportDocumentIds,
        exportType: batchExportType,
        exportMode: batchExportMode,
        userExportName: batchExportMode === 'merged' ? batchExportName : '',
      })
      if (!result?.canceled) {
        setExportStatus(result.outputDir ? `已导出到：${result.outputDir}` : `已导出：${result.filePath}`)
      }
    } catch (error) {
      setExportStatus(error.message || '批量导出失败')
    }
  }

  async function collectMarkdownExportItems(documentIds, featureName = 'Markdown 导出') {
    if (!window.electronAPI?.getDocumentTranslationHistory || !window.electronAPI?.getDocumentAnnotations || !window.electronAPI?.getDocumentNotes) {
      throw new Error(`${featureName}仅在桌面版可用`)
    }

    const uniqueDocumentIds = Array.from(new Set((Array.isArray(documentIds) ? documentIds : []).filter(Boolean)))
    const documentsById = new Map(exportableDocuments.map((document) => [document.documentId, document]))

    return Promise.all(uniqueDocumentIds.map(async (documentId) => {
      const pdf = documentsById.get(documentId) || (currentDocument?.documentId === documentId ? currentDocument : { documentId })
      const [histories, annotations, notes] = await Promise.all([
        window.electronAPI.getDocumentTranslationHistory(documentId),
        window.electronAPI.getDocumentAnnotations(documentId),
        window.electronAPI.getDocumentNotes(documentId),
      ])

      return {
        pdf,
        histories: Array.isArray(histories) ? histories : [],
        annotations: Array.isArray(annotations) ? annotations : [],
        notes: Array.isArray(notes) ? notes : [],
      }
    }))
  }

  function hasSelectedContentExportOption(options) {
    return Boolean(options?.exportHistories || options?.exportAnnotations || options?.exportNotes)
  }

  function assertContentExportSelection(options) {
    if (!hasSelectedContentExportOption(options)) {
      throw new Error('请至少选择一项导出内容')
    }
  }

  function toggleContentExportOption(setter, key) {
    setter((currentOptions) => ({
      ...currentOptions,
      [key]: !currentOptions[key],
    }))
  }

  async function exportCurrentPdfMarkdown() {
    if (!currentDocument?.documentId) {
      setExportStatus('请先打开 PDF')
      return
    }
    if (!window.electronAPI?.saveMarkdownFile) {
      setExportStatus('Markdown 导出仅在桌面版可用')
      return
    }

    setIsMarkdownExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(markdownExportOptions)
      const [item] = await collectMarkdownExportItems([currentDocument.documentId])
      const result = await window.electronAPI.saveMarkdownFile({
        markdown: buildPdfMarkdown(item, markdownExportOptions),
        defaultFileName: makeSafeMarkdownFileName(getPdfDisplayName(item.pdf)),
      })
      if (!result?.canceled) {
        setExportStatus(`已导出 Markdown：${result.filePath}`)
      }
    } catch (error) {
      setExportStatus(error.message || '导出 Markdown 失败')
    } finally {
      setIsMarkdownExporting(false)
    }
  }

  async function exportMergedMarkdown() {
    if (!selectedMarkdownDocumentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }
    if (!window.electronAPI?.saveMarkdownFile) {
      setExportStatus('Markdown 导出仅在桌面版可用')
      return
    }

    setIsMarkdownExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(markdownExportOptions)
      const items = await collectMarkdownExportItems(selectedMarkdownDocumentIds)
      const result = await window.electronAPI.saveMarkdownFile({
        markdown: buildBatchPdfMarkdown(items, markdownExportOptions),
        defaultFileName: makeSafeMarkdownFileName(`Markdown合集_${items.length}篇文献`),
      })
      if (!result?.canceled) {
        setExportStatus(`已合并导出 Markdown：${result.filePath}`)
      }
    } catch (error) {
      setExportStatus(error.message || '合并导出 Markdown 失败')
    } finally {
      setIsMarkdownExporting(false)
    }
  }

  async function exportBatchMarkdownFiles() {
    if (!selectedMarkdownDocumentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }
    if (!window.electronAPI?.saveMarkdownBatchFiles) {
      setExportStatus('Markdown 导出仅在桌面版可用')
      return
    }

    setIsMarkdownExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(markdownExportOptions)
      const items = await collectMarkdownExportItems(selectedMarkdownDocumentIds)
      const result = await window.electronAPI.saveMarkdownBatchFiles({
        files: items.map((item) => ({
          fileName: makeSafeMarkdownFileName(getPdfDisplayName(item.pdf)),
          markdown: buildPdfMarkdown(item, markdownExportOptions),
        })),
      })
      if (!result?.canceled) {
        setExportStatus(`已批量导出 ${result.filePaths?.length || 0} 个 Markdown 文件到：${result.outputDir}`)
      }
    } catch (error) {
      setExportStatus(error.message || '批量导出 Markdown 失败')
    } finally {
      setIsMarkdownExporting(false)
    }
  }

  function formatPdfReportErrors(errors = []) {
    return errors
      .map((item) => `${item.fileName || '未命名文件'}：${item.error || '未知错误'}`)
      .join('；')
  }

  function showPdfReportError(message) {
    const text = message || '导出 PDF 报告失败'
    setExportStatus(text)
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(`导出 PDF 失败：${text}`)
    }
  }

  function assertPdfReportHtml(html) {
    const safeHtml = String(html || '').trim()
    if (!safeHtml) throw new Error('没有可导出的 PDF HTML 内容')
    return safeHtml
  }

  async function exportCurrentPdfReport() {
    if (!currentDocument?.documentId) {
      setExportStatus('请先打开 PDF')
      return
    }
    if (!window.electronAPI?.savePdfReport) {
      setExportStatus('PDF 报告导出仅在桌面版可用')
      return
    }

    setIsPdfReportExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(pdfReportExportOptions)
      const [item] = await collectMarkdownExportItems([currentDocument.documentId], 'PDF 报告导出')
      const html = assertPdfReportHtml(buildPdfReportHtml(item, pdfReportExportOptions))
      const result = await window.electronAPI.savePdfReport({
        html,
        defaultFileName: makeSafePdfReportFileName(getPdfDisplayName(item.pdf)),
      })

      if (result?.error) {
        showPdfReportError(result.error)
      } else if (!result?.canceled) {
        setExportStatus(`已导出 PDF 报告：${result.filePath}`)
      }
    } catch (error) {
      showPdfReportError(error.message || '导出 PDF 报告失败')
    } finally {
      setIsPdfReportExporting(false)
    }
  }

  async function exportMergedPdfReport() {
    if (!selectedPdfReportDocumentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }
    if (!window.electronAPI?.savePdfReport) {
      setExportStatus('PDF 报告导出仅在桌面版可用')
      return
    }

    setIsPdfReportExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(pdfReportExportOptions)
      const items = await collectMarkdownExportItems(selectedPdfReportDocumentIds, 'PDF 报告导出')
      const html = assertPdfReportHtml(buildBatchPdfReportHtml(items, pdfReportExportOptions))
      const result = await window.electronAPI.savePdfReport({
        html,
        defaultFileName: makeSafePdfReportFileName(`PDF报告合集_${items.length}篇文献`),
      })

      if (result?.error) {
        showPdfReportError(result.error)
      } else if (!result?.canceled) {
        setExportStatus(`已合并导出 PDF 报告：${result.filePath}`)
      }
    } catch (error) {
      showPdfReportError(error.message || '合并导出 PDF 报告失败')
    } finally {
      setIsPdfReportExporting(false)
    }
  }

  async function exportBatchPdfReports() {
    if (!selectedPdfReportDocumentIds.length) {
      setExportStatus('请先选择要导出的文献')
      return
    }
    if (!window.electronAPI?.saveBatchPdfReports) {
      setExportStatus('PDF 报告导出仅在桌面版可用')
      return
    }

    setIsPdfReportExporting(true)
    setExportStatus('')
    try {
      assertContentExportSelection(pdfReportExportOptions)
      const items = await collectMarkdownExportItems(selectedPdfReportDocumentIds, 'PDF 报告导出')
      const result = await window.electronAPI.saveBatchPdfReports({
        files: items.map((item) => ({
          fileName: makeSafePdfReportFileName(getPdfDisplayName(item.pdf)),
          html: assertPdfReportHtml(buildPdfReportHtml(item, pdfReportExportOptions)),
        })),
      })

      if (result?.error || result?.errors?.length) {
        const detail = formatPdfReportErrors(result.errors || [])
        const exportedCount = result.filePaths?.length || 0
        const message = detail
          ? `已导出 ${exportedCount} 个，失败 ${result.errors.length} 个：${detail}`
          : result.error
        showPdfReportError(message)
      } else if (!result?.canceled) {
        setExportStatus(`已批量导出 ${result.filePaths?.length || 0} 个 PDF 报告到：${result.outputDir}`)
      }
    } catch (error) {
      showPdfReportError(error.message || '批量导出 PDF 报告失败')
    } finally {
      setIsPdfReportExporting(false)
    }
  }

  async function addMergeExportFile() {
    setExportStatus('')
    try {
      const result = await window.electronAPI.selectPaperReaderExportFileForMerge()
      if (!result?.canceled && result.file) {
        setMergeExportFiles((currentFiles) => {
          if (currentFiles.some((file) => file.filePath === result.file.filePath)) {
            setExportStatus('该文件已添加')
            return currentFiles
          }
          return [...currentFiles, result.file]
        })
      }
    } catch (error) {
      setExportStatus(error.message || '添加待合并文件失败')
    }
  }

  async function mergePaperReaderExportFiles() {
    if (!mergeExportFiles.length) {
      setExportStatus('请先添加要合并的导出文件')
      return
    }

    setMergeNameDraft('我的合集')
    setMergeNameDialog({
      filePaths: mergeExportFiles.map((file) => file.filePath).filter(Boolean),
      documentCount: mergeExportFiles.reduce((count, file) => count + (Number(file.documentCount) || 0), 0),
    })
  }

  async function confirmMergePaperReaderExportFiles() {
    const filePaths = Array.isArray(mergeNameDialog?.filePaths) ? mergeNameDialog.filePaths.filter(Boolean) : []
    if (!filePaths.length) {
      setMergeNameDialog(null)
      setExportStatus('请先添加要合并的导出文件')
      return
    }

    const userExportName = mergeNameDraft.trim() || '我的合集'
    setExportStatus('')
    try {
      const result = await window.electronAPI.mergePaperReaderExportFiles(filePaths, userExportName)
      if (!result?.canceled) {
        setExportStatus(`已合并 ${result.documentCount || 0} 份数据：${result.filePath}`)
      }
      setMergeNameDialog(null)
    } catch (error) {
      setExportStatus(error.message || '合并导出文件失败')
    }
  }

  async function splitPaperReaderExportFile() {
    setExportStatus('')
    try {
      const result = await window.electronAPI.splitPaperReaderExportFile()
      if (!result?.canceled) {
        setExportStatus(`已拆分 ${result.filePaths?.length || 0} 个文件到：${result.outputDir}`)
      }
    } catch (error) {
      setExportStatus(error.message || '拆分导出文件失败')
    }
  }

  function toggleExportDocument(documentId) {
    setSelectedExportDocumentIds((currentIds) =>
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId],
    )
  }

  function toggleMarkdownDocument(documentId) {
    setSelectedMarkdownDocumentIds((currentIds) =>
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId],
    )
  }

  function togglePdfReportDocument(documentId) {
    setSelectedPdfReportDocumentIds((currentIds) =>
      currentIds.includes(documentId)
        ? currentIds.filter((id) => id !== documentId)
        : [...currentIds, documentId],
    )
  }

  function getMergeExportFileDisplayName(file) {
    return file?.fileName || file?.exportName || '未命名文件'
  }

  useEffect(() => {
    settingsFormRef.current = { ...settingsForm, rightPanelWidth }
    rightPanelWidthRef.current = rightPanelWidth
  }, [settingsForm, rightPanelWidth])

  useEffect(() => {
    if (settingsTab === 'importExport') {
      void loadExportSettingsData()
    }
  }, [settingsTab])

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
    if (!noteDialog) return undefined

    const focusTimer = window.setTimeout(() => {
      const targetInput = noteTitleInputRef.current || noteTextareaRef.current

      targetInput?.focus({ preventScroll: true })

      if (import.meta.env.DEV) {
        const inspectedFields = [noteTitleInputRef.current, noteTextareaRef.current].filter(Boolean)

        for (const field of inspectedFields) {
          const rect = field.getBoundingClientRect()
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          const topElement = document.elementFromPoint(centerX, centerY)

          console.log('[PaperReader] note dialog focus debug', {
            field: field.tagName,
            fieldClassName: field.className,
            activeElement: document.activeElement?.tagName,
            topElement: topElement?.tagName,
            topElementClassName: topElement?.className,
            isFieldReachable: topElement === field || field.contains(topElement),
            bodyClassName: document.body.className,
            states: {
              isFullscreen,
              isOcrMode,
              isOcrDragging,
              isResizingPanel,
              isAnnotationToolbarOpen,
              hasHighlightContextMenu: Boolean(highlightContextMenu),
              hasImagePreview: Boolean(imagePreview),
              hasDiagramResult: Boolean(diagramResult),
              hasCompareResult: Boolean(compareResult),
            },
          })
        }
      }
    }, 50)

    return () => window.clearTimeout(focusTimer)
  }, [
    compareResult,
    diagramResult,
    highlightContextMenu,
    imagePreview,
    isAnnotationToolbarOpen,
    isFullscreen,
    isOcrDragging,
    isOcrMode,
    isResizingPanel,
    noteDialog,
  ])

  useEffect(() => {
    if (!mergeNameDialog) return undefined

    const focusTimer = window.setTimeout(() => {
      mergeNameInputRef.current?.focus({ preventScroll: true })
      mergeNameInputRef.current?.select()
    }, 0)

    return () => window.clearTimeout(focusTimer)
  }, [mergeNameDialog])

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

    function updatePageWidth(containerWidth, containerHeight) {
      const roundedContainerWidth = Math.floor(containerWidth)
      const roundedContainerHeight = Math.floor(containerHeight)
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
      const availableWidth = Math.max(160, roundedContainerWidth - sideSpace)
      const availableHeight = Math.max(160, roundedContainerHeight - sideSpace)
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
      if (!pdfViewerRef.current) return

      updatePageWidth(pdfViewerRef.current.clientWidth, pdfViewerRef.current.clientHeight)
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]

      if (!entry) return

      const nextWidth = Math.floor(entry.contentRect.width)
      const nextHeight = Math.floor(entry.contentRect.height)

      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }

      animationFrameId = requestAnimationFrame(() => {
        if (sidebarResizeSettlingRef.current && !isFullscreen) {
          return
        }

        updatePageWidth(nextWidth, nextHeight)
      })
    })

    resizeObserver.observe(pdfViewer)
    animationFrameId = requestAnimationFrame(() => {
      updatePageWidth(pdfViewer.clientWidth, pdfViewer.clientHeight)
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
        const nextTranslation = await requestTranslation(text)

        if (currentRequestId !== requestIdRef.current) return

        lastTranslatedTextRef.current = text
        setTranslation(nextTranslation)
        setTranslationStatus('success')
        setSuccessfulRightPanelResult({
          type: 'text-selection',
          title: '翻译结果',
          selectedText: text,
          translation: nextTranslation,
          timestamp: Date.now(),
        })
      } catch (error) {
        if (currentRequestId !== requestIdRef.current) return

        setTranslation(`${UI.errorPrefix}${error.message || UI.translateError}`)
        setTranslationStatus('error')
      }
    }, 300)

    return () => clearTimeout(timerId)
  }, [selectedText, setSuccessfulRightPanelResult])

  async function requestTranslation(text) {
    const response = await fetch(`${API_BASE_URL}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || UI.translateError)
    }

    return data.translation
  }

  function applyOpenedPdf(pdfFile, restoreRecord = null) {
    if (!pdfFile?.dataUrl && !pdfFile?.url) return

    const nextDocument = {
      id: pdfFile.documentId,
      documentId: pdfFile.documentId,
      filePath: pdfFile.filePath || '',
      fileName: pdfFile.fileName || 'PDF',
      fileSize: Number(pdfFile.fileSize) || 0,
    }
    const nextTabId = getPdfTabId(nextDocument.documentId, nextDocument.filePath, nextDocument.fileName)
    const nextPdfUrl = pdfFile.dataUrl || pdfFile.url
    const existingTab = pdfTabs.find((tab) =>
      tab.id === nextTabId ||
      tab.documentId === nextDocument.documentId ||
      (nextDocument.filePath && tab.filePath === nextDocument.filePath),
    )

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

  function getLibraryProgress(document) {
    if (!document?.totalPages) return '未开始'
    const page = Math.min(Number(document.lastPage) || 1, Number(document.totalPages) || 1)
    return `${page} / ${document.totalPages}`
  }

  function getLibraryProgressPercent(document) {
    if (!document?.totalPages) return 0
    return Math.min(100, Math.max(0, Math.round(((Number(document.lastPage) || 1) / document.totalPages) * 100)))
  }

  function getVisibleLibraryDocuments() {
    const query = librarySearch.trim().toLowerCase()

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

  function openLibraryFolderDialog() {
    setLibraryFolderNameDraft('')
    setLibraryFolderNameError('')
    setLibraryFolderDialogOpen(true)
  }

  function closeLibraryFolderDialog() {
    setLibraryFolderDialogOpen(false)
    setLibraryFolderNameDraft('')
    setLibraryFolderNameError('')
  }

  async function confirmCreateLibraryFolder() {
    const name = libraryFolderNameDraft.trim()

    if (!name) {
      setLibraryFolderNameError('文件夹名称不能为空')
      return
    }

    if (libraryFolders.some((folder) => folder.name.trim().toLowerCase() === name.toLowerCase())) {
      setLibraryFolderNameError('已存在同名文件夹')
      return
    }

    try {
      const library = await window.electronAPI.createLibraryFolder(name)
      updateLibraryState(library)
      setSelectedLibraryFolderId(library.folders.at(-1)?.id || selectedLibraryFolderId)
      closeLibraryFolderDialog()
      setLibraryStatus('文件夹已创建')
    } catch (error) {
      setLibraryFolderNameError(error.message || '创建文件夹失败')
    }
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
    setLibraryMoveDialog({
      documentIds: ids,
      currentFolderId,
      targetFolderId: currentFolderId || '',
      x: position?.x ?? Math.min(window.innerWidth - 260, Math.max(24, window.innerWidth / 2 - 120)),
      y: position?.y ?? Math.min(window.innerHeight - 260, Math.max(72, window.innerHeight / 2 - 120)),
    })
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

  async function deleteLibraryDocuments(documentIds = selectedLibraryDocumentIds) {
    if (!documentIds.length) return
    if (!window.confirm('确定要从文献库删除选中的文献吗？不会删除 PDF 文件和已有笔记/批注。')) return

    try {
      const library = await window.electronAPI.deleteLibraryDocuments(documentIds)
      updateLibraryState(library)
      setSelectedLibraryDocumentIds([])
      setLibraryContextMenu(null)
      setLibraryStatus('已从文献库删除')
    } catch (error) {
      setLibraryStatus(error.message || '删除文献失败')
    }
  }

  async function openLibraryDocument(document) {
    if (!document?.filePath) return

    const existingTab = pdfTabs.find((tab) =>
      tab.documentId === document.documentId ||
      (document.filePath && tab.filePath === document.filePath),
    )

    if (existingTab) {
      setActiveModule('reader')
      activatePdfTab(existingTab.id)
      return
    }

    if (!window.electronAPI?.openPdfFromPath) {
      setLibraryStatus('当前环境无法从路径打开 PDF')
      return
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
    } catch (error) {
      setLibraryStatus(error.message || '文件不存在或已移动')
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
    const provider = Object.hasOwn(PROVIDERS, config.provider) ? config.provider : 'deepseek'
    const providerDefaults = PROVIDERS[provider]

    return {
      provider,
      apiKey: config.apiKey || config.deepseekApiKey || '',
      baseUrl: config.baseUrl || config.deepseekBaseUrl || providerDefaults.baseUrl,
      model: config.model || config.deepseekModel || providerDefaults.model,
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
      void loadSettingsData()
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

  function updateSettingsProvider(provider) {
    setSettingsForm((currentSettings) => ({
      ...currentSettings,
      provider,
      baseUrl: PROVIDERS[provider].baseUrl,
      model: PROVIDERS[provider].model,
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

    setIsSavingSettings(true)
    setSettingsStatus('')

    try {
      const savedConfig = await window.electronAPI.saveConfig({ ...settingsForm, rightPanelWidth })
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
    }
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

    if (isScientificExpressionOnly(normalizedText)) return false
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
    const isNearEdge = block.nearEdge || (block.sourceBlocks || []).some((sourceBlock) => sourceBlock.nearEdge)
    const isShortLabel = isUsefulShortOcrLabel(block.text)
    if (isLikelyOcrNoiseText(block.text, block.confidence, isNearEdge)) return false
    if (Number.isFinite(block.confidence) && block.confidence < (isNearEdge || isShortLabel ? 18 : 35)) return false

    return isMeaningfulEnglishText(block.text)
  }

  function getTranslatableOcrText(text) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const validLines = lines.filter((line) => isMeaningfulEnglishText(line))

    if (validLines.length) {
      return validLines.join('\n')
    }

    return isMeaningfulEnglishText(text) ? text : ''
  }

  function isUselessTranslationResult(text) {
    const normalizedText = text.replace(/\s+/g, ' ').trim().toLowerCase()

    if (!normalizedText) return true

    return [
      '请提供需要翻译的英文文本',
      '请提供要翻译的文本',
      '请提供需要翻译',
      '无法翻译',
      '无法进行翻译',
      '不是英文',
      '不是英文学术文本',
      'provide the english text',
      'please provide',
      'no translatable text',
      'cannot translate',
      'unable to translate',
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

  function shouldMergeWrappedLine(previousBlock, nextBlock, options = {}) {
    if (!previousBlock || !nextBlock) return false
    const previousLine = getLastSourceLine(previousBlock)
    const nextLine = getFirstSourceLine(nextBlock)
    const strict = options.strict === true
    const diagram = options.diagram === true

    if (isNewListOrTableRow(nextLine) && !diagram) return false
    if (isLikelyFormulaOrTableLine(previousLine.text) || isLikelyFormulaOrTableLine(nextLine.text)) return false
    if (!isLikelySameTextRegion(previousLine, nextLine, options)) return false

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
    const previousEndsListIntro = /[:：]$/.test(previousText)
    const nextLooksLikeListItem = isNewListOrTableRow(nextLine) || nextWords <= 4
    const diagramShortStack =
      diagram &&
      previousWords <= 4 &&
      nextWords <= 4 &&
      verticalGap >= -lineHeight * 0.25 &&
      verticalGap < lineHeight * 1.35 &&
      Math.abs(previousLine.x - nextLine.x) < lineHeight * 1.8
    const diagramListContinuation =
      diagram &&
      (previousEndsListIntro || previousWords <= 5 || nextLooksLikeListItem) &&
      nextWords <= 7 &&
      verticalGap >= -lineHeight * 0.25 &&
      verticalGap < lineHeight * 1.55
    const previousLooksLikeHeading =
      previousWords <= 8 &&
      nextWords >= 6 &&
      previousLine.width < nextLine.width * 0.75 &&
      /^[A-Z0-9]/.test(previousText)
    const bodyWrap = previousWords >= 5 && nextWords >= 2 && (/^[a-z(]/.test(nextText) || previousWords >= 8)
    const titleWrap = previousWords >= 2 && nextWords >= 2 && (previousEndsOpen || nextContinues)
    const continuousBody = previousWords >= 5 && nextWords >= 3 && !previousLooksLikeHeading

    if (hasSentenceEnding(previousText) && !diagramListContinuation) return false
    if (nextStartsLikeHeading && !previousEndsOpen) return false
    if (previousLooksLikeHeading && !previousEndsOpen) return false
    if (
      strict &&
      !diagramShortStack &&
      !diagramListContinuation &&
      verticalGap > lineHeight * 0.72 &&
      !previousEndsOpen &&
      !nextContinues
    ) {
      return false
    }

    if (diagram && (diagramShortStack || diagramListContinuation)) return true

    if (strict) {
      return previousEndsOpen || nextContinues || bodyWrap || titleWrap || (continuousBody && previousWords >= 7)
    }

    return previousEndsOpen || nextContinues || bodyWrap || titleWrap || continuousBody
  }

  function mergeOcrBlocks(blocks, index) {
    const sourceBlocks = blocks.flatMap((block) => block.sourceBlocks || [block])
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
      nearEdge: sourceBlocks.some((block) => block.nearEdge),
      confidence:
        sourceBlocks.reduce((sum, block) => sum + (Number(block.confidence) || 0), 0) /
        Math.max(sourceBlocks.length, 1),
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
        bbox: {
          x0: block.x,
          y0: block.y,
          x1: block.x + block.width,
          y1: block.y + block.height,
        },
      })),
    })

    return nextBlocks.slice(0, 100)
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
      }))
      .sort((firstBlock, secondBlock) => firstBlock.y - secondBlock.y || firstBlock.x - secondBlock.x)
  }

  function getCompareModuleRect(segments, canvasWidth, canvasHeight, padding = 0) {
    const x0 = Math.min(...segments.map((segment) => segment.x))
    const y0 = Math.min(...segments.map((segment) => segment.y))
    const x1 = Math.max(...segments.map((segment) => segment.x + segment.width))
    const y1 = Math.max(...segments.map((segment) => segment.y + segment.height))
    const x = clampNumber(x0 - padding, 0, canvasWidth - 1)
    const y = clampNumber(y0 - padding, 0, canvasHeight - 1)

    return {
      x,
      y,
      width: Math.max(12, Math.min(x1 - x0 + padding * 2, canvasWidth - x)),
      height: Math.max(8, Math.min(y1 - y0 + padding * 2, canvasHeight - y)),
    }
  }

  function getCompareLineRects(segments, canvasWidth, canvasHeight, padding = 0) {
    return segments.map((segment) => {
      const x = clampNumber(segment.x - padding, 0, canvasWidth - 1)
      const y = clampNumber(segment.y - padding, 0, canvasHeight - 1)
      const width = Math.max(8, Math.min(segment.width + padding * 2, canvasWidth - x))
      const height = Math.max(6, Math.min(segment.height + padding * 2, canvasHeight - y))

      return { x, y, width, height }
    })
  }

  function getCompareCanvasFont(fontSize) {
    return `${fontSize}px "Microsoft YaHei", Arial, sans-serif`
  }

  function getCompareTextSlots(segments, fontSize, canvasWidth, canvasHeight) {
    const lineRects = getCompareLineRects(segments, canvasWidth, canvasHeight)
    const horizontalPadding = clampNumber(fontSize * 0.22, 3, 7)
    const verticalPadding = clampNumber(fontSize * 0.08, 1, 3)

    return lineRects.map((rect) => {
      const lineFontSize = clampNumber(Math.floor(Math.min(fontSize, rect.height * 0.92)), 10, fontSize)
      const minBackgroundHeight = lineFontSize * 1.18
      const backgroundX = clampNumber(rect.x - horizontalPadding, 0, canvasWidth - 1)
      const backgroundY = clampNumber(
        rect.y - verticalPadding,
        0,
        Math.max(0, canvasHeight - minBackgroundHeight),
      )
      const backgroundWidth = Math.max(
        10,
        Math.min(rect.width + horizontalPadding * 2, canvasWidth - backgroundX),
      )
      const backgroundHeight = Math.max(
        minBackgroundHeight,
        Math.min(rect.height + verticalPadding * 2, canvasHeight - backgroundY),
      )
      const textAreaWidth = Math.max(8, backgroundWidth - horizontalPadding * 2)

      return {
        x: backgroundX + horizontalPadding,
        slotX: backgroundX + horizontalPadding,
        y: backgroundY + Math.max(0, (backgroundHeight - lineFontSize) / 2),
        maxWidth: textAreaWidth,
        lineHeight: backgroundHeight,
        fontSize: lineFontSize,
        backgroundRect: {
          x: backgroundX,
          y: backgroundY,
          width: backgroundWidth,
          height: backgroundHeight,
        },
      }
    })
  }

  function trimCanvasTextToWidth(context, text, maxWidth) {
    const characters = Array.from(text)
    let nextText = characters.join('')

    while (nextText && context.measureText(`${nextText}…`).width > maxWidth) {
      characters.pop()
      nextText = characters.join('')
    }

    return nextText ? `${nextText}…` : '…'
  }

  function wrapCanvasTextAcrossSlots(context, text, slots) {
    const normalizedText = text.replace(/\s+/g, ' ').trim()
    const characters = Array.from(normalizedText)
    const lines = []
    let cursor = 0

    slots.forEach((slot, slotIndex) => {
      if (cursor >= characters.length) return

      const remainingSlots = slots.slice(slotIndex)
      const remainingWidth = remainingSlots.reduce((sum, item) => sum + item.maxWidth, 0)
      const remainingCharacters = characters.length - cursor
      const targetCount =
        slotIndex === slots.length - 1
          ? remainingCharacters
          : Math.max(1, Math.round(remainingCharacters * (slot.maxWidth / Math.max(remainingWidth, 1))))
      let lineText = ''
      let lineCharacters = 0

      context.font = getCompareCanvasFont(slot.fontSize || 12)
      while (cursor < characters.length) {
        const remainingSlotsAfterCurrent = slots.length - slotIndex - 1
        const remainingAfterTakingNextCharacter = characters.length - cursor - 1

        if (
          lineText &&
          remainingSlotsAfterCurrent > 0 &&
          remainingAfterTakingNextCharacter < remainingSlotsAfterCurrent
        ) {
          break
        }

        const nextLine = `${lineText}${characters[cursor]}`
        if (lineText && context.measureText(nextLine).width > slot.maxWidth) break

        lineText = nextLine
        cursor += 1
        lineCharacters += 1

        if (
          slotIndex < slots.length - 1 &&
          lineCharacters >= targetCount &&
          characters.length - cursor >= remainingSlotsAfterCurrent
        ) {
          break
        }
      }

      if (lineText) {
        const text = lineText.trim() || lineText

        lines.push({
          ...slot,
          x: slot.x,
          slotX: slot.x,
          text,
        })
      }
    })

    const truncated = cursor < characters.length

    if (truncated && lines.length) {
      const lastLine = lines[lines.length - 1]
      context.font = getCompareCanvasFont(lastLine.fontSize || 12)
      lastLine.text = trimCanvasTextToWidth(context, `${lastLine.text}${characters.slice(cursor).join('')}`, lastLine.maxWidth)
      lastLine.x = lastLine.slotX ?? lastLine.x
    }

    return { lines, truncated }
  }

  function hasOverlappingCompareLineBackgrounds(slots) {
    for (let index = 1; index < slots.length; index += 1) {
      const previousRect = slots[index - 1].backgroundRect
      const currentRect = slots[index].backgroundRect

      if (!previousRect || !currentRect) continue
      if (currentRect.y < previousRect.y + previousRect.height - 1) return true
    }

    return false
  }

  function shouldUseCompareModuleFallback(segments, slots) {
    if (segments.length < 2) return false

    const sortedSegments = segments.slice().sort((firstSegment, secondSegment) => firstSegment.y - secondSegment.y)
    const segmentHeights = sortedSegments.map((segment) => segment.height).filter((height) => height > 0)
    const averageHeight =
      segmentHeights.reduce((sum, height) => sum + height, 0) / Math.max(segmentHeights.length, 1)
    const gaps = sortedSegments.slice(1).map((segment, index) => segment.y - getBlockBottom(sortedSegments[index]))
    const averageGap = gaps.reduce((sum, gap) => sum + gap, 0) / Math.max(gaps.length, 1)
    const moduleHeight = Math.max(...sortedSegments.map((segment) => getBlockBottom(segment))) - Math.min(...sortedSegments.map((segment) => segment.y))
    const tightLineBoxes = averageHeight < 11 || averageGap < Math.max(1, averageHeight * 0.12)
    const denseModule =
      sortedSegments.length >= 5 &&
      averageGap < averageHeight * 0.28 &&
      averageHeight * sortedSegments.length > moduleHeight * 0.72

    return tightLineBoxes || denseModule || hasOverlappingCompareLineBackgrounds(slots)
  }

  function getCompareModuleFallbackPlan(context, block, segments, canvasWidth, canvasHeight, maxFontSize, minFontSize) {
    const modulePadding = clampNumber(maxFontSize * 0.34, 4, 8)
    const moduleRect = getCompareModuleRect(segments, canvasWidth, canvasHeight, modulePadding)
    const horizontalPadding = clampNumber(maxFontSize * 0.28, 4, 8)
    const verticalPadding = clampNumber(maxFontSize * 0.22, 3, 6)
    let fallback = {
      lines: [],
      fontSize: minFontSize,
      segments,
      moduleRect,
      backgroundRects: [moduleRect],
      mode: 'module-fallback',
      truncated: true,
    }

    for (let fontSize = clampNumber(maxFontSize, 11, 20); fontSize >= Math.max(10, minFontSize); fontSize -= 1) {
      context.font = getCompareCanvasFont(fontSize)
      const lineHeight = fontSize * 1.22
      const maxWidth = Math.max(8, moduleRect.width - horizontalPadding * 2)
      const maxLines = Math.max(1, Math.floor((moduleRect.height - verticalPadding * 2) / lineHeight))
      const wrappedLines = wrapCanvasText(context, block.translation, maxWidth)
      const lines = wrappedLines.slice(0, maxLines).map((line, index) => ({
        text: line,
        x: moduleRect.x + horizontalPadding,
        y: moduleRect.y + verticalPadding + index * lineHeight,
        maxWidth,
        lineHeight,
        fontSize,
      }))
      const truncated = wrappedLines.length > maxLines

      if (truncated && lines.length) {
        const lastLine = lines[lines.length - 1]
        lastLine.text = trimCanvasTextToWidth(context, `${lastLine.text}${wrappedLines.slice(maxLines).join('')}`, maxWidth)
      }

      fallback = {
        lines,
        fontSize,
        segments,
        moduleRect,
        backgroundRects: [moduleRect],
        mode: 'module-fallback',
        truncated,
      }

      if (lines.length && !truncated) return fallback
    }

    return fallback
  }

  function getCompareReplacementPlan(context, block, canvasWidth, canvasHeight) {
    const segments = getCompareSourceBlocks(block)
    const segmentHeights = segments.map((segment) => segment.height).filter((height) => height > 0)
    const baseHeight = median(segmentHeights) || block.height || 14
    const maxFontSize = clampNumber(Math.floor(baseHeight * 0.98), 12, 24)
    const minFontSize = Math.min(10, maxFontSize)
    const initialSlots = getCompareTextSlots(segments, maxFontSize, canvasWidth, canvasHeight)
    let fallback = null

    if (shouldUseCompareModuleFallback(segments, initialSlots)) {
      return getCompareModuleFallbackPlan(context, block, segments, canvasWidth, canvasHeight, maxFontSize, minFontSize)
    }

    for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 1) {
      const slots = getCompareTextSlots(segments, fontSize, canvasWidth, canvasHeight)
      const plan = wrapCanvasTextAcrossSlots(context, block.translation, slots)
      const moduleRect = getCompareModuleRect(segments, canvasWidth, canvasHeight, 0)
      fallback = {
        ...plan,
        fontSize,
        segments,
        moduleRect,
        backgroundRects: slots.map((slot) => slot.backgroundRect),
      }

      if (plan.lines.length && !plan.truncated) {
        return fallback
      }
    }

    return fallback?.lines?.length
      ? getCompareModuleFallbackPlan(context, block, segments, canvasWidth, canvasHeight, maxFontSize, minFontSize)
      : {
          lines: [],
          fontSize: minFontSize,
          segments,
          moduleRect: getCompareModuleRect(segments, canvasWidth, canvasHeight, 4),
          backgroundRects: getCompareTextSlots(segments, minFontSize, canvasWidth, canvasHeight).map((slot) => slot.backgroundRect),
        }
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

  async function translateOcrBlockText(text) {
    const protectedResult = protectOcrFormulaTokens(text)
    const chunks = splitOcrTextForTranslation(protectedResult.protectedText)
    const translations = []

    for (const chunk of chunks) {
      try {
        const translation = cleanResultText(await requestTranslation(chunk))
        translations.push(isUselessTranslationResult(translation) ? chunk : translation)
      } catch (error) {
        console.warn('OCR 模块分段翻译失败，使用原文兜底', {
          textLength: chunk.length,
          error: error.message,
        })
        translations.push(chunk)
      }
    }

    return restoreOcrFormulaTokens(translations.join('\n').trim(), protectedResult.tokens)
  }

  function getOcrTranslationFallback(block, sourceText, reason) {
    return {
      ...block,
      sourceText,
      translation: sourceText || block.text,
      translationFallback: true,
      translationError: reason,
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

  function scorePlacementCandidate(rect, block, placedRects, sourceRects, context, imageWidth, imageHeight) {
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

    return (
      blankScore * 0.42 +
      distanceScore * 0.34 +
      sideBonus -
      sourceOverlapRatio * 4.8 -
      placedOverlapRatio * 7.2 -
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
        score: scorePlacementCandidate(rect, block, placedRects, sourceRects, context, imageWidth, imageHeight),
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

  async function translateDiagramBlocks(blocks) {
    const translatedBlocks = []
    const translatableBlocks = blocks.filter((item) => shouldTranslateOcrBlock(item)).slice(0, 120)

    console.log('OCR 模块翻译统计', {
      inputCount: blocks.length,
      translatableCount: translatableBlocks.length,
      skippedCount: Math.max(0, blocks.length - translatableBlocks.length),
      moduleTextLengths: translatableBlocks.slice(0, 20).map((block) => block.text.length),
    })

    for (const block of translatableBlocks) {
      const sourceText = cleanOcrSourceForTranslation(block.text)

      try {
        const translation = cleanResultText(await translateOcrBlockText(sourceText))

        if (isUselessTranslationResult(translation)) {
          console.warn('OCR 图解/对照模式使用原文兜底', { text: block.text, translation })
          translatedBlocks.push(getOcrTranslationFallback(block, sourceText, 'empty-translation'))
          continue
        }

        translatedBlocks.push({
          ...block,
          sourceText,
          translation,
        })
      } catch (error) {
        console.warn('OCR 图解/对照模式单块翻译失败，使用原文兜底', {
          text: block.text,
          error: error.message,
        })
        translatedBlocks.push(getOcrTranslationFallback(block, sourceText, error.message))
      }
    }

    return translatedBlocks
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
    const rawX = item.x ?? item.left ?? item.x0
    const rawY = item.y ?? item.top ?? item.y0
    const rawWidth = item.width ?? (Number.isFinite(Number(item.x1)) && Number.isFinite(Number(rawX)) ? Number(item.x1) - Number(rawX) : undefined)
    const rawHeight = item.height ?? (Number.isFinite(Number(item.y1)) && Number.isFinite(Number(rawY)) ? Number(item.y1) - Number(rawY) : undefined)
    const x = normalizeMultimodalCoordinate(rawX, imageWidth)
    const y = normalizeMultimodalCoordinate(rawY, imageHeight)
    const width = normalizeMultimodalCoordinate(rawWidth, imageWidth)
    const height = normalizeMultimodalCoordinate(rawHeight, imageHeight)

    if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null

    return {
      x: clampNumber(x, 0, Math.max(imageWidth - 1, 0)),
      y: clampNumber(y, 0, Math.max(imageHeight - 1, 0)),
      width: Math.max(1, Math.min(width, Math.max(imageWidth - x, 1))),
      height: Math.max(1, Math.min(height, Math.max(imageHeight - y, 1))),
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

  function getMultimodalUnionRect(rects) {
    if (!rects.length) return null

    const x0 = Math.min(...rects.map((rect) => rect.x))
    const y0 = Math.min(...rects.map((rect) => rect.y))
    const x1 = Math.max(...rects.map((rect) => rect.x + rect.width))
    const y1 = Math.max(...rects.map((rect) => rect.y + rect.height))

    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  function normalizeMultimodalTranslationBlocks(rawBlocks = [], imageSize = {}) {
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
            const text = getMultimodalTextValue(line, ['text', 'sourceText', 'originalText', 'lineText'])
            if (!rect || !text) return null

            return {
              index: lineIndex,
              text,
              ...rect,
              confidence: Number(line.confidence) || 100,
            }
          })
          .filter(Boolean)
        const rect = normalizeMultimodalRect(block, imageSize) || getMultimodalUnionRect(sourceBlocks)
        const text = cleanOcrSourceForTranslation(
          getMultimodalTextValue(block, ['text', 'sourceText', 'originalText', 'moduleText']) ||
          sourceBlocks.map((line) => line.text).join(' '),
        )
        const translation = cleanResultText(getMultimodalTextValue(block, ['translation', 'translatedText', 'targetText', 'result']))

        if (!rect || !text || !translation || isUselessTranslationResult(translation)) return null

        return {
          index,
          text,
          sourceText: text,
          translation,
          ...rect,
          confidence: Number(block.confidence) || 100,
          sourceBlocks: sourceBlocks.length
            ? sourceBlocks
            : [{ index: 0, text, ...rect, confidence: Number(block.confidence) || 100 }],
          multimodal: true,
        }
      })
      .filter(Boolean)
      .slice(0, 120)
  }

  async function requestMultimodalImageTranslation(image, imageSize, mode) {
    const response = await fetch(`${API_BASE_URL}/multimodal-translate-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image,
        mode,
        imageWidth: imageSize.width,
        imageHeight: imageSize.height,
      }),
    })
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || '多模态翻译失败')
    }

    const blocks = normalizeMultimodalTranslationBlocks(data.blocks || [], imageSize)
    if (!blocks.length) throw new Error('多模态翻译未返回可用文字模块')

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
  }) {
    if (mode === 'compare') {
      const translatedImage = await createCompareResultImage(recognitionImage, croppedImage, translatedBlocks)
      const layout = getCompareLayoutByAspectRatio(croppedImage.width, croppedImage.height)
      const nextCompareResult = {
        originalImage: image,
        translatedImage,
        layout,
      }

      setSuccessfulRightPanelResult({
        type: 'ocr-compare',
        title: '对照模式结果',
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
      translatedBlocks,
      sourceBlocks || translatedBlocks,
    )

    setSuccessfulRightPanelResult({
      type: 'ocr-diagram',
      title: '图解模式结果',
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

  async function createDiagramResultImage(imageUrl, imageSize, translatedBlocks, sourceBlocks = translatedBlocks) {
    const sourceImage = await loadImage(imageUrl)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    const placedRects = []

    canvas.width = imageSize.width || sourceImage.naturalWidth
    canvas.height = imageSize.height || sourceImage.naturalHeight
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height)
    const sourceRects = getDiagramSourceRects(sourceBlocks)

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
        context,
      )

      console.log('OCR 图解模式译文位置', {
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
      placedRects.push(rect)
      context.save()
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
    })

    return canvas.toDataURL('image/png')
  }

  async function createCompareResultImage(imageUrl, imageSize, translatedBlocks) {
    const sourceImage = await loadImage(imageUrl)
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = imageSize.width || sourceImage.naturalWidth
    canvas.height = imageSize.height || sourceImage.naturalHeight
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height)

    translatedBlocks.forEach((block) => {
      const plan = getCompareReplacementPlan(context, block, canvas.width, canvas.height)
      if (!plan.lines.length) return

      context.save()
      // 对照模式：每行单独白底，保留轻微透明感（仅影响对照模式，不影响图解模式）。
      context.fillStyle = 'rgba(255, 255, 255, 0.9)'
      plan.backgroundRects.forEach((rect) => {
        context.fillRect(rect.x, rect.y, rect.width, rect.height)
      })

      context.textBaseline = 'top'
      context.fillStyle = '#111827'
      plan.lines.forEach((line) => {
        context.font = getCompareCanvasFont(line.fontSize || plan.fontSize)
        context.fillText(line.text, line.x, line.y)
      })
      context.restore()
    })

    return canvas.toDataURL('image/png')
  }

  function getCompareLayoutByAspectRatio(width, height) {
    const aspectRatio = width / Math.max(height, 1)

    return aspectRatio >= 1.4 ? 'vertical' : 'horizontal'
  }

  async function runOcrTranslation(rect, mode = 'sidebar') {
    let worker = null

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
      setOcrResult({
        status: mode === 'diagram' ? 'diagram-recognizing' : mode === 'compare' ? 'compare-recognizing' : 'recognizing',
        mode,
        image: recognitionImage,
        text: '',
        translation: '',
        error: '',
      })

      if ((mode === 'diagram' || mode === 'compare') && settingsFormRef.current.enableMultimodalTranslation) {
        try {
          setOcrResult({
            status: mode === 'diagram' ? 'diagram-translating' : 'compare-translating',
            mode,
            image: recognitionImage,
            text: '',
            translation: '',
            error: '',
          })
          const translatedBlocks = await requestMultimodalImageTranslation(recognitionImage, croppedImage, mode)

          console.log('多模态图解/对照模式结果', {
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
            recognitionImage,
            croppedImage,
            translatedBlocks,
            sourceBlocks: translatedBlocks,
            ocrSelectionRect,
          })
          return
        } catch (error) {
          console.warn('多模态图解/对照模式失败，回退到原 OCR 流程', {
            mode,
            error: error.message,
          })
          setOcrResult({
            status: mode === 'diagram' ? 'diagram-recognizing' : 'compare-recognizing',
            mode,
            image: recognitionImage,
            text: '',
            translation: '',
            error: '',
          })
        }
      }

      worker = await createWorker('eng', 1, {
        workerPath: `${TESSERACT_ASSET_BASE}/worker.min.js`,
        corePath: `${TESSERACT_ASSET_BASE}/core/tesseract-core-simd-lstm.wasm.js`,
        langPath: `${TESSERACT_ASSET_BASE}/lang`,
        cacheMethod: 'none',
      })
      const { data } = await worker.recognize(recognitionImage, {}, { text: true, blocks: true })
      const recognizedText = cleanOcrText(data.text || '')

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
        const textBlocks = getOcrTextBlocks(data, croppedImage, {
          strict: mode === 'compare' || mode === 'diagram',
          diagram: mode === 'diagram',
        })
        const validTextBlocks = textBlocks.filter((block) => shouldTranslateOcrBlock(block))

        console.log('OCR 模块流程统计', {
          mode,
          rawLineCount: collectOcrLines(data).length,
          mergedModuleCount: textBlocks.length,
          validModuleCount: validTextBlocks.length,
          moduleTextLengths: validTextBlocks.slice(0, 20).map((block) => block.text.length),
        })

        if (!validTextBlocks.length) {
          throw new Error('未识别到可翻译的英文文本')
        }

        const translatedBlocks = await translateDiagramBlocks(validTextBlocks)

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
        })
        return
      }

      const sidebarTextBlocks = getOcrTextBlocks(data, croppedImage)
      const logicalOcrText = sidebarTextBlocks.length
        ? sidebarTextBlocks.map((block) => block.text).join('\n')
        : recognizedText
      const translatableText = getTranslatableOcrText(logicalOcrText)

      if (!translatableText) {
        setOcrResult({
          status: 'error',
          mode,
          image: recognitionImage,
          text: recognizedText,
          translation: '',
          error: '未识别到可翻译的英文文本',
        })
        return
      }

      const nextTranslation = cleanResultText(await requestTranslation(translatableText))

      if (isUselessTranslationResult(nextTranslation)) {
        setOcrResult({
          status: 'error',
          mode,
          image: recognitionImage,
          text: recognizedText,
          translation: '',
          error: '未识别到可翻译的英文文本',
        })
        return
      }

      setSuccessfulRightPanelResult({
        type: 'ocr-text',
        title: '文本模式结果',
        screenshotDataUrl: recognitionImage,
        ocrText: recognizedText,
        translation: nextTranslation,
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

    if (isOcrMode) {
      handleOcrSelectionMove(event)
      return
    }

    if (!isSelectingRef.current) return

    scheduleSelectionHighlightUpdate()
  }

  async function handleTextSelection(event) {
    if (event?.target && isInteractiveElement(event.target)) {
      isSelectingRef.current = false
      setPreviewHighlight(null)
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
    const selectionText = selection.toString().trim()
    const formattedText = getFormattedSelectionText(selection, selectionText)
    const text = formattedText.trim()

    if (!text || text.length <= 1) {
      setPreviewHighlight(null)
      clearTranslation()
      return
    }

    const nextHighlightRects = getSelectionHighlightRects(selection)
    setHighlightRects(nextHighlightRects)

    if (nextHighlightRects.length === 0) {
      setPreviewHighlight(null)
      return
    }

    if (annotationColor && currentDocument?.documentId) {
      const pageBox = getCurrentPageBox()
      const rects = nextHighlightRects
        .map((rect) => normalizeViewerRectToPage(rect, pageBox))
        .filter(Boolean)

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
        setActiveAnnotationId(annotation.id)
        setAnnotationStatus('')
      } else if (rects.length) {
        setAnnotationStatus('已存在相同高亮')
      }

      window.getSelection()?.removeAllRanges()
      setHighlightRects([])
      setPreviewHighlight(null)
      return
    }

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
      if (isInteractiveElement(event.target)) {
        isSelectingRef.current = false
        setPreviewHighlight(null)
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
              📝
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
    return (
      <fieldset className="content-export-options">
        <legend>导出内容</legend>
        <div className="content-export-option-list">
          {CONTENT_EXPORT_OPTION_ITEMS.map((item) => (
            <label className="content-export-option" key={item.key}>
              <input
                type="checkbox"
                checked={Boolean(options[item.key])}
                disabled={disabled}
                onChange={() => toggleContentExportOption(setOptions, item.key)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    )
  }

  function renderImportExportSettings() {
    return (
      <div className="settings-dialog module-settings-panel import-export-settings-panel">
        <div className="settings-dialog-body">
          <nav className="settings-tabs" aria-label="导入与导出分类">
          <button
            type="button"
            className={importExportTab === 'importExport' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('importExport')}
          >
            导入与导出
          </button>
          <button
            type="button"
            className={importExportTab === 'mergeSplit' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('mergeSplit')}
          >
            合并与拆分
          </button>
          <button
            type="button"
            className={importExportTab === 'markdown' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('markdown')}
          >
            导出 Markdown
          </button>
          <button
            type="button"
            className={importExportTab === 'pdfReport' ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setImportExportTab('pdfReport')}
          >
            导出 PDF
          </button>
          </nav>

          <div className="settings-content">
            <section className="settings-page import-export-page">

        {importExportTab === 'importExport' ? (
          <>
            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>默认导出位置</h3>
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
                <h3>批量自选导出</h3>
                <span>{selectedExportDocumentIds.length} / {exportableDocuments.length} 篇</span>
              </div>

              <div className="export-options-grid">
                <label className="settings-field">
                  <span>导出内容</span>
                  <select value={batchExportType} onChange={(event) => setBatchExportType(event.target.value)}>
                    <option value="translation-history">只导出翻译历史</option>
                    <option value="notes">只导出笔记</option>
                    <option value="full">同时导出翻译历史和笔记</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>导出方式</span>
                  <select value={batchExportMode} onChange={(event) => setBatchExportMode(event.target.value)}>
                    <option value="separate">每篇一个文件</option>
                    <option value="merged">合并为一个文件</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>导出名称</span>
                  <input
                    type="text"
                    value={batchExportName}
                    onChange={(event) => setBatchExportName(event.target.value)}
                    placeholder={batchExportMode === 'merged' ? '未命名合集' : '仅合并导出时需要填写'}
                    disabled={batchExportMode !== 'merged'}
                  />
                </label>
              </div>

              <div className="exportable-document-list">
                {exportableDocuments.length ? exportableDocuments.map((document) => (
                  <label className="exportable-document-item" key={document.documentId}>
                    <input
                      type="checkbox"
                      checked={selectedExportDocumentIds.includes(document.documentId)}
                      onChange={() => toggleExportDocument(document.documentId)}
                    />
                    <span>
                      <strong>{document.fileName || document.documentId}</strong>
                      <small>历史 {document.historyCount} 条 · 笔记 {document.notesCount} 条 · 批注 {document.annotationsCount} 条 · {formatHistoryTime(document.lastUpdatedAt)}</small>
                    </span>
                  </label>
                )) : <p className="history-empty">暂无可导出的文献数据</p>}
              </div>

              <div className="settings-inline-actions">
                <button type="button" className="settings-primary-button" onClick={batchExportPaperReaderData}>
                  开始导出
                </button>
              </div>
            </section>

            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>批量导入</h3>
                <span>支持单篇、合集和完整备份</span>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="settings-primary-button" onClick={batchImportPaperReaderData}>
                  选择导入文件
                </button>
              </div>
            </section>
          </>
        ) : null}

        {importExportTab === 'mergeSplit' ? (
          <>
            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>合并导出文件</h3>
                <span>逐个添加导出文件后再合并</span>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="settings-secondary-button merge-add-button" onClick={addMergeExportFile}>
                  +
                </button>
              </div>
              {mergeExportFiles.length ? (
                <div className="merge-export-file-list">
                  {mergeExportFiles.map((file) => (
                    <article key={file.filePath} className="merge-export-file-item">
                      <div>
                        <strong>{getMergeExportFileDisplayName(file)}</strong>
                      </div>
                      <button
                        type="button"
                        className="history-delete-button"
                        onClick={() => setMergeExportFiles((currentFiles) => currentFiles.filter((item) => item.filePath !== file.filePath))}
                      >
                        移除
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="history-empty">暂无待合并文件</p>
              )}
              <div className="settings-inline-actions">
                <button type="button" className="settings-secondary-button" onClick={mergePaperReaderExportFiles}>
                  合并
                </button>
              </div>
            </section>

            <section className="settings-glossary">
              <div className="settings-section-header">
                <h3>拆分导出文件</h3>
                <span>将合并文件拆成多个单篇文件</span>
              </div>
              <div className="settings-inline-actions">
                <button type="button" className="settings-secondary-button" onClick={splitPaperReaderExportFile}>
                  拆分为多个文件
                </button>
              </div>
            </section>
          </>
        ) : null}

        {importExportTab === 'markdown' ? (
          <>
            <section className="settings-glossary markdown-export-panel">
              <div className="settings-section-header">
                <h3>导出 Markdown</h3>
                <span>{selectedMarkdownDocumentIds.length} / {exportableDocuments.length} 篇</span>
              </div>
              <p className="markdown-export-hint">
                Markdown 会包含文件名、翻译历史、批注、笔记、页数、原句以及对应翻译或笔记内容。
              </p>
              {renderContentExportOptions(markdownExportOptions, setMarkdownExportOptions, isMarkdownExporting)}

              <div className="exportable-document-list markdown-document-list">
                {exportableDocuments.length ? exportableDocuments.map((document) => (
                  <label className="exportable-document-item" key={document.documentId}>
                    <input
                      type="checkbox"
                      checked={selectedMarkdownDocumentIds.includes(document.documentId)}
                      onChange={() => toggleMarkdownDocument(document.documentId)}
                    />
                    <span>
                      <strong>{document.fileName || document.documentId}</strong>
                      <small>历史 {document.historyCount} 条 · 笔记 {document.notesCount} 条 · 批注 {document.annotationsCount} 条 · {formatHistoryTime(document.lastUpdatedAt)}</small>
                    </span>
                  </label>
                )) : <p className="history-empty">暂无可导出的文献数据</p>}
              </div>

              <div className="settings-inline-actions markdown-export-actions">
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={exportCurrentPdfMarkdown}
                  disabled={isMarkdownExporting || !currentDocument?.documentId || !hasSelectedContentExportOption(markdownExportOptions)}
                >
                  导出当前 PDF
                </button>
                <button
                  type="button"
                  className="settings-primary-button"
                  onClick={exportMergedMarkdown}
                  disabled={isMarkdownExporting || !selectedMarkdownDocumentIds.length || !hasSelectedContentExportOption(markdownExportOptions)}
                >
                  选中文件合并导出
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={exportBatchMarkdownFiles}
                  disabled={isMarkdownExporting || !selectedMarkdownDocumentIds.length || !hasSelectedContentExportOption(markdownExportOptions)}
                >
                  选中文件批量导出
                </button>
              </div>
            </section>
          </>
        ) : null}

        {importExportTab === 'pdfReport' ? (
          <>
            <section className="settings-glossary report-export-panel">
              <div className="settings-section-header">
                <h3>导出 PDF 报告</h3>
                <span>{selectedPdfReportDocumentIds.length} / {exportableDocuments.length} 篇</span>
              </div>
              <p className="report-export-hint">
                PDF 报告会生成新的整理文件，包含文件名、翻译历史、批注、笔记、页数、原句以及对应翻译或笔记内容，不会写回原始 PDF。
              </p>
              {renderContentExportOptions(pdfReportExportOptions, setPdfReportExportOptions, isPdfReportExporting)}

              <div className="exportable-document-list report-document-list">
                {exportableDocuments.length ? exportableDocuments.map((document) => (
                  <label className="exportable-document-item" key={document.documentId}>
                    <input
                      type="checkbox"
                      checked={selectedPdfReportDocumentIds.includes(document.documentId)}
                      onChange={() => togglePdfReportDocument(document.documentId)}
                    />
                    <span>
                      <strong>{document.fileName || document.documentId}</strong>
                      <small>历史 {document.historyCount} 条 · 笔记 {document.notesCount} 条 · 批注 {document.annotationsCount} 条 · {formatHistoryTime(document.lastUpdatedAt)}</small>
                    </span>
                  </label>
                )) : <p className="history-empty">暂无可导出的文献数据</p>}
              </div>

              <div className="settings-inline-actions report-export-actions">
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={exportCurrentPdfReport}
                  disabled={isPdfReportExporting || !currentDocument?.documentId || !hasSelectedContentExportOption(pdfReportExportOptions)}
                >
                  导出当前 PDF
                </button>
                <button
                  type="button"
                  className="settings-primary-button"
                  onClick={exportMergedPdfReport}
                  disabled={isPdfReportExporting || !selectedPdfReportDocumentIds.length || !hasSelectedContentExportOption(pdfReportExportOptions)}
                >
                  选中文件合并导出
                </button>
                <button
                  type="button"
                  className="settings-secondary-button"
                  onClick={exportBatchPdfReports}
                  disabled={isPdfReportExporting || !selectedPdfReportDocumentIds.length || !hasSelectedContentExportOption(pdfReportExportOptions)}
                >
                  选中文件批量导出
                </button>
              </div>
            </section>
          </>
        ) : null}

        {exportStatus ? <p className="settings-status">{exportStatus}</p> : null}
            </section>
          </div>
        </div>
      </div>
    )
  }

  function renderLibraryPage() {
    const visibleDocuments = getVisibleLibraryDocuments()
    const folderCounts = libraryDocuments.reduce((counts, document) => {
      const key = document.folderId || 'unfiled'
      counts[key] = (counts[key] || 0) + 1
      return counts
    }, {})

    return (
      <section className="library-page">
        <aside className="library-folder-panel">
          <div className="library-folder-header">
            <strong>项目文件夹</strong>
            <button type="button" className="settings-secondary-button" onClick={openLibraryFolderDialog}>
              新建
            </button>
          </div>
          <button
            type="button"
            className={selectedLibraryFolderId === 'all' ? 'library-folder-button active' : 'library-folder-button'}
            onClick={() => setSelectedLibraryFolderId('all')}
          >
            <span>全部文献</span>
            <small>{libraryDocuments.length}</small>
          </button>
          <button
            type="button"
            className={selectedLibraryFolderId === 'unfiled' ? 'library-folder-button active' : 'library-folder-button'}
            onClick={() => setSelectedLibraryFolderId('unfiled')}
          >
            <span>未分类</span>
            <small>{folderCounts.unfiled || 0}</small>
          </button>
          {libraryFolders.map((folder) => (
            <button
              type="button"
              key={folder.id}
              className={selectedLibraryFolderId === folder.id ? 'library-folder-button active' : 'library-folder-button'}
              onClick={() => setSelectedLibraryFolderId(folder.id)}
            >
              <span>{folder.name}</span>
              <small>{folderCounts[folder.id] || 0}</small>
            </button>
          ))}
        </aside>

        <section className="library-main-panel">
          <div className="library-toolbar">
            <label className="library-search">
              <span>搜索文献</span>
              <input
                type="search"
                value={librarySearch}
                onChange={(event) => setLibrarySearch(event.target.value)}
                placeholder="按文件名搜索"
              />
            </label>
            <label className="library-sort">
              <span>排序</span>
              <select value={librarySort} onChange={(event) => setLibrarySort(event.target.value)}>
                <option value="recent">最近阅读</option>
                <option value="progress">阅读进度</option>
                <option value="notes">笔记数量</option>
              </select>
            </label>
            <button type="button" className="settings-primary-button" onClick={importLibraryDocuments}>
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
            {visibleDocuments.length ? visibleDocuments.map((document) => (
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
                  <strong>{document.fileName}</strong>
                  <span>{document.filePath}</span>
                  <div className="library-progress">
                    <i style={{ width: `${getLibraryProgressPercent(document)}%` }} />
                  </div>
                </button>
                <div className="library-document-meta">
                  <span>导入 {formatHistoryTime(document.importedAt)}</span>
                  <span>最近 {document.lastOpenedAt ? formatHistoryTime(document.lastOpenedAt) : '未阅读'}</span>
                  <span>进度 {getLibraryProgress(document)}</span>
                  <span>笔记 {document.notesCount || 0}</span>
                  <span>批注 {document.annotationsCount || 0}</span>
                </div>
              </article>
            )) : (
              <p className="history-empty">暂无文献</p>
            )}
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
                {[{ id: '', name: '未分类' }, ...libraryFolders].map((folder) => {
                  const isSelectedFolder = folder.id === libraryMoveDialog.targetFolderId

                  return (
                    <button
                      type="button"
                      key={folder.id || 'unfiled'}
                      className={isSelectedFolder ? 'library-move-folder active' : 'library-move-folder'}
                      onClick={() => setLibraryMoveDialog((dialog) => ({ ...dialog, targetFolderId: folder.id }))}
                    >
                      <span>{folder.name}</span>
                    </button>
                  )
                })}
              </div>
              <div className="library-move-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setLibraryMoveDialog(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className="settings-primary-button"
                  onClick={() => moveLibraryDocuments(libraryMoveDialog.documentIds, libraryMoveDialog.targetFolderId)}
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
              aria-label="新建文件夹"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="diagram-dialog-header">
                <h2>新建文件夹</h2>
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

  return (
    <main className={sidebarCollapsed ? 'app sidebar-collapsed' : 'app'} ref={appRef}>
      <aside className="module-sidebar" aria-label="主模块">
        <div className="sidebar-head">
          <div className="sidebar-brand" aria-hidden="true">
            <span className="sidebar-brand-mark">PR</span>
            <span className="sidebar-brand-text">
              <strong>Paper</strong>
              <em>Reader</em>
            </span>
          </div>
          <button
            type="button"
            className="module-sidebar-toggle"
            onClick={toggleSidebarCollapsed}
            aria-label={sidebarCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            title={sidebarCollapsed ? '展开左侧栏' : '折叠左侧栏'}
          >
            {sidebarCollapsed ? '›' : '‹'}
          </button>
        </div>
        <nav className="module-nav-list" aria-label="页面模块">
          {MODULE_NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeModule === item.id ? 'module-nav-button active' : 'module-nav-button'}
              onClick={() => switchModule(item.id)}
              title={item.label}
              aria-current={activeModule === item.id ? 'page' : undefined}
            >
              <span className="module-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="module-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="app-content">
        <section
          className={activeModule === 'reader' ? 'module-page reader-module active' : 'module-page reader-module'}
          aria-hidden={activeModule !== 'reader'}
        >
      <header className="toolbar">
        <section className="toolbar-group toolbar-left" aria-label="文件">
          <button type="button" className="upload-button" onClick={handleOpenPdfClick}>
            {UI.choosePdf}
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
          >
            最近打开
          </button>
          <div className="annotation-menu-wrap">
            <button
              ref={annotationButtonRef}
              type="button"
              className={isAnnotationToolbarOpen || annotationColor ? 'ocr-button active' : 'ocr-button'}
              onClick={() => setIsAnnotationToolbarOpen((isOpen) => !isOpen)}
              disabled={!pdfUrl}
            >
              批注
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
                    ⊘
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
                <button type="button" onClick={translateActiveHighlight}>
                  翻译
                </button>
                <button type="button" onClick={addNoteForActiveHighlight}>
                  笔记
                </button>
                <button type="button" onClick={() => setHideOcrNoteTags((isHidden) => !isHidden)}>
                  {hideOcrNoteTags ? '显示笔记标签' : '隐藏笔记标签'}
                </button>
                {annotationStatus ? <span>{annotationStatus}</span> : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="toolbar-group toolbar-navigation page-controls" aria-label={UI.pageControl}>
          <button type="button" onClick={goToPreviousPage} disabled={!pdfUrl || pageNumber <= 1}>
            {UI.previousPage}
          </button>
          <span>
            {UI.page} {pdfUrl ? pageNumber : 0} {UI.pageSuffix}
            {numPages ? ` / ${UI.totalPages} ${numPages} ${UI.pageSuffix}` : ''}
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
          <button type="button" onClick={jumpToPage} disabled={!pdfUrl || !numPages}>
            跳转
          </button>
          <button
            type="button"
            onClick={goToNextPage}
            disabled={!pdfUrl || !numPages || pageNumber >= numPages}
          >
            {UI.nextPage}
          </button>
        </section>

        <section className="toolbar-group toolbar-view zoom-controls" aria-label="PDF 缩放">
          <button type="button" onClick={() => changeZoom(-ZOOM_STEP)} disabled={!pdfUrl}>
            -
          </button>
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
          <button type="button" onClick={() => changeZoom(ZOOM_STEP)} disabled={!pdfUrl}>
            +
          </button>
        </section>

        <section className="toolbar-group toolbar-actions view-controls" aria-label="工具与设置">
          <div className="ocr-menu-wrap">
            <button
              type="button"
              className={isOcrMode || isOcrMenuOpen ? 'ocr-button active' : 'ocr-button'}
              onClick={toggleOcrMode}
              disabled={!pdfUrl}
            >
              区域 OCR
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
          >
            {isFullscreen ? UI.exitFullscreen : UI.fullscreen}
          </button>
        </section>
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

      {mergeNameDialog ? (
        <div
          className="note-dialog-overlay"
          role="presentation"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <section
            className="note-dialog"
            aria-label="命名合并文件"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseUp={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="diagram-dialog-header">
              <h2>命名合并文件</h2>
              <button type="button" onClick={() => setMergeNameDialog(null)}>
                取消
              </button>
            </div>

            <label className="note-dialog-field">
              <span>合并文件名称</span>
              <input
                ref={mergeNameInputRef}
                type="text"
                value={mergeNameDraft}
                onChange={(event) => setMergeNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void confirmMergePaperReaderExportFiles()
                  }
                }}
              />
            </label>

            <div className="note-dialog-source">
              <strong>待合并文件</strong>
              <span>{mergeNameDialog.filePaths?.length || 0} 个文件，约 {mergeNameDialog.documentCount || 0} 份数据</span>
            </div>

            <div className="settings-actions">
              <button type="button" className="settings-secondary-button" onClick={() => setMergeNameDialog(null)}>
                取消
              </button>
              <button type="button" className="settings-primary-button" onClick={confirmMergePaperReaderExportFiles}>
                合并
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

          <button
            type="button"
            className={rightPanelVisible ? 'panel-toggle-button visible' : 'panel-toggle-button collapsed'}
            onClick={() => setRightPanelVisible((isVisible) => !isVisible)}
            aria-label={rightPanelVisible ? '隐藏结果栏' : '显示结果栏'}
            title={rightPanelVisible ? '隐藏结果栏' : '显示结果栏'}
          >
            {rightPanelVisible ? '›' : '‹'}
          </button>

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
            </div>
            </aside>
          ) : null}
        </div>
      ) : (
        <section className="empty-state">
          <p>{UI.emptyPdf}</p>
        </section>
      )}
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
                        <span>选择或输入用于翻译的模型名称</span>
                      </div>
                      <label className="settings-field">
                        <span>模型名</span>
                        <div className="settings-model-row">
                          <input
                            type="text"
                            value={settingsForm.model}
                            onChange={(event) => updateSettingsField('model', event.target.value)}
                            placeholder={PROVIDERS[settingsForm.provider].model || 'model-id'}
                          />
                          {PROVIDERS[settingsForm.provider].presets.length ? (
                            <select
                              value=""
                              aria-label="常用模型预设"
                              onChange={(event) => {
                                if (event.target.value) {
                                  updateSettingsField('model', event.target.value)
                                }
                              }}
                            >
                              <option value="">常用模型预设</option>
                              {PROVIDERS[settingsForm.provider].presets.map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </div>
                      </label>
                      <label className="settings-switch-row">
                        <span>
                          <strong>启用多模态翻译</strong>
                          <small>图解模式和对照模式会优先让支持图片的 AI 直接识别文字坐标并翻译；失败时自动回退到原 OCR 流程。</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={settingsForm.enableMultimodalTranslation}
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
                        <span>用于普通划词、OCR 文本和批注翻译</span>
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

        {activeModule !== 'reader' && mergeNameDialog ? (
          <div
            className="note-dialog-overlay"
            role="presentation"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <section
              className="note-dialog"
              aria-label="命名合并文件"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onMouseUp={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="diagram-dialog-header">
                <h2>命名合并文件</h2>
                <button type="button" onClick={() => setMergeNameDialog(null)}>
                  取消
                </button>
              </div>

              <label className="note-dialog-field">
                <span>合并文件名称</span>
                <input
                  ref={mergeNameInputRef}
                  type="text"
                  value={mergeNameDraft}
                  onChange={(event) => setMergeNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void confirmMergePaperReaderExportFiles()
                    }
                  }}
                />
              </label>

              <div className="note-dialog-source">
                <strong>待合并文件</strong>
                <span>{mergeNameDialog.filePaths?.length || 0} 个文件，约 {mergeNameDialog.documentCount || 0} 份数据</span>
              </div>

              <div className="settings-actions">
                <button type="button" className="settings-secondary-button" onClick={() => setMergeNameDialog(null)}>
                  取消
                </button>
                <button type="button" className="settings-primary-button" onClick={confirmMergePaperReaderExportFiles}>
                  合并
                </button>
              </div>
            </section>
          </div>
        ) : null}

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
            取消高亮
          </button>
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
            onBeforeInput={(event) => event.stopPropagation()}
            onInput={(event) => event.stopPropagation()}
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
