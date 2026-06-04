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

function getLinkedNote(annotation, notes = []) {
  if (!annotation || !Array.isArray(notes)) return null

  return notes.find((note) => (
    note?.id && annotation.noteId && note.id === annotation.noteId
  ) || (
    note?.highlightId && annotation.id && note.highlightId === annotation.id
  ) || (
    note?.highlightId && annotation.highlightId && note.highlightId === annotation.highlightId
  )) || null
}

function appendRecordSection(lines, index, { page, original, bodyLabel, body }) {
  lines.push(`### 第 ${index + 1} 条`)
  lines.push('')
  lines.push(`* 页数：${page || '未知'}`)
  lines.push('')
  lines.push('**原句：**')
  lines.push('')
  lines.push(markdownQuote(original))
  lines.push('')
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
    exportAnnotations: options.exportAnnotations !== false,
    exportNotes: options.exportNotes !== false,
  }
}

function resolveExportOptions(payloadOptions = {}, explicitOptions = {}) {
  const hasExplicitOptions = explicitOptions && Object.keys(explicitOptions).length > 0
  return normalizeExportOptions(hasExplicitOptions ? explicitOptions : payloadOptions)
}

export function getPdfExportSections({ histories = [], annotations = [], notes = [], options = {} } = {}, explicitOptions = {}) {
  const exportOptions = resolveExportOptions(options, explicitOptions)
  const safeHistories = Array.isArray(histories) ? histories : []
  const safeAnnotations = Array.isArray(annotations) ? annotations : []
  const safeNotes = Array.isArray(notes) ? notes : []
  const exportAnnotations = safeAnnotations.filter((item) => item?.type !== 'ocr-note-tag')

  const sections = [
    {
      key: 'translation-history',
      title: '翻译历史',
      bodyLabel: '翻译',
      records: safeHistories.map((item) => ({
        page: getPageNumber(item),
        original: firstTextValue(item, ORIGINAL_FIELDS),
        body: firstTextValue(item, TRANSLATION_FIELDS),
      })),
    },
    {
      key: 'annotations',
      title: '批注',
      bodyLabel: '批注 / 笔记',
      records: exportAnnotations.map((item) => {
        const linkedNote = getLinkedNote(item, safeNotes)

        return {
          page: getPageNumber(item),
          original: firstTextValue(item, ORIGINAL_FIELDS),
          body: firstTextValue(item, NOTE_FIELDS) || firstTextValue(linkedNote, NOTE_FIELDS),
        }
      }),
    },
    {
      key: 'notes',
      title: '笔记',
      bodyLabel: '笔记',
      records: safeNotes.map((item) => ({
        page: getPageNumber(item),
        original: firstTextValue(item, ORIGINAL_FIELDS),
        body: firstTextValue(item, NOTE_FIELDS),
      })),
    },
  ]

  return sections.filter((section) => {
    if (section.key === 'translation-history') return exportOptions.exportHistories
    if (section.key === 'annotations') return exportOptions.exportAnnotations
    if (section.key === 'notes') return exportOptions.exportNotes
    return true
  })
}

export function makeSafeMarkdownFileName(name) {
  const baseName = replaceUnsafeFileNameChars(stripMarkdownExtension(getPdfDisplayName({ fileName: name })))
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)

  return `${baseName || 'paper-reader-markdown'}.md`
}

export function buildPdfMarkdown({ pdf = {}, histories = [], annotations = [], notes = [], options = {} } = {}, explicitOptions = {}) {
  const exportOptions = resolveExportOptions(options, explicitOptions)
  const lines = [`# 文件名：${getPdfDisplayName(pdf)}`, '']

  getPdfExportSections({ histories, annotations, notes }, exportOptions).forEach((section) => {
    lines.push(`## ${section.title}`)
    lines.push('')

    if (section.records.length) {
      section.records.forEach((record, index) => {
        appendRecordSection(lines, index, {
          page: record.page,
          original: record.original,
          bodyLabel: section.bodyLabel,
          body: record.body,
        })
      })
    } else {
      lines.push('无')
      lines.push('')
    }
  })

  return `${lines.join('\n').trim()}\n`
}

export function buildBatchPdfMarkdown(items = [], options = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => buildPdfMarkdown(item, options).trim())
    .filter(Boolean)
    .join('\n\n---\n\n') + '\n'
}
