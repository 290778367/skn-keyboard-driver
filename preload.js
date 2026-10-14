/**
 * 预加载脚本：向渲染进程暴露驱动状态与窗口控制接口（contextBridge 隔离）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sknDriver', {
  /** 获取当前键盘连接状态 */
  getDeviceStatus: () => ipcRenderer.invoke('driver:getStatus'),
  /** 订阅键盘连接状态变化，返回取消订阅函数 */
  onDeviceStatus: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on('driver:status', handler);
    return () => ipcRenderer.removeListener('driver:status', handler);
  },
  /** 重新加载驱动页面 */
  reload: () => ipcRenderer.invoke('driver:reload'),
  /** 网页内注入脚本上报 WebHID 真实连接状态 */
  __reportHidState: (state) => ipcRenderer.send('driver:hidState', state),
  /** 打开 SKN 官方站点（系统默认浏览器） */
  openOfficialSite: () => ipcRenderer.invoke('driver:openOfficialSite'),
  /** 自定义标题栏窗口控制：minimize / maximize / close */
  windowControl: (action) => ipcRenderer.send('driver:windowControl', action),
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximized: (cb) => {
    const handler = (_event, isMax) => cb(isMax);
    ipcRenderer.on('driver:maximized', handler);
    return () => ipcRenderer.removeListener('driver:maximized', handler);
  }
});
