import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  IPC,
  type AnswerPermissionArgs,
  type AnswerQuestionArgs,
  type BackendProvider,
  type CreateWorktreeArgs,
  type ReviveSessionArgs,
  type SendArgs,
  type SessionCardUpdate,
  type SessionEventEnvelope,
  type StartSessionArgs,
  type SummarizeSessionArgs
} from '../shared/ipc'
import { detectAuth } from './auth'
import { findRecentScreenshot } from './screenshots'
import { SessionManager } from './sessions/SessionManager'
import { createWorktree } from './sessions/worktree'

export function registerIpc(getWindow: () => BrowserWindow | null): SessionManager {
  const broadcast = (env: SessionEventEnvelope): void => {
    const win = getWindow()
    // Guard against a disposed/reloading renderer: without this, a GPU crash or
    // an HMR reload leaves the frame gone and every agent event throws
    // "Render frame was disposed", flooding the log and taking the app down.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(IPC.sessionEvent, env)
    } catch {
      /* frame torn down mid-send — drop this event */
    }
  }
  const broadcastSummary = (update: SessionCardUpdate): void => {
    const win = getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    try {
      win.webContents.send(IPC.sessionSummaryUpdated, update)
    } catch {
      /* frame torn down mid-send — drop this update */
    }
  }
  const manager = new SessionManager(broadcast, broadcastSummary)

  ipcMain.handle(IPC.authGet, () => detectAuth())

  ipcMain.handle(IPC.dialogPickRepo, async () => {
    const win = getWindow()
    const opts = {
      title: 'Open a repository',
      properties: ['openDirectory', 'createDirectory'] as const
    }
    const result = win
      ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] })
      : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.sessionStart, (_e, args: StartSessionArgs) => manager.start(args))
  ipcMain.handle(IPC.worktreeCreate, (_e, args: CreateWorktreeArgs) => createWorktree(args))
  ipcMain.handle(IPC.sessionRevive, (_e, args: ReviveSessionArgs) => manager.revive(args))
  ipcMain.handle(IPC.sessionSend, (_e, args: SendArgs) => manager.send(args))
  ipcMain.handle(IPC.sessionInterrupt, (_e, localId: string) => manager.interrupt(localId))
  ipcMain.handle(IPC.sessionClose, (_e, localId: string) => manager.close(localId))
  ipcMain.handle(IPC.permissionAnswer, (_e, args: AnswerPermissionArgs) =>
    manager.answerPermission(args)
  )
  ipcMain.handle(IPC.questionAnswer, (_e, args: AnswerQuestionArgs) =>
    manager.answerQuestion(args)
  )
  ipcMain.handle(IPC.sessionList, (_e, cwd: string, provider?: BackendProvider) =>
    manager.listSessions(cwd, provider)
  )
  ipcMain.handle(IPC.sessionSummaries, (_e, cwd: string, provider?: BackendProvider) =>
    manager.getSessionSummaries(cwd, provider)
  )
  ipcMain.handle(
    IPC.sessionGenerateSummary,
    (_e, sessionId: string, cwd: string, provider?: BackendProvider) =>
      manager.generateSessionSummary(cwd, provider, sessionId)
  )
  ipcMain.handle(
    IPC.sessionLoadHistory,
    (_e, args: { sessionId: string; cwd: string; provider?: BackendProvider }) =>
      manager.loadHistory(args)
  )
  ipcMain.handle(IPC.sessionGenerateTitle, (_e, firstMessage: string) =>
    manager.generateTitle(firstMessage)
  )
  ipcMain.handle(IPC.sessionSummarize, (_e, args: SummarizeSessionArgs) =>
    manager.summarizeSession(args)
  )

  ipcMain.handle(IPC.screenshotRecent, () => findRecentScreenshot())

  ipcMain.handle(IPC.windowFocus, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  return manager
}
