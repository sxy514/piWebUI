import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  FolderArchive,
  Folder,
  FolderOpen,
  ChevronRight,
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  Archive,
  Download,
  Eye,
  RefreshCw,
  Search,
  X,
  File,
  Check,
  Copy,
  Trash2,
  AlertTriangle,
  ChevronsUpDown,
} from 'lucide-react'
import {
  getWorkspaceFiles,
  getWorkspaceDownloadUrl,
  getWorkspaceArchiveUrl,
  deleteWorkspaceFile,
  clearWorkspace,
  type WorkspaceItem,
  type WorkspaceFilesResponse,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface WorkspaceDrawerProps {
  open: boolean
  onClose: () => void
}

interface FileTreeNode extends WorkspaceItem {
  children: FileTreeNode[]
}

function getFileIcon(item: WorkspaceItem) {
  if (item.is_dir) {
    return <Folder className="size-4.5 text-amber-400" />
  }
  const ext = item.extension.toLowerCase()
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'html', 'css', 'sql', 'sh', 'bat', 'ps1'].includes(ext)) {
    return <FileCode className="size-4.5 text-blue-400" />
  }
  if (['csv', 'xlsx', 'xls'].includes(ext)) {
    return <FileSpreadsheet className="size-4.5 text-emerald-400" />
  }
  if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(ext)) {
    return <FileImage className="size-4.5 text-purple-400" />
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
    return <Archive className="size-4.5 text-amber-500" />
  }
  if (['md', 'txt', 'log', 'yaml', 'yml', 'env', 'ini', 'xml'].includes(ext)) {
    return <FileText className="size-4.5 text-indigo-400" />
  }
  return <File className="size-4.5 text-muted-foreground" />
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function formatTime(mtime: number): string {
  if (!mtime) return '-'
  const d = new Date(mtime * 1000)
  const now = new Date()
  const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000)
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function buildFileTree(items: WorkspaceItem[]): FileTreeNode[] {
  const rootMap = new Map<string, FileTreeNode>()
  const lookup = new Map<string, FileTreeNode>()

  const SYSTEM_CONFIG_NAMES = new Set(['agents.md', 'user.md', 'memory.md'])
  const validItems = items.filter(
    (item) => !SYSTEM_CONFIG_NAMES.has(item.name.toLowerCase())
  )

  for (const item of validItems) {
    lookup.set(item.path, { ...item, children: [] })
  }

  // 补齐中间可能缺省的祖先文件夹节点
  for (const item of validItems) {
    const parts = item.path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const ancestorPath = parts.slice(0, i).join('/')
      if (!lookup.has(ancestorPath)) {
        lookup.set(ancestorPath, {
          name: parts[i - 1],
          path: ancestorPath,
          is_dir: true,
          size: 0,
          size_formatted: '-',
          mtime: item.mtime,
          extension: '',
          children: [],
        })
      }
    }
  }

  // 挂载父子树结构
  for (const [path, node] of lookup.entries()) {
    const parts = path.split('/')
    if (parts.length === 1) {
      rootMap.set(path, node)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = lookup.get(parentPath)
      if (parent && !parent.children.some((c) => c.path === node.path)) {
        parent.children.push(node)
      }
    }
  }

  // 排序：目录排在文件前面；同类型按最新时间倒序
  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((a, b) => {
      if (a.is_dir && !b.is_dir) return -1
      if (!a.is_dir && b.is_dir) return 1
      return b.mtime - a.mtime || a.name.localeCompare(b.name)
    })
    for (const node of nodes) {
      if (node.is_dir && node.children.length > 0) {
        sortNodes(node.children)
      }
    }
  }

  const roots = Array.from(rootMap.values())
  sortNodes(roots)
  return roots
}

function getDirStats(node: FileTreeNode): { fileCount: number; totalSize: number } {
  let fileCount = 0
  let totalSize = 0
  for (const child of node.children) {
    if (child.is_dir) {
      const sub = getDirStats(child)
      fileCount += sub.fileCount
      totalSize += sub.totalSize
    } else {
      fileCount += 1
      totalSize += child.size
    }
  }
  return { fileCount, totalSize }
}

export function WorkspaceDrawer({ open, onClose }: WorkspaceDrawerProps) {
  const [data, setData] = useState<WorkspaceFilesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [previewItem, setPreviewItem] = useState<WorkspaceItem | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const [confirmDeleteItem, setConfirmDeleteItem] = useState<WorkspaceItem | null>(null)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['uploads']))

  const showToast = (type: 'success' | 'error', message: string) => {
    setActionToast({ type, message })
    setTimeout(() => {
      setActionToast(null)
    }, 3000)
  }

  const fetchFiles = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getWorkspaceFiles()
      setData(res)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '获取文件列表失败'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void fetchFiles()
    }
  }, [open, fetchFiles])

  // 快捷 ESC 键退出
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (confirmDeleteItem) {
          setConfirmDeleteItem(null)
        } else if (showClearConfirm) {
          setShowClearConfirm(false)
        } else if (previewItem) {
          setPreviewItem(null)
        } else if (open) {
          onClose()
        }
      }
    }
    if (open) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, previewItem, confirmDeleteItem, showClearConfirm])

  const handleDeleteItem = async (item: WorkspaceItem) => {
    setDeletingPath(item.path)
    try {
      const res = await deleteWorkspaceFile(item.path)
      showToast('success', res.message || `文件已删除: ${item.name}`)
      if (previewItem?.path === item.path) {
        setPreviewItem(null)
      }
      setConfirmDeleteItem(null)
      await fetchFiles()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeletingPath(null)
    }
  }

  const handleClearWorkspace = async () => {
    setClearing(true)
    try {
      const res = await clearWorkspace()
      showToast('success', res.message || '工作区成果已清空')
      setPreviewItem(null)
      setShowClearConfirm(false)
      await fetchFiles()
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : '清空失败')
    } finally {
      setClearing(false)
    }
  }

  // 树状层次结构数据
  const treeData = useMemo(() => {
    if (!data?.items) return []
    return buildFileTree(data.items)
  }, [data?.items])

  // 获取所有目录路径用于全部折叠/展开
  const allDirPaths = useMemo(() => {
    const paths: string[] = []
    function collect(nodes: FileTreeNode[]) {
      for (const n of nodes) {
        if (n.is_dir) {
          paths.push(n.path)
          collect(n.children)
        }
      }
    }
    collect(treeData)
    return paths
  }, [treeData])

  const toggleExpand = (dirPath: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }

  const toggleAllDirs = () => {
    if (expandedPaths.size >= allDirPaths.length && allDirPaths.length > 0) {
      setExpandedPaths(new Set())
    } else {
      setExpandedPaths(new Set(allDirPaths))
    }
  }

  // 扁平搜索结果过滤
  const searchResults = useMemo(() => {
    if (!data?.items) return []
    const q = search.trim().toLowerCase()
    if (!q) return []
    const SYSTEM_CONFIG_NAMES = new Set(['agents.md', 'user.md', 'memory.md'])
    return data.items
      .filter((item) => !SYSTEM_CONFIG_NAMES.has(item.name.toLowerCase()))
      .filter(
        (item) =>
          item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)
      )
  }, [data?.items, search])

  const handlePreview = async (item: WorkspaceItem) => {
    const ext = item.extension.toLowerCase()
    setPreviewItem(item)
    setPreviewContent('')

    if (['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(ext)) {
      return
    }

    setPreviewLoading(true)
    try {
      const url = getWorkspaceDownloadUrl(item.path, true)
      const res = await fetch(url)
      if (res.ok) {
        const text = await res.text()
        setPreviewContent(text)
      } else {
        setPreviewContent('加载预览内容失败')
      }
    } catch {
      setPreviewContent('网络异常，无法加载内容')
    } finally {
      setPreviewLoading(false)
    }
  }

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 递归渲染树节点
  const renderTreeNode = (node: FileTreeNode, depth = 0) => {
    if (node.is_dir) {
      const isExpanded = expandedPaths.has(node.path)
      const stats = getDirStats(node)
      return (
        <div key={node.path} className="space-y-0.5">
          <div
            style={{ paddingLeft: `${depth * 18 + 6}px` }}
            className={cn(
              'group flex items-center justify-between gap-2 rounded-xl py-2 pr-2.5 transition-colors cursor-pointer select-none',
              isExpanded ? 'bg-white/4 hover:bg-white/8' : 'hover:bg-white/6'
            )}
            onClick={() => toggleExpand(node.path)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/60 group-hover:text-foreground transition-transform">
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform duration-200',
                    isExpanded && 'rotate-90'
                  )}
                />
              </span>
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
                {isExpanded ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs font-mono font-medium text-foreground/90 group-hover:text-primary transition-colors">
                  {node.name}
                </div>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60 font-mono">
                  <span>{stats.fileCount} 个文件</span>
                  {stats.totalSize > 0 && (
                    <>
                      <span>·</span>
                      <span>{formatFileSize(stats.totalSize)}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{formatTime(node.mtime)}</span>
                </div>
              </div>
            </div>

            <div
              className="flex shrink-0 items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setConfirmDeleteItem(node)}
                disabled={deletingPath === node.path}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-destructive/20 hover:text-destructive transition disabled:opacity-50"
                title="删除此目录及内部全部文件"
              >
                {deletingPath === node.path ? (
                  <RefreshCw className="size-3 animate-spin text-destructive" />
                ) : (
                  <Trash2 className="size-3" />
                )}
              </button>
            </div>
          </div>

          {/* 展开的子级列表 */}
          {isExpanded && (
            <div className="relative">
              {/* 树形指引竖线 */}
              <div
                style={{ left: `${depth * 18 + 15}px` }}
                className="pointer-events-none absolute top-0 bottom-1 w-px bg-white/6"
              />
              {node.children.length === 0 ? (
                <div
                  style={{ paddingLeft: `${(depth + 1) * 18 + 24}px` }}
                  className="py-1.5 text-[11px] text-muted-foreground/40 font-mono italic"
                >
                  （空目录）
                </div>
              ) : (
                node.children.map((child) => renderTreeNode(child, depth + 1))
              )}
            </div>
          )}
        </div>
      )
    }

    // 渲染普通文件节点
    const isImage = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(
      node.extension.toLowerCase()
    )
    const isText = ['md', 'txt', 'log', 'json', 'py', 'ts', 'tsx', 'js', 'html', 'css', 'csv'].includes(
      node.extension.toLowerCase()
    )
    const canPreview = isImage || isText

    return (
      <div
        key={node.path}
        style={{ paddingLeft: `${depth * 18 + (depth > 0 ? 8 : 4)}px` }}
        className="group flex items-center justify-between gap-2.5 rounded-xl py-2 pr-2.5 transition hover:border-white/8 hover:bg-white/6"
      >
        <div className="flex min-w-0 items-center gap-2">
          {depth > 0 && <span className="size-4 shrink-0" />}
          <div className="flex size-7.5 shrink-0 items-center justify-center rounded-lg bg-white/4 group-hover:bg-white/8 transition-colors">
            {getFileIcon(node)}
          </div>
          <div className="min-w-0">
            <div className="truncate text-xs font-mono font-medium text-foreground/90 group-hover:text-primary transition-colors">
              {node.name}
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 font-mono">
              <span>{node.size_formatted}</span>
              <span>·</span>
              <span>{formatTime(node.mtime)}</span>
            </div>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex shrink-0 items-center gap-1">
          {canPreview && (
            <button
              type="button"
              onClick={() => void handlePreview(node)}
              className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-white/10 hover:text-foreground transition"
              title="预览内容"
            >
              <Eye className="size-3.5" />
            </button>
          )}

          <a
            href={getWorkspaceDownloadUrl(node.path)}
            download={node.name}
            className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-primary/20 hover:text-primary transition"
            title="下载该文件"
          >
            <Download className="size-3.5" />
          </a>

          <button
            type="button"
            onClick={() => setConfirmDeleteItem(node)}
            disabled={deletingPath === node.path}
            className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-destructive/20 hover:text-destructive transition disabled:opacity-50"
            title="删除该文件"
          >
            {deletingPath === node.path ? (
              <RefreshCw className="size-3.5 animate-spin text-destructive" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
        </div>
      </div>
    )
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩背景 */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* 滑动抽屉 */}
      <div className="relative z-10 flex h-full w-full max-w-full flex-col border-l border-white/10 bg-background/95 shadow-2xl backdrop-blur-2xl transition-transform animate-in slide-in-from-right duration-200 sm:max-w-lg">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between border-b border-white/8 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-xl bg-primary/15 text-primary shadow-inner">
              <FolderArchive className="size-4.5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">工作区成果文件</h2>
              <div className="text-[11px] text-muted-foreground">
                {data ? `共 ${data.total_files} 个文件 · ${data.total_size_formatted}` : '正在读取工作区...'}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void fetchFiles()}
              disabled={loading}
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition hover:bg-white/8 hover:text-foreground disabled:opacity-50"
              title="刷新文件列表"
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin text-primary')} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition hover:bg-white/8 hover:text-foreground"
              title="关闭"
            >
              <X className="size-4.5" />
            </button>
          </div>
        </div>

        {/* 工具操作栏：搜索 + 展开折叠 + 打包下载 + 清空 */}
        <div className="flex items-center gap-1.5 sm:gap-2 border-b border-white/6 px-2.5 sm:px-4 py-2.5 bg-white/2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索成果文件名或路径..."
              className="w-full rounded-lg border border-white/8 bg-black/20 pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          {!search && allDirPaths.length > 0 && (
            <button
              type="button"
              onClick={toggleAllDirs}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/4 px-2 py-1.5 text-xs text-muted-foreground hover:bg-white/8 hover:text-foreground transition active:scale-95"
              title={expandedPaths.size >= allDirPaths.length ? '全部折叠' : '全部展开'}
            >
              <ChevronsUpDown className="size-3.5" />
              <span className="hidden sm:inline">{expandedPaths.size >= allDirPaths.length ? '折叠' : '展开'}</span>
            </button>
          )}

          <a
            href={getWorkspaceArchiveUrl()}
            download
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20 active:scale-95"
            title="将工作区所有成果打包下载为 ZIP"
          >
            <Archive className="size-3.5" />
            <span className="hidden sm:inline">打包 ZIP</span>
          </a>

          <button
            type="button"
            onClick={() => setShowClearConfirm(true)}
            disabled={!data || data.total_files === 0 || loading || clearing}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-xs font-medium text-destructive transition hover:bg-destructive/20 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            title="清空当前工作区所有生成成果与上传文件"
          >
            <Trash2 className="size-3.5" />
            <span className="hidden sm:inline">清空成果</span>
          </button>
        </div>

        {/* 文件列表区域 */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {loading && !data && (
            <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground text-xs">
              <RefreshCw className="size-5 animate-spin text-primary" />
              <span>正在扫描工作区文件...</span>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-center text-xs text-destructive">
              {error}
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => void fetchFiles()}
                  className="rounded-lg bg-destructive/20 px-3 py-1 text-[11px] font-medium hover:bg-destructive/30"
                >
                  重试
                </button>
              </div>
            </div>
          )}

          {/* 搜索模式：展示扁平搜索结果 */}
          {search ? (
            searchResults.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center gap-2.5 text-center text-xs text-muted-foreground/70">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-white/4 text-muted-foreground/40">
                  <Folder className="size-6" />
                </div>
                <div>
                  <p className="font-medium text-foreground/80">未搜索到匹配的文件</p>
                  <p className="mt-1 text-[11px] text-muted-foreground/50">换个关键词试试</p>
                </div>
              </div>
            ) : (
              searchResults.map((item) => {
                const isImage = ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(
                  item.extension.toLowerCase()
                )
                const isText = ['md', 'txt', 'log', 'json', 'py', 'ts', 'tsx', 'js', 'html', 'css', 'csv'].includes(
                  item.extension.toLowerCase()
                )
                const canPreview = isImage || isText

                return (
                  <div
                    key={item.path}
                    className="group flex items-center justify-between gap-3 rounded-xl border border-transparent p-2.5 transition hover:border-white/8 hover:bg-white/6"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/4 group-hover:bg-white/8 transition-colors">
                        {getFileIcon(item)}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-xs font-mono font-medium text-foreground/90 group-hover:text-primary transition-colors">
                          {item.name}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 font-mono">
                          <span>{item.size_formatted}</span>
                          <span>·</span>
                          <span>{formatTime(item.mtime)}</span>
                          {item.path !== item.name && (
                            <>
                              <span>·</span>
                              <span className="truncate max-w-[140px] text-primary/80" title={item.path}>
                                {item.path}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {!item.is_dir && canPreview && (
                        <button
                          type="button"
                          onClick={() => void handlePreview(item)}
                          className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-white/10 hover:text-foreground transition"
                          title="预览内容"
                        >
                          <Eye className="size-3.5" />
                        </button>
                      )}

                      {!item.is_dir && (
                        <a
                          href={getWorkspaceDownloadUrl(item.path)}
                          download={item.name}
                          className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-primary/20 hover:text-primary transition"
                          title="直接下载该文件"
                        >
                          <Download className="size-3.5" />
                        </a>
                      )}

                      <button
                        type="button"
                        onClick={() => setConfirmDeleteItem(item)}
                        disabled={deletingPath === item.path}
                        className="flex size-7.5 cursor-pointer items-center justify-center rounded-lg text-muted-foreground/80 hover:bg-destructive/20 hover:text-destructive transition disabled:opacity-50"
                        title={item.is_dir ? '删除该目录' : '删除该文件'}
                      >
                        {deletingPath === item.path ? (
                          <RefreshCw className="size-3.5 animate-spin text-destructive" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                )
              })
            )
          ) : (
            /* 树形结构展示模式 */
            !loading && !error && (
              treeData.length === 0 ? (
                <div className="flex h-56 flex-col items-center justify-center gap-2.5 text-center text-xs text-muted-foreground/70">
                  <div className="flex size-12 items-center justify-center rounded-2xl bg-white/4 text-muted-foreground/40">
                    <Folder className="size-6" />
                  </div>
                  <div>
                    <p className="font-medium text-foreground/80">当前工作区暂无生成文件</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/50">
                      Agent 写入或产出的文件将自动归档显示在这里
                    </p>
                  </div>
                </div>
              ) : (
                treeData.map((node) => renderTreeNode(node, 0))
              )
            )
          )}
        </div>

        {/* 底部信息提示 */}
        <div className="border-t border-white/6 px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-[11px] text-muted-foreground/60 flex items-center justify-between">
          <span>文件保存在当前登录用户的独立隔离空间中</span>
          <span className="font-mono text-[10px] text-muted-foreground/40">{data?.workspace}</span>
        </div>
      </div>

      {/* 简易文本 / 图片预览弹窗 */}
      {previewItem && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-2.5 sm:p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-150">
          <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/15 bg-background shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150">
            {/* 预览标题 */}
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-white/2">
              <div className="flex items-center gap-2">
                {getFileIcon(previewItem)}
                <span className="font-mono text-xs font-semibold text-foreground truncate max-w-sm">
                  {previewItem.name}
                </span>
                <span className="rounded bg-white/8 px-1.5 py-0.2 text-[10px] text-muted-foreground font-mono">
                  {previewItem.size_formatted}
                </span>
              </div>

              <div className="flex items-center gap-1.5">
                {previewContent && (
                  <button
                    type="button"
                    onClick={() => handleCopy(previewContent)}
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground transition"
                    title="复制内容"
                  >
                    {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  </button>
                )}
                <a
                  href={getWorkspaceDownloadUrl(previewItem.path)}
                  download={previewItem.name}
                  className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-primary/20 hover:text-primary transition"
                  title="下载文件"
                >
                  <Download className="size-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteItem(previewItem)}
                  className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition"
                  title="删除此文件"
                >
                  <Trash2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewItem(null)}
                  className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground transition"
                  title="关闭预览"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>

            {/* 预览展示区域 */}
            <div className="flex-1 overflow-auto p-4 max-h-[70vh]">
              {previewLoading && (
                <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
                  <RefreshCw className="size-4 animate-spin mr-2 text-primary" />
                  加载中...
                </div>
              )}

              {/* 图片预览 */}
              {!previewLoading &&
                ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(
                  previewItem.extension.toLowerCase()
                ) && (
                  <div className="flex items-center justify-center bg-black/40 rounded-xl p-4">
                    <img
                      src={getWorkspaceDownloadUrl(previewItem.path, true)}
                      alt={previewItem.name}
                      className="max-h-[60vh] max-w-full rounded-lg object-contain shadow-lg"
                    />
                  </div>
                )}

              {/* 文本内容预览 */}
              {!previewLoading &&
                !['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif', 'bmp'].includes(
                  previewItem.extension.toLowerCase()
                ) && (
                  <pre className="rounded-xl border border-white/6 bg-black/40 p-3.5 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-words leading-relaxed select-text">
                    {previewContent || '（空文件）'}
                  </pre>
                )}
            </div>
          </div>
        </div>
      )}

      {/* 单文件/目录删除确认弹窗 */}
      {confirmDeleteItem && (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="relative w-full max-w-sm rounded-2xl border border-white/15 bg-background p-5 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">
                  {confirmDeleteItem.is_dir ? '确认删除目录？' : '确认删除文件？'}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  即将永久删除{' '}
                  <span className="font-mono font-medium text-foreground">
                    {confirmDeleteItem.name}
                  </span>
                  {confirmDeleteItem.is_dir ? ' 及其内部的所有子文件' : ''}，此操作无法恢复。
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteItem(null)}
                disabled={!!deletingPath}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted-foreground hover:bg-white/6 hover:text-foreground transition disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteItem(confirmDeleteItem)}
                disabled={!!deletingPath}
                className="flex items-center gap-1.5 rounded-lg bg-destructive px-3.5 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition active:scale-95 disabled:opacity-50"
              >
                {deletingPath ? <RefreshCw className="size-3.5 animate-spin" /> : null}
                <span>确认删除</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 清空工作区确认弹窗 */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="relative w-full max-w-sm rounded-2xl border border-white/15 bg-background p-5 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/15 text-destructive">
                <AlertTriangle className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">确认清空所有成果？</h3>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  将彻底删除当前工作区内所有成果文件与上传文件。
                </p>
                <div className="mt-2 rounded-lg bg-white/4 p-2 text-[11px] text-muted-foreground/80">
                  <span className="text-emerald-400 font-medium">安全保障：</span>Agent 人设规范与长期记忆库已受保护，不受任何影响。
                </div>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                disabled={clearing}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-muted-foreground hover:bg-white/6 hover:text-foreground transition disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleClearWorkspace()}
                disabled={clearing}
                className="flex items-center gap-1.5 rounded-lg bg-destructive px-3.5 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition active:scale-95 disabled:opacity-50"
              >
                {clearing ? <RefreshCw className="size-3.5 animate-spin" /> : null}
                <span>确认清空</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 浮动操作提示 Toast */}
      {actionToast && (
        <div className="fixed bottom-6 right-6 z-80 flex items-center gap-2 rounded-xl border border-white/10 bg-background/95 px-4 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150">
          {actionToast.type === 'success' ? (
            <Check className="size-4 text-emerald-400" />
          ) : (
            <AlertTriangle className="size-4 text-destructive" />
          )}
          <span className="text-xs font-medium text-foreground">{actionToast.message}</span>
        </div>
      )}
    </div>
  )
}
