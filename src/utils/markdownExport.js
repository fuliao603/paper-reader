const ORIGINAL_FIELDS = [
  'sourceText',
  'originalText',
  'selectedText',
  'ocrText',
  'highlightText',
  'text',
  'source',
  'original',
]

const TRANSLATION_FIELDS = [
  'translatedText',
  'translation',
  'targetText',
  'result',
  'translated',
  'target',
]

const NOTE_FIELDS = [
  'note',
  'noteText',
  'content',
  'comment',
  'memo',
  'remark',
]

const BOOKMARK_FIELDS = ['title', 'note', 'content', 'remark']

const PAGE_FIELDS = ['pageNumber', 'page', 'pageNo', 'targetPage']

function firstTextValue(source, fields) {
  if (!source || typeof source !== 'object') return ''

  for (const field of fields) {
    const value = source[field]
    if (value === null || value === undefined) continue

    const text = Array.isArray(value) ? value.join('\n') : String(value)
    if (text.trim()) return text.trim()
  }

  return ''
}

function getPageNumber(record = {}) {
  for (const field of PAGE_FIELDS) {
    const pageValue = Number(record[field])
    if (Number.isFinite(pageValue) && pageValue > 0) return Math.floor(pageValue)
  }

  const pageIndex = Number(record.pageIndex)
  if (Number.isFinite(pageIndex) && pageIndex >= 0) return Math.floor(pageIndex) + 1

  return ''
}

function markdownQuote(value) {
  const text = String(value || '').trim()
  if (!text) return '> 无'

  return text
    .split(/\r?\n/)
    .map((line) => `> ${line || ' '}`)
    .join('\n')
}

function markdownText(value, fallback = '无') {
  const text = String(value || '').trim()
  return text || fallback
}

function stripMarkdownExtension(name) {
  return String(name || '').replace(/\.md$/i, '').trim()
}

function replaceUnsafeFileNameChars(name) {
  return String(name || '')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char))
    .join('')
}

function getFileNameFromPath(filePath) {
  const normalizedPath = String(filePath || '').replace(/\\/g, '/')
  const segments = normalizedPath.split('/').filter(Boolean)
  return segments.at(-1) || ''
}

function appendRecordSection(lines, index, { page, original, bodyLabel, body, hideOriginal = false, showPage = true }) {
  lines.push(`### 第 ${index + 1} 条`)
  lines.push('')
  if (showPage) {
    lines.push(`* 页数：${page || '未知'}`)
    lines.push('')
  }
  if (!hideOriginal) {
    lines.push('**原句：**')
    lines.push('')
    lines.push(markdownQuote(original))
    lines.push('')
  }
  lines.push(`**${bodyLabel}：**`)
  lines.push('')
  lines.push(markdownQuote(body))
  lines.push('')
  lines.push('---')
  lines.push('')
}

export function getPdfDisplayName(pdf = {}) {
  return markdownText(
    pdf.fileName ||
    pdf.name ||
    pdf.title ||
    getFileNameFromPath(pdf.filePath) ||
    pdf.documentId,
    '未命名文献',
  )
}

export function normalizeExportOptions(options = {}) {
  return {
    exportHistories: options.exportHistories !== false,
    exportHighlights: options.exportHighlights ?? options.exportAnnotations !== false,
    exportAnnotations: options.exportAnnotations !== false,
    exportNotes: options.exportNotes !== false,
    exportBookmarks: options.exportBookmarks !== false,
    includeOriginal: options.includeOriginal !== false,
    generateToc: options.generateToc === true,
    groupByType: options.groupByType !== false,
    showPageNumbers: options.showPageNumbers !== false,
  }
}

function resolveExportOptions(payloadOptions = {}, explicitOptions = {}) {
  const hasExplicitOptions = explicitOptions && Object.keys(explicitOptions).length > 0
  return normalizeExportOptions(hasExplicitOptions ? explicitOptions : payloadOptions)
}

function sortExportRecords(records) {
  return records.slice().sort((first, second) => {
    const firstPage = Number(first.page) || Number.MAX_SAFE_INTEGER
    const secondPage = Number(second.page) || Number.MAX_SAFE_INTEGER
    if (firstPage !== secondPage) return firstPage - secondPage
    return (Number(first.createdAt) || 0) - (Number(second.createdAt) || 0)
  })
}

export function getPdfExportSections({ histories = [], annotations = [], notes = [], bookmarks = [], options = {} } = {}, explicitOptions = {}) {
  const exportOptions = resolveExportOptions(options, explicitOptions)
  const safeHistories = Array.isArray(histories) ? histories : []
  const safeAnnotations = Array.isArray(annotations) ? annotations : []
  const safeNotes = Array.isArray(notes) ? notes : []
  const safeBookmarks = Array.isArray(bookmarks) ? bookmarks : []
  const highlights = safeAnnotations.filter((item) => item?.type === 'text-highlight')
  const annotationRecords = safeAnnotations.filter((item) => item?.type !== 'text-highlight')

  const sections = [
    {
      key: 'translation-history',
      title: '翻译历史',
      bodyLabel: '翻译',
      records: safeHistories.map((item) => ({
        page: getPageNumber(item),
        original: firstTextValue(item, ORIGINAL_FIELDS),
        body: firstTextValue(item, TRANSLATION_FIELDS),
        createdAt: item.createdAt || item.timestamp,
      })),
    },
    {
      key: 'highlights',
      title: '高亮',
      bodyLabel: '高亮内容',
      hideOriginal: true,
      records: highlights.map((item) => ({
        page: getPageNumber(item),
        original: '',
        body: firstTextValue(item, ORIGINAL_FIELDS),
        createdAt: item.createdAt || item.updatedAt,
      })),
    },
    {
      key: 'annotations',
      title: '批注',
      bodyLabel: '批注内容',
      hideOriginal: true,
      records: annotationRecords.map((item) => ({
        page: getPageNumber(item),
        original: '',
        body: firstTextValue(item, [...NOTE_FIELDS, ...ORIGINAL_FIELDS]),
        createdAt: item.createdAt || item.updatedAt,
      })),
    },
    {
      key: 'notes',
      title: '笔记',
      bodyLabel: '笔记',
      records: safeNotes.map((item) => ({
        page: getPageNumber(item),
        original: firstTextValue(item, ORIGINAL_FIELDS),
        body: firstTextValue(item, NOTE_FIELDS),
        createdAt: item.createdAt || item.updatedAt,
      })),
    },
    {
      key: 'bookmarks',
      title: '书签',
      bodyLabel: '标题或备注',
      hideOriginal: true,
      records: safeBookmarks.map((item) => ({
        page: getPageNumber(item),
        original: '',
        body: firstTextValue(item, BOOKMARK_FIELDS),
        createdAt: item.createdAt || item.updatedAt,
      })),
    },
  ]

  return sections.map((section) => ({ ...section, records: sortExportRecords(section.records) })).filter((section) => {
    if (section.key === 'translation-history') return exportOptions.exportHistories
    if (section.key === 'highlights') return exportOptions.exportHighlights
    if (section.key === 'annotations') return exportOptions.exportAnnotations
    if (section.key === 'notes') return exportOptions.exportNotes
    if (section.key === 'bookmarks') return exportOptions.exportBookmarks
    return false
  }).filter((section) => section.records.length)
}

function getFlatRecordSection(sections) {
  return {
    key: 'records',
    title: '记录',
    bodyLabel: '内容',
    records: sortExportRecords(sections.flatMap((section) => section.records.map((record) => ({
      ...record,
      body: `[${section.title}] ${record.body || ''}`.trim(),
      hideOriginal: section.hideOriginal,
    })))),
  }
}

export function makeSafeMarkdownFileName(name) {
  const baseName = replaceUnsafeFileNameChars(stripMarkdownExtension(getPdfDisplayName({ fileName: name })))
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return `${baseName || 'paper-reader-markdown'}.md`
}

export function buildPdfMarkdown({ pdf = {}, histories = [], annotations = [], notes = [], bookmarks = [], options = {} } = {}, explicitOptions = {}) {
  const exportOptions = resolveExportOptions(options, explicitOptions)
  const displayName = getPdfDisplayName(pdf)
  const lines = [
    `# ${displayName}`,
    '',
    `- 文件名：${pdf.sourceFileName || pdf.fileName || displayName}`,
    `- 所属文件夹：${pdf.folderPath || '未分类'}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ]
  const selectedSections = getPdfExportSections({ histories, annotations, notes, bookmarks }, exportOptions)
  const sections = exportOptions.groupByType ? selectedSections : [getFlatRecordSection(selectedSections)]

  if (exportOptions.generateToc && sections.length) {
    lines.push('## 目录', '')
    sections.forEach((section) => lines.push(`- [${section.title}](#${section.title})`))
    lines.push('')
  }

  sections.forEach((section) => {
    lines.push(`## ${section.title}`)
    lines.push('')
    section.records.forEach((record, index) => {
      appendRecordSection(lines, index, {
        page: record.page,
        original: record.original,
        bodyLabel: section.bodyLabel,
        body: record.body,
        hideOriginal: !exportOptions.includeOriginal || Boolean(record.hideOriginal ?? section.hideOriginal),
        showPage: exportOptions.showPageNumbers,
      })
    })
  })

  return `${lines.join('\n').trim()}\n`
}

export function buildBatchPdfMarkdown(items = [], options = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => buildPdfMarkdown(item, options).trim())
    .filter(Boolean)
    .join('\n\n---\n\n') + '\n'
}
