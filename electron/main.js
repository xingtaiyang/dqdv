const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let serverProcess = null;

function startServer() {
  const isDev = !app.isPackaged;
  let serverPath;
  if (isDev) {
    serverPath = path.join(__dirname, '..', 'server.js');
  } else {
    serverPath = path.join(process.resourcesPath, 'app.asar', 'server.js');
  }
  
  try {
    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: 3000 },
      stdio: 'pipe'
    });
    console.log('后端服务已启动，端口 3000');
  } catch (e) {
    console.error('后端启动失败:', e);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // ===== 覆盖 prompt，避免导出报错 =====
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      window.prompt = (message, defaultValue) => {
        // 直接返回默认值（空字符串），避免报错
        return defaultValue || '';
      };
      console.log('prompt 已覆盖，导出功能可正常使用');
    `);
  });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
