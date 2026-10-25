import { forwardRef, useRef, useState } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  Send,
  Square,
  Paperclip,
  X,
  FileText,
  FileSpreadsheet,
  FileCode,
  File,
  FileImage,
} from 'lucide-react'
import { uploadWorkspaceFile, type Attachment } from '@/lib/api'
import { cn } from '@/lib/utils'

interface ComposerProps {
  value: string
  streaming: boolean
  attachments: Attachment[]
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  onAddAttachment: (att: Attachment) => void
  onRemoveAttachment: (index: number) => void
}

function getAttachmentIcon(att: Attachment) {
  if (att.is_image) return <FileImage className="size-3.5 text-purple-400" />
  const ext = att.name.split('.').pop()?.toLowerCase() || ''
  if (['csv', 'xlsx', 'xls'].includes(ext)) {
    return <FileSpreadsheet className="size-3.5 text-emerald-400" />
  }
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'html', 'css', 'sql', 'sh'].includes(ext)) {
    return <FileCode className="size-3.5 text-blue-400" />
  }
  if (['pdf', 'docx', 'doc', 'md', 'txt', 'log'].includes(ext)) {
    return <FileText className="size-3.5 text-indigo-400" />
  }
  return <File className="size-3.5 text-muted-foreground" />
}

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(
  function Composer(
    {
      value,
      streaming,
      attachments,
      onChange,
      onSend,
      onStop,
      onAddAttachment,
      onRemoveAttachment,
    },
    ref,
  ) {
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [uploading, setUploading] = useState(false)
    const [dragOver, setDragOver] = useState(false)

    const handleUploadFiles = async (files: FileList | File[]) => {
      if (!files || files.length === 0) return
      setUploading(true)
      try {
        for (const file of Array.from(files)) {
          const att = await uploadWorkspaceFile(file)
          onAddAttachment(att)
        }
      } catch (err: unknown) {
        alert(err instanceof Error ? err.message : '上传文件失败')
      } finally {
        setUploading(false)
      }
    }

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items
      if (!items) return
      const filesToUpload: File[] = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile()
          if (file) filesToUpload.push(file)
        }
      }
      if (filesToUpload.length > 0) {
        e.preventDefault()
        void handleUploadFiles(filesToUpload)
      }
    }

    const canSend = (value.trim().length > 0 || attachments.length > 0) && !uploading

    return (
      <div
        className={cn(
          'glass rounded-3xl px-3 pt-2 pb-2.5 transition-all border',
          dragOver ? 'border-primary ring-2 ring-primary/20 bg-primary/5' : 'border-white/10'
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files) {
            void handleUploadFiles(e.dataTransfer.files)
          }
        }}
      >
        {/* 隐藏的原生文件上传 Input */}
        <input
          type="file"
          ref={fileInputRef}
          multiple
          onChange={(e) => {
            if (e.target.files) {
              void handleUploadFiles(e.target.files)
              e.target.value = ''
            }
          }}
          className="hidden"
        />

        {/* 附件展示列表 (位于输入框上方) */}
        {(attachments.length > 0 || uploading) && (
          <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2 border-b border-white/6 mb-1.5">
            {attachments.map((att, idx) => (
              <div
                key={`${att.path}-${idx}`}
                className="group flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/6 pl-1.5 pr-1 py-1 text-xs text-foreground/90 backdrop-blur-md transition hover:border-white/20"
              >
                {att.is_image && att.data ? (
                  <img
                    src={`data:${att.mime_type};base64,${att.data}`}
                    alt={att.name}
                    className="size-5 rounded object-cover"
                  />
                ) : (
                  getAttachmentIcon(att)
                )}
                <span className="max-w-[120px] truncate font-mono text-[11px] font-medium sm:max-w-[180px]">
                  {att.name}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {att.size_formatted}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(idx)}
                  className="flex size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
                  title="移除此附件"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}

            {uploading && (
              <div className="flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/10 px-2 py-1 text-xs text-primary animate-pulse">
                <Spinner className="size-3" />
                <span className="text-[11px] font-medium">正在上传解析...</span>
              </div>
            )}
          </div>
        )}

        {/* 文本输入框 */}
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSend) onSend()
            }
          }}
          placeholder={
            streaming
              ? '生成中… 可点击右侧按钮停止'
              : attachments.length > 0
                ? '输入关于所选附件的提问或分析要求，Enter 发送'
                : '输入消息，或拖拽/粘贴/点击回形针上传图片或文档，Enter 发送'
          }
          className="min-h-11 max-h-44 flex-1 resize-none border-none bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 text-sm"
          rows={1}
        />

        {/* 底部功能条 */}
        <div className="mt-1 flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] text-muted-foreground/70">
            {/* 上传文件按钮 */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || uploading}
              className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-white/10 hover:text-foreground disabled:opacity-40"
              title="上传文档、图片、表格或代码 (支持拖拽/截图粘贴)"
            >
              <Paperclip className="size-3.5 text-primary" />
              <span className="hidden sm:inline">添加文件/图片</span>
            </button>

            <span className="hidden rounded-md bg-white/6 px-1.5 py-0.5 sm:inline">
              PDF/Word/Excel
            </span>
            <span className="hidden rounded-md bg-white/6 px-1.5 py-0.5 sm:inline">
              图片视觉
            </span>

            {streaming && (
              <span className="flex items-center gap-1 text-primary">
                <Spinner className="size-3" /> 生成中
              </span>
            )}
          </div>

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              title="停止生成"
              className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-destructive text-white shadow-lg shadow-destructive/30 transition hover:brightness-110"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              title="发送 (Enter)"
              className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              <Send className="size-4" />
            </button>
          )}
        </div>
      </div>
    )
  },
)
