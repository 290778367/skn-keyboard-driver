/**
 * 把 electron-builder 的产物整理成 Release 资产：ASCII 文件名 + 校验值 + 说明。
 *
 * 为什么必须换成 ASCII 名：GitHub 的 Release 资产名不接受非 ASCII 字符——服务端会把它们
 * 从名字里直接删掉。实测：
 *   SKN键盘驱动-安装版-1.0.6.exe  ->  SKN-1.0.6.exe
 *   SKN键盘驱动-便携版-1.0.6.exe  ->  SKN-1.0.6.exe   （两个产物撞成同一个名字）
 *   SKN-中文-mixed-1.0.0.exe      ->  SKN-.-mixed-1.0.0.exe
 * 所以这里显式映射成 SKN-Driver-Setup / SKN-Driver-Portable；程序安装后的名字
 * （SKN键盘驱动.exe）和 exe 属性里的产品名不受影响，只是下载列表里用 ASCII。
 *
 * 用法：node build/release-assets.mjs [--dist <目录>] [--out-dir <目录>]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const distDir = path.resolve(root, option('--dist') || path.join(root, 'dist'));
const outDir = path.resolve(option('--out-dir') || path.join(root, 'release'));
const { version, productName } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(distDir)) {
  console.error(`[整理] 找不到构建产物目录：${distDir}（先跑 npm run dist）`);
  process.exit(1);
}
const built = fs.readdirSync(distDir).filter((file) => file.toLowerCase().endsWith('.exe'));
if (built.length === 0) {
  console.error(`[整理] ${distDir} 里没有 .exe，构建可能失败了。`);
  process.exit(1);
}

/** 本地产物名 → Release 资产名（ASCII，且安装版/便携版不会撞名） */
function assetName(file) {
  if (file.includes('便携')) return `SKN-Driver-Portable-${version}.exe`;
  if (file.includes('安装')) return `SKN-Driver-Setup-${version}.exe`;
  const cleaned = file.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned.startsWith('SKN') ? cleaned : `SKN-Driver-${cleaned}`;
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const assets = [];
for (const file of built.sort()) {
  const from = path.join(distDir, file);
  const name = assetName(file);
  const target = path.join(outDir, name);
  fs.copyFileSync(from, target);
  const size = fs.statSync(target).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').toUpperCase();
  assets.push({ name, size, sha256, local: file });
  console.log(`[整理] ${file}  ->  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

const displayName = productName || 'SKN 键盘驱动';
const lines = [
  `## ${displayName} ${version}（Windows · 未签名 / unsigned）`,
  '',
];
for (const asset of assets) {
  const kind = asset.name.includes('Portable') ? '免安装版（双击即用，数据写在 exe 旁的 `data`）' : '安装向导版（可自选安装目录、创建快捷方式、带卸载项）';
  lines.push(`- **${asset.name}** —— ${kind}`);
  lines.push(`  - 大小 ${(asset.size / 1024 / 1024).toFixed(1)} MB（${asset.size.toLocaleString('en-US')} 字节）`);
  lines.push(`  - SHA256 \`${asset.sha256}\``);
}
lines.push(
  '',
  '### 没有代码签名（这个构建是未签名的）',
  '',
  '浏览器下载后首次运行会出现「Windows 已保护你的电脑」：点 **更多信息 → 仍要运行** 即可。',
  '用 U 盘或局域网共享拷贝这个文件则不会出现提示（那种方式不带「来自网络」标记）。',
  '如果系统开启了「智能应用控制」的强制模式，未签名程序会被直接拦下、没有「仍要运行」按钮。',
  '',
  '### 使用',
  '',
  '1. 用 USB 线（或 2.4G 接收器）把 SKN 键盘接到电脑',
  '2. 安装版：运行安装向导选目录；便携版：直接双击（可放 U 盘）',
  '3. 等官方驱动页面加载完成后，点页面左上角 **Connect**，程序会自动匹配 SKN 设备（VID 0x3434）',
  '4. 之后即可改键位、灯效、宏；写入键盘的动作由官方引擎完成',
  '',
  '数据位置：安装版在安装目录的 `data` 文件夹（不可写时回退到 `%APPDATA%`），便携版在 exe 旁的 `data` 文件夹；删掉 `data` 即可完全重置。',
  '',
  '### English',
  '',
  `Unofficial Windows desktop shell for SKN keyboards (Electron). ${assets.length} build(s) attached, all **unsigned**: Windows SmartScreen warns once on first run ("More info" -> "Run anyway") because these binaries are not code signed.`,
  '',
);
for (const asset of assets) lines.push(`- \`${asset.name}\` — ${(asset.size / 1024 / 1024).toFixed(1)} MB, SHA256 \`${asset.sha256}\``);
lines.push(
  '',
  'Key mapping, macros, lighting and firmware updates are performed by the official web driver (launcher.skn.net.cn) inside this shell; this project does not reimplement the keyboard protocol. Not affiliated with SKN or Keychron.',
  '',
);

fs.writeFileSync(path.join(outDir, 'release-notes.md'), `${lines.join('\n')}\n`);
console.log(`[整理] 共 ${assets.length} 个资产，说明文件 ${path.relative(root, path.join(outDir, 'release-notes.md'))}`);