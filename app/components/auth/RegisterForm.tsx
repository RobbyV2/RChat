'use client'

import { useState } from 'react'
import {
  Box,
  Button,
  TextField,
  FormControl,
  FormLabel,
  RadioGroup,
  FormControlLabel,
  Radio,
  Alert,
  CircularProgress,
  Chip,
  Stack,
  Typography,
} from '@mui/material'
import { authApi } from '@/app/lib/api'
import type { PasswordMode, ProfileType } from '@/app/types/auth'

interface RegisterFormProps {
  onSuccess?: () => void
  onSwitchToLogin?: () => void
}

export default function RegisterForm({ onSuccess, onSwitchToLogin }: RegisterFormProps) {
  const [username, setUsername] = useState('')
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('text')
  const [textPassword, setTextPassword] = useState('')
  const [availableWords, setAvailableWords] = useState<string[]>([])
  const [selectedWords, setSelectedWords] = useState<string[]>([])
  const [profileType, setProfileType] = useState<ProfileType>('identicon')
  const [avatarColor, setAvatarColor] = useState('#3f51b5')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [generatingWords, setGeneratingWords] = useState(false)

  const handleGenerateWords = async () => {
    if (!username.trim()) {
      setError('Please enter a username first')
      return
    }

    setGeneratingWords(true)
    setError('')
    setAvailableWords([])
    setSelectedWords([])

    try {
      const words = await authApi.getWordSequence(username.trim())
      setAvailableWords(words)
    } catch (err) {
      setError('Failed to generate word sequence')
    } finally {
      setGeneratingWords(false)
    }
  }

  const handleWordClick = (word: string) => {
    if (selectedWords.includes(word)) {
      setSelectedWords(prev => prev.filter(w => w !== word))
    } else {
      if (selectedWords.length < 7) {
        setSelectedWords(prev => [...prev, word])
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!username.trim()) {
      setError('Username is required')
      return
    }

    if (passwordMode === 'text' && !textPassword) {
      setError('Password is required')
      return
    }

    if (passwordMode === 'word' && selectedWords.length !== 7) {
      setError('Please select exactly 7 words')
      return
    }

    setLoading(true)

    try {
      const payload = {
        username: username.trim(),
        password: passwordMode === 'text' ? textPassword : undefined,
        word_sequence: passwordMode === 'word' ? selectedWords : undefined,
        profile_type: profileType,
        avatar_color: profileType === 'person' ? avatarColor : undefined,
      }
      console.log('Registration payload:', payload)

      await authApi.register(payload)

      onSuccess?.()
    } catch (err: any) {
      console.error('Registration error:', err)
      const errorMsg = err.data?.message || err.message || 'Registration failed'
      setError(`${errorMsg} (${err.status || 'unknown status'})`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 400, mx: 'auto', p: 3 }}>
      <h2>Register</h2>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <TextField
        fullWidth
        label="Username"
        value={username}
        onChange={e => setUsername(e.target.value)}
        margin="normal"
        required
      />

      <FormControl component="fieldset" margin="normal" fullWidth>
        <FormLabel>Password Type</FormLabel>
        <RadioGroup
          value={passwordMode}
          onChange={e => setPasswordMode(e.target.value as PasswordMode)}
        >
          <FormControlLabel value="text" control={<Radio />} label="Text Password" />
          <FormControlLabel value="word" control={<Radio />} label="Word Sequence (7 words)" />
        </RadioGroup>
      </FormControl>

      {passwordMode === 'text' ? (
        <TextField
          fullWidth
          type="password"
          label="Password"
          value={textPassword}
          onChange={e => setTextPassword(e.target.value)}
          margin="normal"
          required
        />
      ) : (
        <Box sx={{ my: 2 }}>
          <Button
            variant="outlined"
            onClick={handleGenerateWords}
            disabled={generatingWords}
            fullWidth
          >
            {generatingWords ? 'Generating...' : 'Get Word Assortment'}
          </Button>

          {availableWords.length > 0 && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Select 7 words in order ({selectedWords.length}/7):
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 1,
                  mt: 1,
                  p: 1,
                  border: '1px solid #ccc',
                  borderRadius: 1,
                }}
              >
                {availableWords.map((word, index) => (
                  <Chip
                    key={index}
                    label={word}
                    onClick={() => handleWordClick(word)}
                    color={selectedWords.includes(word) ? 'primary' : 'default'}
                    variant={selectedWords.includes(word) ? 'filled' : 'outlined'}
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
              </Box>
              <Typography variant="caption" color="text.secondary">
                Selected: {selectedWords.join(' ')}
              </Typography>
            </>
          )}
        </Box>
      )}

      <FormControl component="fieldset" margin="normal" fullWidth>
        <FormLabel>Profile Avatar</FormLabel>
        <RadioGroup
          value={profileType}
          onChange={e => setProfileType(e.target.value as ProfileType)}
        >
          <FormControlLabel value="identicon" control={<Radio />} label="Identicon (generated)" />
          <FormControlLabel value="person" control={<Radio />} label="Person (choose color)" />
        </RadioGroup>
      </FormControl>

      {profileType === 'person' && (
        <TextField
          fullWidth
          type="color"
          label="Avatar Color"
          value={avatarColor}
          onChange={e => setAvatarColor(e.target.value)}
          margin="normal"
        />
      )}

      <Button type="submit" variant="contained" fullWidth disabled={loading} sx={{ mt: 3, mb: 2 }}>
        {loading ? <CircularProgress size={24} /> : 'Register'}
      </Button>

      <Button variant="text" fullWidth onClick={onSwitchToLogin}>
        Already have an account? Login
      </Button>
    </Box>
  )
}
