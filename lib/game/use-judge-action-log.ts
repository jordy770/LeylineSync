'use client'

import { useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { devUndoAction, getErrorMessage } from './actions'

export function useJudgeActionLog(onChanged: () => Promise<void>) {
  const supabase = useMemo(() => createClient(), [])
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const handleUndo = async (actionId: string) => {
    setPendingActionId(actionId)
    setMessage(null)

    try {
      await devUndoAction(supabase, actionId)
      setMessage('Action undone')
      await onChanged()
    } catch (error) {
      const nextMessage = getErrorMessage(error)
      console.error('Failed to undo judge action:', nextMessage, error)
      setMessage(nextMessage)
    } finally {
      setPendingActionId(null)
    }
  }

  return {
    pendingActionId,
    message,
    handleUndo,
  }
}
