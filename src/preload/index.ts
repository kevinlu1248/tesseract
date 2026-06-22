import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AnswerPermissionArgs,
  type AnswerQuestionArgs,
  type BackendProvider,
  type ReviveSessionArgs,
  type SendArgs,
  type SessionEventEnvelope,
  type StartSessionArgs,
  type WorkspaceApi
} from '../shared/ipc'

const api: WorkspaceApi = {
  getAuth: () => ipcRenderer.invoke(IPC.authGet),
  pickRepo: () => ipcRenderer.invoke(IPC.dialogPickRepo),
  startSession: (args: StartSessionArgs) => ipcRenderer.invoke(IPC.sessionStart, args),
  reviveSession: (args: ReviveSessionArgs) => ipcRenderer.invoke(IPC.sessionRevive, args),
  send: (args: SendArgs) => ipcRenderer.invoke(IPC.sessionSend, args),
  interrupt: (localId: string) => ipcRenderer.invoke(IPC.sessionInterrupt, localId),
  closeSession: (localId: string) => ipcRenderer.invoke(IPC.sessionClose, localId),
  answerPermission: (args: AnswerPermissionArgs) =>
    ipcRenderer.invoke(IPC.permissionAnswer, args),
  answerQuestion: (args: AnswerQuestionArgs) =>
    ipcRenderer.invoke(IPC.questionAnswer, args),
  listSessions: (cwd: string, provider?: BackendProvider) =>
    ipcRenderer.invoke(IPC.sessionList, cwd, provider),
  loadHistory: (args: { sessionId: string; cwd: string; provider?: BackendProvider }) =>
    ipcRenderer.invoke(IPC.sessionLoadHistory, args),
  generateTitle: (firstMessage: string) =>
    ipcRenderer.invoke(IPC.sessionGenerateTitle, firstMessage),
  getRecentScreenshot: () => ipcRenderer.invoke(IPC.screenshotRecent),
  focusWindow: () => ipcRenderer.invoke(IPC.windowFocus),
  onSessionEvent: (cb: (env: SessionEventEnvelope) => void) => {
    const listener = (_e: IpcRendererEvent, env: SessionEventEnvelope): void => cb(env)
    ipcRenderer.on(IPC.sessionEvent, listener)
    return () => ipcRenderer.removeListener(IPC.sessionEvent, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
