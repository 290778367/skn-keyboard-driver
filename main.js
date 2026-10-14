/**
 * SKN 键盘驱动 —— 桌面版（基于官方 SKN Launcher 引擎）
 *
 * v1.0.6 新增：
 *  - 数据本地化：应用数据（配对信息/缓存）保存在 exe 旁 data 文件夹，不写入 C 盘
 *
 * 主进程职责：
 *  - 品牌启动页 → 加载官方驱动网页（WebHID 直连键盘，完成键位/灯效/宏/固件等全部功能）
 *  - 状态检测双通道：WebHID 真实连接状态（权威）+ Windows PnP 硬件检测（VID_3434）
 *  - WebHID 权限放行 + 自动选择 SKN 设备
 *  - 离线兜底页、冒烟自检
 */
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const LAUNCHER_URL = 'https://launcher.skn.net.cn/';
const OFFICIAL_URL = 'https://sknlab.heidianer.com/collections'; // SKN 官方站点
const SKN_VENDOR_ID = 0x3434; // SKN / Keychron 共用厂商 ID
const POLL_MS = 2500;
const TITLEBAR_H = 38; // 自定义标题栏高度（px），页面内容需下移这么多

/* 数据本地化：把 Electron 用户数据目录改到 exe 旁 data 文件夹，避免写入 C 盘
 *  - 便携版：PORTABLE_EXECUTABLE_DIR（electron-builder 设置，即便携 exe 所在目录）
 *  - 安装版：安装目录（可写时）；不可写（如 Program Files）才回退系统默认目录
 */
function setupLocalUserData() {
  let base = null;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    base = process.env.PORTABLE_EXECUTABLE_DIR;
  } else {
    base = path.dirname(app.getPath('exe'));
  }
  const dir = path.join(base, 'data');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    app.setPath('userData', dir);
    console.log('[SKN] 应用数据目录(本地): ' + dir);
  } catch (e) {
    console.warn('[SKN] exe 旁目录不可写，回退系统默认数据目录: ' + e.message);
  }
}
setupLocalUserData();

let mainWindow = null;
let currentStatus = { state: 'none', connected: false, devices: [], names: [] };
let pollTimer = null;
let hidState = null; // 网页内 WebHID 上报的真实连接状态 { connected, names }
let pnpDevices = []; // PnP 检测到的硬件设备

/* ---------------- 设备检测（PowerShell / PnP，无原生依赖） ---------------- */
function querySknDevices() {
  return new Promise((resolve) => {
    const ps = [
      '$devs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match \'VID_3434\' } | Select-Object @{n=\'name\';e={$_.FriendlyName}}, @{n=\'pid\';e={ if ($_.InstanceId -match \'PID_([0-9A-Fa-f]{4})\') { $matches[1].ToUpper() } else { \'\' } }})',
      "if ($devs.Count -gt 0) { $devs | ConvertTo-Json -Compress } else { Write-Output '[]' }"
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      timeout: 8000,
      windowsHide: true
    }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const raw = JSON.parse(stdout.trim());
        const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        return resolve(arr.filter(d => d && d.pid));
      } catch { return resolve([]); }
    });
  });
}

/* 合并双通道状态：
 *   connected —— 网页内 WebHID 已连上（权威，优先）
 *   detected  —— 硬件已插入但尚未点击 Connect
 *   none      —— 未检测到任何设备
 */
function computeStatus() {
  if (hidState && hidState.connected) {
    return { state: 'connected', connected: true, names: (hidState.names || []).filter(Boolean) };
  }
  if (pnpDevices.length > 0) {
    return { state: 'detected', connected: false, names: [...new Set(pnpDevices.map(d => d.name || d.pid).filter(Boolean))] };
  }
  return { state: 'none', connected: false, names: [] };
}

async function refreshDeviceStatus() {
  pnpDevices = await querySknDevices();
  applyStatusToUI();
}

function applyStatusToUI() {
  const st = computeStatus();
  let title;
  if (st.state === 'connected') {
    const label = st.names.length ? st.names.join('、') : '键盘';
    title = `SKN 键盘驱动 - 已连接：${label}`;
  } else if (st.state === 'detected') {
    title = 'SKN 键盘驱动 - 已检测到键盘，点击 Connect 连接';
  } else {
    title = 'SKN 键盘驱动 - 未连接键盘';
  }
  currentStatus = { state: st.state, connected: st.connected, devices: pnpDevices, names: st.names, ts: Date.now() };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title);
    mainWindow.webContents.send('driver:status', currentStatus);
  }
  return currentStatus;
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: 'SKN 键盘驱动',
    backgroundColor: '#0f1220',
    frame: false, // 无边框，使用注入的自定义标题栏
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    // 只允许停留在官方驱动域内
    if (!url.startsWith(LAUNCHER_URL) && !/^file:/.test(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 最大化状态变化 → 通知渲染进程更新标题栏按钮图标
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('driver:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('driver:maximized', false);
  });

  // 注入驱动界面增强：自定义标题栏 + 左侧栏官网入口 + WebHID 真实状态监控
  // 全部自维护：前端框架重渲染导致元素被移除时自动重建
  const injectDriverUI = `
    (function(){
      if (window.__sknDriverUIInjected) return;
      window.__sknDriverUIInjected = true;
      var TBH = ${TITLEBAR_H};
      function report(st){
        if (window.sknDriver && window.sknDriver.__reportHidState) window.sknDriver.__reportHidState(st);
      }
      function ensureStyle(){
        var s = document.getElementById('skn-driver-style');
        if (!s){
          s = document.createElement('style');
          s.id = 'skn-driver-style';
          s.textContent = [
            '#skn-titlebar{position:fixed;top:0;left:0;right:0;height:' + TBH + 'px;z-index:2147483646;display:flex;align-items:center;justify-content:space-between;background:rgba(15,18,32,.94);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.08);-webkit-app-region:drag;user-select:none;font-family:"Microsoft YaHei","PingFang SC",sans-serif;}',
            '#skn-titlebar .skn-tb-left{display:flex;align-items:center;gap:8px;padding-left:12px;font-size:12.5px;color:#d7dbe8;letter-spacing:.4px;}',
            '#skn-titlebar .skn-tb-left svg{flex:none;}',
            '#skn-titlebar .skn-tb-right{display:flex;height:100%;-webkit-app-region:no-drag;}',
            '#skn-titlebar .skn-tb-btn{width:46px;height:100%;border:0;background:transparent;color:#9aa2b8;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;outline:0;transition:background .12s,color .12s;}',
            '#skn-titlebar .skn-tb-btn:hover{background:rgba(255,255,255,.10);color:#e6e9f2;}',
            '#skn-titlebar .skn-tb-close:hover{background:#e5484d;color:#fff;}',
            '#skn-app-wrap{position:absolute;top:' + TBH + 'px;left:0;right:0;bottom:0;overflow:hidden;}',
            '#skn-app-wrap app-root{display:block !important;height:100% !important;width:100% !important;}',
            '#skn-app-wrap .layout-container{height:100% !important;width:100% !important;}',
            '.skn-nav-item{position:relative;border-radius:10px;margin:2px 0;transition:background .12s;}',
            '.skn-nav-item:hover{background:rgba(255,255,255,.07);}',
            '.skn-nav-item svg{flex:none;color:var(--text_5);}',
            '.skn-nav-item span{color:var(--text_5);}'
          ].join(' ');
          (document.head || document.documentElement).appendChild(s);
        }
        return s;
      }
      // ---- 标题栏（自定义窗口控制，含最小化/最大化/关闭） ----
      function ensureTitlebar(){
        var el = document.getElementById('skn-titlebar');
        if (!el){
          el = document.createElement('div');
          el.id = 'skn-titlebar';
          el.innerHTML =
            '<div class="skn-tb-left"><svg width="15" height="15" viewBox="0 0 48 48" fill="none"><rect x="6" y="12" width="36" height="24" rx="3" stroke="#6e8cff" stroke-width="4"/><path d="M6 18h36" stroke="#6e8cff" stroke-width="4"/><path d="M12 24h3M19 24h3M26 24h3M33 24h3" stroke="#8fa3e8" stroke-width="3" stroke-linecap="round"/></svg><span>SKN 键盘驱动</span></div>' +
            '<div class="skn-tb-right">' +
              '<button class="skn-tb-btn" data-act="minimize" title="最小化">&#x2013;</button>' +
              '<button class="skn-tb-btn" data-act="maximize" title="最大化">&#x25A1;</button>' +
              '<button class="skn-tb-btn skn-tb-close" data-act="close" title="关闭">&#x2715;</button>' +
            '</div>';
          document.body.appendChild(el);
          el.querySelectorAll('.skn-tb-btn').forEach(function(b){
            b.addEventListener('click', function(){
              var a = b.getAttribute('data-act');
              if (window.sknDriver && window.sknDriver.windowControl) window.sknDriver.windowControl(a);
            });
          });
        }
        return el;
      }
      // ---- 页面内容下移，让出标题栏空间 ----
      function ensureWrap(){
        var wrap = document.getElementById('skn-app-wrap');
        var root = document.querySelector('app-root');
        if (!root) return;
        if (!wrap){
          wrap = document.createElement('div');
          wrap.id = 'skn-app-wrap';
          root.parentNode.insertBefore(wrap, root);
        }
        if (wrap.firstElementChild !== root) wrap.appendChild(root);
      }
      // ---- 左侧栏「官网」入口 ----
      function ensureNavItem(){
        if (document.getElementById('skn-nav-official')) return;
        var menu = document.querySelector('.aside-menu');
        if (!menu) return;
        var item = document.createElement('div');
        item.id = 'skn-nav-official';
        item.className = 'aside-menu g-flex g-flex-row g-item-center g-justify-start skn-nav-item';
        item.style.cursor = 'pointer';
        item.innerHTML =
          '<svg class="skn-nav-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text_5)" stroke-width="1.8">' +
            '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21"/><path d="M12 3C9.5 5.6 8.2 8.7 8.2 12s1.3 6.4 3.8 9"/></svg>' +
          '<span>官网</span>';
        item.addEventListener('click', function(){
          if (window.sknDriver && window.sknDriver.openOfficialSite) window.sknDriver.openOfficialSite();
        });
        menu.parentNode.insertBefore(item, menu.nextSibling);
      }
      function bootstrap(){
        ensureStyle();
        ensureTitlebar();
        ensureWrap();
        ensureNavItem();
      }
      if (document.body){ bootstrap(); } else { document.addEventListener('DOMContentLoaded', bootstrap); }
      try {
        new MutationObserver(function(){
          ensureStyle(); ensureTitlebar(); ensureWrap(); ensureNavItem();
        }).observe(document.documentElement, {childList:true, subtree:true});
      } catch(e){}
      // 最大化状态 → 切换按钮图标
      if (window.sknDriver && window.sknDriver.onMaximized){
        window.sknDriver.onMaximized(function(m){
          var b = document.querySelector('#skn-titlebar .skn-tb-btn[data-act="maximize"]');
          if (b) b.innerHTML = m ? '&#x274F;' : '&#x25A1;';
        });
      }
      // ---- WebHID 真实连接状态（只认 SKN 厂商 0x3434，避免把其它 8C 设备误当键盘） ----
      function collectSkn(devs){
        return (devs || []).filter(function(d){ return d.opened && d.vendorId === 0x3434; });
      }
      function reportSkn(devs){
        var skn = collectSkn(devs);
        if (skn.length) {
          report({ connected: true, names: skn.map(function(d){ return d.productName || d.name || ''; }) });
        } else {
          report({ connected: false, names: [] });
        }
      }
      try {
        if (navigator.hid) {
          // 1) 拦截 requestDevice：站点真正连接的设备（选中的即 SKN 设备）
          try {
            var origRequest = navigator.hid.requestDevice.bind(navigator.hid);
            navigator.hid.requestDevice = function(opts){
              return origRequest(opts).then(function(devs){
                var dev = devs && devs[0];
                if (dev && dev.vendorId === 0x3434) {
                  report({ connected: true, names: [dev.productName || dev.name || ''] });
                } else if (dev) {
                  report({ connected: false, names: [] });
                }
                return devs;
              }).catch(function(){ report({ connected: false, names: [] }); throw arguments[0]; });
            };
          } catch(e){}
          // 2) 拦截设备关闭：关闭后重新统计仍打开的 SKN 设备
          try {
            var origClose = HIDDevice.prototype.close;
            HIDDevice.prototype.close = function(){
              var self = this;
              return Promise.resolve(origClose.apply(self, arguments)).then(function(r){
                try {
                  navigator.hid.getDevices().then(function(devs){ reportSkn(devs); }).catch(function(){ report({ connected: false, names: [] }); });
                } catch(err){ report({ connected: false, names: [] }); }
                return r;
              });
            };
          } catch(e){}
          // 3) 兜底轮询：自动重连等场景下统计已打开的 SKN 设备
          try { navigator.hid.getDevices().then(reportSkn).catch(function(){}); } catch(e){}
          setInterval(function(){
            try { navigator.hid.getDevices().then(reportSkn).catch(function(){}); } catch(e){}
          }, 1500);
        }
      } catch(e){}
    })();
  `;
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow.webContents.getURL().startsWith(LAUNCHER_URL)) {
      mainWindow.webContents.executeJavaScript(injectDriverUI, true).catch(() => {});
      refreshDeviceStatus();
      // 开发自检：--shot <输出路径> 截取渲染后的驱动页面
      if (process.argv.includes('--shot')) {
        setTimeout(() => {
          try {
            const idx = process.argv.indexOf('--shot');
            const out = process.argv[idx + 1] || path.join(process.cwd(), 'shot.png');
            mainWindow.webContents.capturePage().then((img) => {
              const fs = require('fs');
              fs.writeFileSync(out, img.toPNG());
              console.log('SHOT_OK ' + out);
              app.exit(0);
            }).catch((e) => { console.error('SHOT_ERR ' + e.message); app.exit(1); });
          } catch (e) { console.error('SHOT_ERR ' + e.message); app.exit(1); }
        }, 9000);
      }
    }
  });

  // 离线兜底
  mainWindow.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame && !validatedURL.startsWith('file:')) {
      mainWindow.loadFile(path.join(__dirname, 'offline.html'));
    }
  });

  // 重新加载后恢复状态
  mainWindow.on('closed', () => { mainWindow = null; });

  // 先显示品牌启动页，再加载官方驱动页面
  mainWindow.loadFile(path.join(__dirname, 'splash.html')).then(() => {
    mainWindow.loadURL(LAUNCHER_URL);
  });
}

/* ---------------- WebHID 权限与设备选择 ---------------- */
function setupHidPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === 'hid') return true;
    return false;
  });
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'hid') return callback(true);
    return callback(false);
  });
  // 自动授予 HID 设备权限（配合 select-hid-device 完成一键连接）
  ses.setDevicePermissionHandler((details) => {
    return details.deviceType === 'hid';
  });
}

function pickHidDevice(list) {
  if (!list || !list.length) return null;
  // 只自动选择 SKN（VID 0x3434）设备；其它厂商设备（如鼠标 8K 接收器）不自动连接
  return list.find(d => d.vendorId === SKN_VENDOR_ID) || null;
}

app.on('select-hid-device', (event, details, callback) => {
  const dev = pickHidDevice(details.deviceList);
  if (!dev) {
    // 无 SKN 设备时交给系统默认选择器（避免误连鼠标接收器等非键盘设备，也覆盖极少数非 0x3434 型号）
    console.warn('[SKN] select-hid-device: 未发现 SKN(0x3434) 设备, 交给系统选择器');
    return;
  }
  event.preventDefault();
  console.log('[SKN] select-hid-device 自动选择:', dev.name, 'deviceId=' + dev.deviceId, 'vid=0x' + dev.vendorId.toString(16), 'pid=0x' + dev.productId.toString(16));
  // Electron >= 27 的 callback 签名是 callback(deviceId: string)，低于 27 是 callback(device)
  const major = Number(process.versions.electron.split('.')[0] || 0);
  if (major >= 27) {
    callback(dev.deviceId);
  } else {
    callback(dev);
  }
});

/* ---------------- IPC ---------------- */
ipcMain.handle('driver:getStatus', () => currentStatus);
ipcMain.handle('driver:reload', () => { if (mainWindow) mainWindow.webContents.reloadIgnoringCache(); return true; });
// 打开 SKN 官方站点（系统默认浏览器）
ipcMain.handle('driver:openOfficialSite', () => {
  shell.openExternal(OFFICIAL_URL);
  return true;
});
// 自定义标题栏窗口控制
ipcMain.on('driver:windowControl', (_e, action) => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  if (action === 'minimize') {
    w.minimize();
  } else if (action === 'maximize') {
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  } else if (action === 'close') {
    w.close();
  }
});
// 网页内 WebHID 状态上报（键盘真实连接状态）
ipcMain.on('driver:hidState', (_e, st) => {
  if (!st || typeof st.connected !== 'boolean') return;
  const changed = (hidState && hidState.connected) !== st.connected;
  hidState = { connected: st.connected, names: Array.isArray(st.names) ? st.names : [] };
  if (changed) {
    applyStatusToUI();
  } else {
    currentStatus = computeStatus();
  }
});

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    app.setName('SKN 键盘驱动');
    app.setAboutPanelOptions({
      applicationName: 'SKN 键盘驱动',
      applicationVersion: app.getVersion(),
      copyright: '基于官方 SKN Launcher 引擎',
      credits: 'WebHID 直连键盘 · 离线设备检测'
    });

    // 移除系统菜单栏（文件/视图/帮助等全部隐藏）
    Menu.setApplicationMenu(null);

    setupHidPermissions();
    createWindow();

    // 启动即刷新一次状态，随后轮询
    refreshDeviceStatus();
    pollTimer = setInterval(() => refreshDeviceStatus(), POLL_MS);

    if (process.argv.includes('--smoke-test')) {
      runSmokeTest();
    }
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}

/* ---------------- 冒烟自检（打包后验证用） ---------------- */
function runSmokeTest() {
  const timeout = setTimeout(() => {
    console.error('SMOKE_TIMEOUT', 'url=' + (mainWindow ? mainWindow.webContents.getURL() : 'none'));
    app.exit(2);
  }, 90000);
  let checks = 0;
  const done = () => {
    checks += 1;
    if (checks >= 2) {
      clearTimeout(timeout);
      console.log('SMOKE_OK', JSON.stringify({ status: currentStatus, url: mainWindow ? mainWindow.webContents.getURL() : null }));
      app.exit(0);
    }
  };
  const wc = mainWindow.webContents;
  wc.on('did-start-loading', () => console.log('SMOKE_EVENT did-start-loading'));
  wc.on('dom-ready', () => console.log('SMOKE_EVENT dom-ready', wc.getURL()));
  wc.on('did-finish-load', () => {
    if (wc.getURL().startsWith(LAUNCHER_URL)) {
      console.log('SMOKE_LOADED', wc.getURL());
      done();
    }
  });
  wc.on('did-fail-load', (e, code, desc, url, isMain) => { console.error('SMOKE_EVENT did-fail-load', code, desc, url, isMain); });
  wc.on('render-process-gone', (e, d) => console.error('SMOKE_EVENT render-process-gone', JSON.stringify(d)));
  wc.on('console-message', (e, level, message, line, sourceId) => { if (level >= 2) console.log('SMOKE_PAGE_LOG', message); });
  refreshDeviceStatus().then(() => done());
}
