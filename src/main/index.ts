import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { registerIpc } from './ipc'

// Set the app name as early as possible (before `ready` / any menu is built) so
// the macOS menu bar, About/Hide/Quit items, and notifications read "Tesseract"
// instead of "Electron" (the dev binary's bundle name) or the bare package
// name. Packaged builds also pick up `productName` from package.json.
app.setName('Tesseract')

// setName() ALSO relocates the userData dir (to ".../Tesseract"), which would
// strand the existing localStorage — saved tabs, titles, drafts — in the dir
// from a previous name. Pin userData to the original stable "claude-workspace"
// location so renaming the app never orphans persisted state.
app.setPath('userData', join(app.getPath('appData'), 'claude-workspace'))

let mainWindow: BrowserWindow | null = null

/** App icon shipped at <root>/build/icon.png (empty image if missing — never throws). */
const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))

/**
 * Kill any Claude agent subprocesses orphaned by a previously crashed or
 * hard-restarted instance (e.g. an electron-vite dev restart that SIGKILLs the
 * old app, reparenting its `claude` children to launchd). The match pattern is
 * the SDK's bundled binary path, so it never touches the user's own terminal
 * `claude` sessions. Safe to run at startup: this instance has no children yet.
 */
function sweepOrphanAgents(): void {
  try {
    execFile('pkill', ['-9', '-f', 'claude-agent-sdk-darwin-arm64/claude'], () => {})
  } catch {
    /* best-effort */
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Tesseract',
    icon: appIcon.isEmpty() ? undefined : appIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Open external links in the user's browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // electron-vite injects the dev server URL in development.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single-instance lock: a second launch would spawn its own fleet of agent
// subprocesses on top of the first's, compounding resource use. Refuse it and
// just focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    // Reap any agents orphaned by a previous instance before we start our own.
    sweepOrphanAgents()

    // macOS shows the dock icon from here (the BrowserWindow `icon` is Win/Linux only).
    if (process.platform === 'darwin' && app.dock && !appIcon.isEmpty()) {
      app.dock.setIcon(appIcon)
    }

    const manager = registerIpc(() => mainWindow)

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // Tear down every live session's subprocess on quit so nothing is orphaned.
    app.on('before-quit', () => {
      void manager.closeAll()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
