'use client'

import { useState, useRef, DragEvent } from 'react'
import {
  Box,
  TextField,
  IconButton,
  CircularProgress,
  Paper,
  Typography,
  LinearProgress,
} from '@mui/material'
import SendIcon from '@mui/icons-material/Send'
import AttachFileIcon from '@mui/icons-material/AttachFile'
import CloseIcon from '@mui/icons-material/Close'
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile'
import { fileApi, FileMetadata } from '@/app/lib/api'
import { useNotifications } from '@/app/lib/notifications'
import { formatFileSize } from '@/app/lib/utils'

interface MessageInputProps {
  onSend: (content: string, fileId?: string) => Promise<void>
  disabled?: boolean
}

export default function MessageInput({ onSend, disabled }: MessageInputProps) {
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [attachedFile, setAttachedFile] = useState<FileMetadata | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { showError } = useNotifications()

  const maxSizeBytes = 25 * 1024 * 1024

  const validateFile = (file: File): string | null => {
    if (file.size === 0) {
      return 'File is empty'
    }
    if (file.size > maxSizeBytes) {
      return 'File too large. Maximum size is 25MB'
    }
    return null
  }

  const uploadFile = async (file: File) => {
    const validationError = validateFile(file)
    if (validationError) {
      showError(validationError)
      return
    }

    setUploading(true)
    try {
      const reader = new FileReader()

      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1]
        const uploadedFile = await fileApi.uploadFile(
          file.name,
          file.type || 'application/octet-stream',
          base64
        )
        setAttachedFile(uploadedFile)
      }

      reader.onerror = () => {
        showError('Failed to read file')
      }

      reader.readAsDataURL(file)
    } catch (err: any) {
      showError(err?.message || 'Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  const handleDrag = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (uploading || disabled) return

    const files = e.dataTransfer.files
    if (files && files.length > 0) {
      uploadFile(files[0])
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (uploading || disabled) return

    const files = e.target.files
    if (files && files.length > 0) {
      uploadFile(files[0])
    }
  }

  const handleRemoveFile = () => {
    setAttachedFile(null)
  }

  const handleSend = async () => {
    if ((!content.trim() && !attachedFile) || sending) return

    setSending(true)
    try {
      await onSend(content, attachedFile?.id)
      setContent('')
      setAttachedFile(null)
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <Box
      sx={{
        p: 2,
        borderTop: 1,
        borderColor: 'divider',
        position: 'relative',
        bgcolor: dragActive ? 'action.hover' : 'background.paper',
        transition: 'background-color 0.2s',
      }}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      {/* Drag Overlay */}
      {dragActive && (
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(0, 0, 0, 0.05)',
            border: '2px dashed',
            borderColor: 'primary.main',
          }}
        >
          <Typography variant="h6" color="primary">
            Drop to Upload
          </Typography>
        </Box>
      )}

      {/* File Preview Card */}
      {attachedFile && (
        <Box sx={{ mb: 2, display: 'flex' }}>
          <Paper
            elevation={3}
            sx={{
              p: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              position: 'relative',
              width: 200,
              bgcolor: 'background.default',
            }}
          >
            <IconButton
              size="small"
              onClick={handleRemoveFile}
              sx={{ position: 'absolute', top: 4, right: 4 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
            <InsertDriveFileIcon sx={{ fontSize: 40, color: 'primary.main', mb: 1 }} />
            <Typography variant="body2" noWrap sx={{ width: '100%', fontWeight: 'bold' }}>
              {attachedFile.original_name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatFileSize(attachedFile.size)}
            </Typography>
          </Paper>
        </Box>
      )}

      {/* Upload Progress */}
      {uploading && (
        <Box sx={{ mb: 2, width: '100%' }}>
          <Typography variant="caption" color="text.secondary" gutterBottom>
            Uploading file...
          </Typography>
          <LinearProgress />
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1 }}>
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileInput}
          style={{ display: 'none' }}
          disabled={uploading || disabled}
        />

        <IconButton
          color="primary"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || disabled || !!attachedFile}
          sx={{ mb: 1 }} // Aligned with bottom of text field
        >
          <AttachFileIcon />
        </IconButton>

        <Box sx={{ flex: 1 }}>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            placeholder="Message"
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyPress={handleKeyPress}
            disabled={disabled || sending}
            variant="outlined"
            size="small"
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 4,
              },
            }}
          />
        </Box>

        <IconButton
          color="primary"
          onClick={handleSend}
          disabled={(!content.trim() && !attachedFile) || disabled || sending}
          sx={{ mb: 1 }}
        >
          {sending ? <CircularProgress size={24} /> : <SendIcon />}
        </IconButton>
      </Box>
    </Box>
  )
}
