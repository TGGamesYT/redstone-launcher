const path = require('path'); // ← add this
const { app, BrowserWindow } = require('electron')

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true
    }
  })

  win.loadFile('frontend/index.html')
}

app.whenReady().then(createWindow)
