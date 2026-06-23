import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AnswerPermissionArgs,
  type AnswerQuestionArgs,
  type BackendProvider,
  type CreateWorktreeArgs,
  type NotifyArgs,
  type ReviveSessionArgs,
  type RewindArgs,
  type SendArgs,
  type SessionCardUpdate,
  type SessionEventEnvelope,
  type StartSessionArgs,
  type SummarizeSessionArgs,
  type WorkspaceApi
} from '../shared/ipc'

const api: WorkspaceApi = {
  getAuth: () => ipcRenderer.invoke(IPC.authGet),
  pickRepo: () => ipcRenderer.invoke(IPC.dialogPickRepo),
  startSession: (args: StartSessionArgs) => ipcRenderer.invoke(IPC.sessionStart, args),
  createWorktree: (args: CreateWorktreeArgs) => ipcRenderer.invoke(IPC.worktreeCreate, args),
  reviveSession: (args: ReviveSessionArgs) => ipcRenderer.invoke(IPC.sessionRevive, args),
  send: (args: SendArgs) => ipcRenderer.invoke(IPC.sessionSend, args),
  rewind: (args: RewindArgs) => ipcRenderer.invoke(IPC.sessionRewind, args),
  interrupt: (localId: string) => ipcRenderer.invoke(IPC.sessionInterrupt, localId),
  closeSession: (localId: string) => ipcRenderer.invoke(IPC.sessionClose, localId),
  answerPermission: (args: AnswerPermissionArgs) =>
    ipcRenderer.invoke(IPC.permissionAnswer, args),
  answerQuestion: (args: AnswerQuestionArgs) =>
    ipcRenderer.invoke(IPC.questionAnswer, args),
  listSessions: (cwd: string, provider?: BackendProvider) =>
    ipcRenderer.invoke(IPC.sessionList, cwd, provider),
  getSessionSummaries: (cwd: string, provider?: BackendProvider) =>
    ipcRenderer.invoke(IPC.sessionSummaries, cwd, provider),
  generateSessionSummary: (sessionId: string, cwd: string, provider?: BackendProvider) =>
    ipcRenderer.invoke(IPC.sessionGenerateSummary, sessionId, cwd, provider),
  loadHistory: (args: { sessionId: string; cwd: string; provider?: BackendProvider }) =>
    ipcRenderer.invoke(IPC.sessionLoadHistory, args),
  generateTitle: (firstMessage: string) =>
    ipcRenderer.invoke(IPC.sessionGenerateTitle, firstMessage),
  summarizeSession: (args: SummarizeSessionArgs) =>
    ipcRenderer.invoke(IPC.sessionSummarize, args),
  getRecentScreenshot: () => ipcRenderer.invoke(IPC.screenshotRecent),
  focusWindow: () => ipcRenderer.invoke(IPC.windowFocus),
  showNotification: (args: NotifyArgs) => ipcRenderer.send(IPC.notifyShow, args),
  onNotificationClicked: (cb: (localId: string) => void) => {
    const listener = (_e: IpcRendererEvent, localId: string): void => cb(localId)
    ipcRenderer.on(IPC.notifyClicked, listener)
    return () => ipcRenderer.removeListener(IPC.notifyClicked, listener)
  },
  restartApp: () => ipcRenderer.invoke(IPC.appRestart),
  onClosePaneRequest: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.menuClosePane, listener)
    return () => ipcRenderer.removeListener(IPC.menuClosePane, listener)
  },
  onSessionEvent: (cb: (env: SessionEventEnvelope) => void) => {
    const listener = (_e: IpcRendererEvent, env: SessionEventEnvelope): void => cb(env)
    ipcRenderer.on(IPC.sessionEvent, listener)
    return () => ipcRenderer.removeListener(IPC.sessionEvent, listener)
  },
  onSessionSummaryUpdated: (cb: (update: SessionCardUpdate) => void) => {
    const listener = (_e: IpcRendererEvent, update: SessionCardUpdate): void => cb(update)
    ipcRenderer.on(IPC.sessionSummaryUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.sessionSummaryUpdated, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
