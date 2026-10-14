# SKN 键盘驱动（桌面版 · 非官方）

把 SKN 官方网页驱动（<https://launcher.skn.net.cn/>）包成 Windows 桌面程序的外壳：**键位重映射、宏、灯效、固件升级等功能全部由官方网页引擎完成**，本项目只负责窗口、设备权限与连接状态显示，不重新实现任何键盘协议。

> **非官方项目**：与 SKN / Keychron 官方没有任何关系，只是调用其公开的网页驱动。写入键盘的操作由官方引擎执行，请自行评估风险。
>
> An unofficial Electron shell around the official SKN keyboard web driver. Key mapping, macros, lighting and firmware updates are performed by the vendor's own web app talking to the keyboard over WebHID; this project only provides the window, the device permissions and the status display. MIT licensed, not affiliated with SKN or Keychron.

## 下载

Releases 里有两个文件（**文件名是 ASCII**——GitHub 的 Release 资产名会把非 ASCII 字符直接删掉，见文末「关于文件名」）：

| 文件 | 说明 |
| --- | --- |
| `SKN-Driver-Setup-<版本>.exe` | 安装向导版：可自选安装目录，创建桌面与开始菜单快捷方式，带卸载项 |
| `SKN-Driver-Portable-<版本>.exe` | 免安装版：双击即用，数据写在 exe 旁边的 `data` 文件夹 |

**这两个文件都没有代码签名**（本项目不申请代码签名）。所以浏览器下载后首次运行会看到「Windows 已保护你的电脑」：点 **更多信息 → 仍要运行** 即可。用 U 盘或局域网共享拷贝则不会出现提示。如果系统开启了「智能应用控制」的强制模式，未签名程序会被直接拦下、没有「仍要运行」按钮——那一条只能靠代码签名解决。

## 功能

- **键位重映射 / 宏 / 灯效 / 固件升级**：直接加载官方 SKN Launcher 网页驱动，功能与网页版一致
- **一键连接**：键盘通过 USB 线或 2.4G 接收器连接后，点击页面内 “Connect” 自动选中 SKN 设备（VID `0x3434`），无需在系统弹窗里翻找
- **设备状态实时检测（双通道）**：以网页内 WebHID 的真实连接状态为准，辅以 Windows PnP 硬件检测，窗口标题实时显示「已连接 / 已检测到 / 未检测到」
- **品牌启动页**：启动时显示 SKN 品牌加载页，加载完成自动进入驱动界面
- **无边框深色窗口**：自定义深色标题栏，可拖拽移动，右上角提供最小化/最大化/关闭按钮
- **无菜单栏**：移除系统菜单栏，界面更简洁
- **左侧栏「官网」入口**：驱动页面左侧栏新增「官网」，一键打开 SKN 官方站点
- **数据本地化**：应用数据（配对信息、网页缓存等）保存在程序目录旁的 `data` 文件夹，删除该文件夹即可完全重置（详见「数据写在哪里」）
- **关闭即退出**：关闭窗口后程序完全退出，不驻留后台、无托盘图标
- **离线兜底**：网络不可用时显示离线页，仍可查看键盘连接状态

## 使用步骤

1. 用 USB 线（或 2.4G 接收器）把 SKN 键盘接到电脑
2. 启动驱动，等待官方页面加载完成（需要联网加载官方驱动引擎）
3. 点页面左上角 **Connect**，程序会自动匹配并连接键盘
4. 连接成功后即可修改键位、灯效、宏等，配置会写入键盘

## 数据写在哪里

| 构建 | 数据目录 |
| --- | --- |
| 便携版 | exe 旁边的 `data` 文件夹（放 U 盘也能用） |
| 安装版 | **安装目录**下的 `data` 文件夹；如果安装目录不可写（例如装进 `Program Files`），回退到系统默认的用户数据目录（`%APPDATA%` 下） |

另外，安装向导本身还会写：默认安装位置 `%LOCALAPPDATA%\Programs\SKN键盘驱动`（**在 C 盘，可在向导里改成别的盘**）、开始菜单与桌面快捷方式、以及卸载信息（注册表 `HKCU`）。便携版除 `data` 外不写这些。

本程序不收集、不上传任何数据。

## 从源码构建

```powershell
npm ci            # 或 npm install
npm start         # 开发运行
npm run smoke     # 冒烟自检：启动、加载官方页面、退出（需要联网）
npm run dist      # 打包：安装版 + 便携版，产物在 dist\
```

- 技术栈：Electron 33 + electron-builder 26，设备检测走 Windows PnP 查询（`VID_3434`），无原生依赖
- 首次打包会下载 Electron 二进制与 NSIS 工具链（约 200 MB），缓存在 `%LOCALAPPDATA%\electron-builder\Cache`
- CI（[`.github/workflows/build.yml`](.github/workflows/build.yml)）在 `windows-latest` 上做同样的事：`npm ci` → 语法检查 → 打包 → 归档产物；打 `v*` 标签时自动创建 Release 并上传两个安装包
- **构建不做任何签名**：workflow 里显式设了 `CSC_IDENTITY_AUTO_DISCOVERY=false`，不会去找证书

## 支持的设备

- SKN 青龙 4.0 等 SKN 系列键盘（USB VID `0x3434`，与 Keychron 共用厂商 ID）
- 连接方式：有线 / 2.4G

## 常见问题

- **页面一直停留在「未连接」**：确认键盘已用 USB 线连接（部分型号仅支持有线模式）
- **键盘已连接但窗口标题仍显示「未连接」**：状态以 WebHID 真实连接为准，点一下 Connect 再看；若仍未变化，确认键盘是不是 SKN 系列（VID `0x3434`）
- **提示无法连接服务器**：驱动功能需要联网加载官方引擎，检查网络后点「重新加载驱动」
- **连接时没有弹出设备选择器**：程序已自动匹配 SKN 设备，直接点 Connect 即可（非 `0x3434` 的设备会交给系统选择器，避免误连鼠标接收器）
- **首次运行被 SmartScreen 拦下**：这个构建没有代码签名，点「更多信息 → 仍要运行」，或改用 U 盘/共享拷贝的方式
- **想彻底重置**：关掉程序，删除 `data` 文件夹

## 关于文件名

GitHub 的 Release 资产名不接受非 ASCII 字符：服务端会把它们从名字里删掉。实测 `SKN键盘驱动-安装版-1.0.6.exe` 会变成 `SKN-1.0.6.exe`，而便携版会变成同一个名字——两个产物直接撞名。所以发布用的文件名统一用 ASCII（`SKN-Driver-Setup-*` / `SKN-Driver-Portable-*`），**程序本身的名字（安装后的 `SKN键盘驱动.exe`、窗口标题、快捷方式）仍然是中文**，由 `build/release-assets.mjs` 在发布前改名。

## 许可证

MIT，见 [LICENSE](LICENSE)。第三方组件：Electron 及其依赖遵循各自的许可证；官方网页中的字体、图标等版权归各自所有者。