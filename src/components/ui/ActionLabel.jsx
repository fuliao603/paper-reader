import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpFromLine, Bookmark,
  BookOpen, Check, ClipboardCopy, DatabaseBackup, FileCheck2,
  FileCode2, FileText, Files, FolderOpen, FolderTree, History,
  KeyRound, Languages, ListChecks, NotebookPen, RotateCcw, Save, X,
  SlidersHorizontal, Trash2,
} from 'lucide-react'

const GLYPHS = {
  export: ArrowDownToLine,
  import: ArrowUpFromLine,
  move: ArrowLeftRight,
  save: Save,
  reset: RotateCcw,
  delete: Trash2,
  copy: ClipboardCopy,
  backup: DatabaseBackup,
  folder: FolderOpen,
  'folder-tree': FolderTree,
  current: FileText,
  selected: FileCheck2,
  all: Files,
  recycle: Trash2,
  markdown: FileCode2,
  pdf: FileText,
  translate: Languages,
  history: History,
  notes: NotebookPen,
  bookmark: Bookmark,
  model: SlidersHorizontal,
  key: KeyRound,
  glossary: BookOpen,
  confirm: Check,
  select: ListChecks,
  cancel: X,
}

// Purely presentational: the parent button/label retains its events and semantics.
function ActionLabel({ icon, children }) {
  const Glyph = GLYPHS[icon]
  return (
    <span className="action-label">
      {Glyph ? <Glyph className="action-label-glyph" size={16} strokeWidth={1.65} aria-hidden="true" /> : null}
      <span className="action-label-text">{children}</span>
    </span>
  )
}

export default ActionLabel
