'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  ToggleButtonGroup,
  ToggleButton,
} from '@mui/material'

interface CreateDialogProps {
  open: boolean
  onClose: () => void
  title: string
  label: string
  onSubmit: (name: string) => Promise<void>
  showToggle?: boolean
  toggleLabel1?: string
  toggleLabel2?: string
  placeholder?: string
}

export default function CreateDialog({
  open,
  onClose,
  title,
  label,
  onSubmit,
  showToggle = false,
  toggleLabel1 = 'Create',
  toggleLabel2 = 'Join',
  placeholder,
}: CreateDialogProps) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'create' | 'join'>('create')

  const handleClose = () => {
    setName('')
    setMode('create')
    onClose()
  }

  const handleSubmit = async () => {
    if (!name.trim()) return

    setLoading(true)
    try {
      await onSubmit(name.trim())
      handleClose()
    } finally {
      setLoading(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      handleSubmit()
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {showToggle && (
          <ToggleButtonGroup
            value={mode}
            exclusive
            onChange={(_, value) => value && setMode(value)}
            fullWidth
            sx={{ mb: 2 }}
          >
            <ToggleButton value="create">{toggleLabel1}</ToggleButton>
            <ToggleButton value="join">{toggleLabel2}</ToggleButton>
          </ToggleButtonGroup>
        )}
        <TextField
          autoFocus
          margin="dense"
          label={label}
          fullWidth
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyPress={handleKeyPress}
          disabled={loading}
          placeholder={placeholder}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={loading}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={loading || !name.trim()}>
          {loading ? 'Loading...' : mode === 'create' ? toggleLabel1 : toggleLabel2}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
