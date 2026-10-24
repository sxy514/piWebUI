import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  FolderArchive,
  Folder,
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
} from 'lucide-react'
import {
  getWorkspaceFiles,
  getWorkspaceDownloadUrl,
  getWorkspaceArchiveUrl,
  type WorkspaceItem,
  type WorkspaceFilesResponse,
} from '@/lib/api'
import { cn } from '@/lib/utils'

interface WorkspaceDrawerProps {
  open: boolean
  onClose: () => void
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

export function WorkspaceDrawer({ open, onClose }: WorkspaceDrawerProps) {
  const [data, setData] = useState<WorkspaceFilesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [previewItem, setPreviewItem] = useState<WorkspaceItem | null>(null)
  const [previewContent, setPreviewContent] = useState<string>('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [copied, setCopied] = useState(false)

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
        if (previewItem) {
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
  }, [open, onClose, previewItem])

  const filteredItems = useMemo(() => {
    if (!data?.items) return []
    const q = search.trim().toLowerCase()
    if (!q) return data.items
    return data.items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q)
    )
  }, [data?.items, search])

  const handlePreview = async (item: WorkspaceItem) => {
    const ext = item.extension.toLowerCase()
    setPreviewItem(item)
    setPreviewContent('')

    // 如果是图片，不需要异步拉取文本
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

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩背景 */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* 滑动抽屉 */}
      <div className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-white/10 bg-background/95 shadow-2xl backdrop-blur-2xl transition-transform animate-in slide-in-from-right duration-200 sm:max-w-lg">
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

        {/* 工具操作栏：搜索 + 一键打包下载 */}
        <div className="flex items-center gap-2 border-b border-white/6 px-4 py-2.5 bg-white/2">
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

          <a
            href={getWorkspaceArchiveUrl()}
            download
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition hover:bg-primary/20 active:scale-95"
            title="将工作区所有成果打包下载为 ZIP"
          >
            <Archive className="size-3.5" />
            <span>打包 ZIP</span>
          </a>
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

          {!loading && !error && filteredItems.length === 0 && (
            <div className="flex h-56 flex-col items-center justify-center gap-2.5 text-center text-xs text-muted-foreground/70">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-white/4 text-muted-foreground/40">
                <Folder className="size-6" />
              </div>
              <div>
                <p className="font-medium text-foreground/80">
                  {search ? '未搜索到匹配的文件' : '当前工作区暂无生成文件'}
                </p>
                <p className="mt-1 text-[11px] text-muted-foreground/50">
                  {search ? '换个关键词试试' : 'Agent 写入或产出的文件将自动归档显示在这里'}
                </p>
              </div>
            </div>
          )}

          {filteredItems.map((item) => {
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
                          <span className="truncate max-w-[120px]" title={item.path}>
                            {item.path}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* 操作按钮 */}
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
                </div>
              </div>
            )
          })}
        </div>

        {/* 底部信息提示 */}
        <div className="border-t border-white/6 px-4 py-2.5 text-[11px] text-muted-foreground/60 flex items-center justify-between">
          <span>文件保存在当前登录用户的独立隔离空间中</span>
          <span className="font-mono text-[10px] text-muted-foreground/40">{data?.workspace}</span>
        </div>
      </div>

      {/* 简易文本 / 图片预览弹窗 */}
      {previewItem && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-in fade-in duration-150">
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
    </div>
  )
}
