import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import {
  IPC,
  type AnswerPermissionArgs,
  type AnswerQuestionArgs,
  type BackendProvider,
  type CreateWorktreeArgs,
  type NotifyArgs,
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

  const focus = (): void => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  ipcMain.handle(IPC.windowFocus, () => focus())

  // OS notifications for background-finished turns are created HERE (main), not
  // in the renderer. A renderer-side Web Notification can be garbage-collected
  // before the user clicks it, silently dropping its `onclick` — at which point
  // clicking the banner falls through to the OS default activation (which, in
  // this app, surfaced the repo picker instead of focusing the conversation).
  // A main-process Notification kept referenced until click avoids that.
  //
  // Keyed by localId so a newer notification for the same tab replaces the
  // previous one. The reference is held until the notification is clicked, so
  // its `click` handler is always live — even from Notification Center.
  const liveNotifications = new Map<string, Notification>()
  ipcMain.on(IPC.notifyShow, (_e, args: NotifyArgs) => {
    if (!Notification.isSupported()) return
    liveNotifications.get(args.localId)?.close()
    const n = new Notification({
      title: args.title || 'Tesseract',
      body: args.body || 'Finished responding'
    })
    liveNotifications.set(args.localId, n)
    n.on('click', () => {
      liveNotifications.delete(args.localId)
      focus()
      const win = getWindow()
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC.notifyClicked, args.localId)
      }
    })
    n.show()
  })

  // Restart into the latest code — a true rebuild + relaunch.
  //
  // In dev (`electron-vite dev`), the Vite dev server and the main/preload
  // build live in the PARENT electron-vite process. A bare `app.relaunch()`
  // would kill that parent (dev server dies, `out/main` goes stale) and come
  // back blank. So instead we spawn a FRESH `npm run dev` — which rebuilds
  // main/preload and serves the latest renderer — detached so it outlives this
  // process, then quit. The short sleep lets the old dev server release the
  // pinned port (strictPort 5273) before the new one binds.
  //
  // In a packaged build there is no dev server: relaunch the whole app so both
  // main and renderer load the new code on disk.
  //
  // Either way `app.quit()` fires `before-quit`, tearing down every live
  // session's subprocess so the new instance starts clean (stragglers are
  // reaped on boot by sweepOrphanAgents).
  ipcMain.handle(IPC.appRestart, () => {
    if (process.env['ELECTRON_RENDERER_URL']) {
      const projectRoot = join(__dirname, '..', '..') // out/main -> project root
      spawn('sh', ['-c', 'sleep 2 && npm run dev'], {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env
      }).unref()
      app.quit()
      return
    }
    app.relaunch()
    app.quit()
  })

  return manager
}
