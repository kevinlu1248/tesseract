// Render src/renderer/public/icon.svg → build/icon.png with a TRANSPARENT
// background, using a headless transparent Electron window (no ImageMagick/
// rsvg needed). Run: `node_modules/.bin/electron scripts/gen-icon.cjs`.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const svg = fs.readFileSync(path.join(root, 'src/renderer/public/icon.svg'), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;width:512px;height:512px;overflow:hidden}
  svg{display:block;width:512px;height:512px}
</style></head><body>${svg}</body></html>`

app.commandLine.appendSwitch('force-color-profile', 'srgb')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 500))
  let img = await win.webContents.capturePage()
  // Retina capture comes back at 2x — normalize to a crisp 512².
  img = img.resize({ width: 512, height: 512, quality: 'best' })
  fs.writeFileSync(path.join(root, 'build/icon.png'), img.toPNG())
  win.destroy()
  app.quit()
})
