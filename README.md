# HybridRef

一个直接在浏览器中编辑的图片参考画布，React Web UI，黑色主题。没有 Electron 桌面窗口；本地 Node.js 服务负责读写 `.hbr` 和图片资源。

## 启动

双击根目录 **Start.cmd**，启动器会启动本地服务并打开系统默认浏览器。Edge、Chrome 和 Firefox 会打开一个普通浏览器窗口。本机依赖已经准备好；源代码改变后启动器会自动构建。

页面地址为 `http://127.0.0.1:<本地端口>/`，仅在本机监听。再次启动会复用当前版本的服务。推荐使用 Chrome 或 Edge。

```powershell
# 打开新的纯图片演示画板
.\Start.cmd -Demo

# 打开自己的画板，也可以把 .hbr 拖到启动器上
.\Start.cmd 'D:\参考\TestRef.hbr'
```

## 这一版包含什么

- 单个无限画布，拖入图片、文件选择导入、粘贴系统截图。
- 框选、Shift 多选，整体移动，边缘/中心吸附和辅助线；Alt 临时关闭吸附。
- 左、中、右、上、中、下对齐；选框四角等比缩放单图或整组。
- 中键或空格拖动平移，滚轮围绕鼠标缩放，F 适应全部图片。
- 复制、剪切、粘贴、删除、撤销和重做。
- 黑色界面，没有文字项、侧栏、多画板、音视频、录制或欢迎弹窗。
- 导入使用浏览器文件选择框；打开/另存为通过网页中的文件窗口选择本地目录和文件名。每个浏览器标签页的图片缓存相互独立。

| 操作 | 快捷键 |
| --- | --- |
| 打开 / 保存 / 另存为 | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| 全选 / 复制 / 剪切 / 粘贴 | Ctrl+A / C / X / V |
| 直接创建所选图片的副本 | Ctrl+D |
| 删除 | Delete / Backspace |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z 或 Ctrl+Y |
| 适应画布 | F |
| 平移 | 中键拖动，或按住空格拖动 |
| 画布缩放 | 鼠标滚轮 |

## 文件和内存

`D:\参考\TestRef.hbr` 保存为可直接 diff 的 YAML；图片保存在同目录 `TestRefResource\<内容哈希>.png`。文件和资源目录一起移动即可。

所有导入图片统一转为原分辨率的无损压缩 PNG；动画图片只取第一帧。相同图片共用资源。图片内容和解码结果缓存在内存，保存时无需重新读取外部原图。布局存储稳定 ID、相对资源路径和几何数值，不写时间戳；相同状态重复保存保持相同文本。

保存先写资源，再原子替换 YAML；不会自动删除未引用图片，避免误删。只有成功保存才解除未保存标记。第一版缓存常驻内存；新建、打开另一画板会替换当前标签页的缓存，退出本地服务会释放全部缓存。

关闭或刷新有未保存修改的标签页时，浏览器会提醒。先保存，再关闭。服务和文件都留在本机，不需要上传到网站或登录账户。

新版文档 `formatVersion: 2` 只包含 `viewport` 和 `images`。旧版多画板文件不会被简版读写或覆盖，原 `Project/Demo/Demo.hbr` 保留。新演示文件为 `Project/Demo/SimpleDemo.hbr`。

## 开发

项目自有文件、函数和变量统一使用 PascalCase 命名。第三方 API、工具要求的配置文件名、已有 `.hbr` 存储字段及归档的上游代码保持兼容。

根目录只保留 `Code`、`Project`、`.gitignore`、`.gitattributes`、本说明和 `Start.cmd`（另有隐藏的 `.git` 仓库元数据）。启动实现、运行缓存和开发规范均在 `Code` 内；项目许可证见 [Code/LICENSE](Code/LICENSE)。

```text
Code/Module/Source/Server/     本地 HTTP 服务、图片导入与 YAML 存储
Code/Module/Source/Renderer/   图片画布、交互与内存缓存
Code/Module/Source/Shared/     文档和接口类型
Code/Module/Scripts/           启动和构建脚本
Code/Module/Runtime/           本机运行状态、日志与测试截图（不进 Git）
Code/Resource/              图标等资源
Code/Module/reference/     上一版 Citadel 实现，仅供参考
Project/Demo/             演示画板及其资源
```

```powershell
cd Code\Module
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm test:run
pnpm build
pnpm exec playwright test
```

`pnpm start` 构建缺失或过期代码并打开浏览器；`pnpm dev` 强制重新构建后打开。启动日志见 `Code/Module/Runtime/Logs/Launcher.log`，服务日志见 `Code/Module/Runtime/Logs/Server.log`。新环境首次运行需要 Node.js 22+ 与网络安装依赖。Citadel 来源和授权保留在 [Code/UPSTREAM.md](Code/UPSTREAM.md)。
