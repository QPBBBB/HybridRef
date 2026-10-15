# HybridRef 开发说明

使用方式、快捷键和项目格式见[仓库 README](../../README.md)。当前应用为 React/TypeScript 浏览器前端与本地 Node.js HTTP 服务。

## 目录与依赖

| 目录 | 用途 |
| --- | --- |
| `Source/Renderer/` | 画布交互、几何计算、文件窗口和浏览器接口 |
| `Source/Server/` | HTTP 服务、图片缓存、导入与项目存储 |
| `Source/Shared/` | 文档、图片、文本资源和接口类型 |
| `Scripts/` | 启动、构建、命名检查和示例生成脚本 |
| `E2E/` | 浏览器集成测试 |
| `Output/` | Web 与服务端构建产物 |
| `Runtime/` | 本机运行状态、日志及测试产物，不进入 Git |
| `../Resource/` | 当前界面图标（`Icons/`）与 Demo 生成素材（`Demo/`） |
| `../../Dependencies/` | Windows x64 本地 Node.js、pnpm 与完整开发依赖 |
| `reference/` | 归档的 Citadel 与 Electron 实现，不参与当前构建或测试 |

运行时依赖 React、sharp、yaml、bmp-js、Marked 和 DOMPurify；构建使用 Vite、esbuild，测试使用 Vitest 和 Playwright。`Dependencies/Node` 固定 Node.js 24.19.0，`Dependencies/Pnpm` 固定 pnpm 11.25.0，版本和来源记录在 `Dependencies/Environment.json`。所需依赖以无内部目录链接的布局安装在 `Dependencies/Packages/node_modules`；本目录的 `node_modules` 只是自动维护的入口链接。

前端通过 Vite 内置 esbuild 使用自动 JSX 转换，移除 `@vitejs/plugin-react` 及其 Babel 依赖；Demo 生成器复用 esbuild，移除 `tsx`。pnpm 设置 `autoInstallPeers: false`，避免安装当前 Vitest 测试未使用的 jsdom 等 peer 依赖。图像服务与系统 Edge 浏览器测试完整保留。

## 开发与验证

完整安装后的文件夹可离线运行、开发、构建和测试，无需系统 Node.js 或 pnpm。新增第三方包或缺文件后重装可能需要联网。以下命令均在仓库根目录执行：

```powershell
.\Dependencies\Setup.cmd    # 缺少依赖或清单改变时执行，可能需要联网
.\Dependencies\Pnpm.cmd dev
```

`Dependencies/Pnpm.cmd dev` 强制构建后打开浏览器；`Dependencies/Pnpm.cmd start` 仅在产物缺失或源码过期时构建。两者均通过 `Scripts/Launch.cjs` 启动本地服务，可复用同一构建版本的服务。普通运行不安装依赖；源清单与锁文件保留在 `Code/Module`，依赖安装统一交给 `Dependencies/Setup.cmd`。

| 命令 | 用途 |
| --- | --- |
| `Dependencies/Pnpm.cmd typecheck` | PascalCase 命名检查与 TypeScript 检查 |
| `Dependencies/Pnpm.cmd test:run` | 运行单元测试和 HTTP 集成测试 |
| `Dependencies/Pnpm.cmd build` | 构建 `Output/Web/` 和 `Output/Server/` |
| `Dependencies/Pnpm.cmd e2e` | 先构建，再运行 Playwright 浏览器测试 |
| `Dependencies/Pnpm.cmd exec playwright test` | 使用现有构建运行浏览器测试 |

浏览器测试使用已安装的 Microsoft Edge（`msedge`），项目与图片放在临时目录，不依赖或修改仓库中的 Demo。开发调试也应使用独立项目，保留用户正在编辑的画板。

选区快照复用浏览器排版与原生 Canvas PNG 无损编码，不使用额外的截图库；画布文字与导出共享 `TextAppearance.ts`、`MarkdownContent.ts` 和 `Markdown.css`。快照测试通过真实 Ctrl+C 事件生成 `ClipboardItem` 和 PNG，捕获写入参数以免覆盖用户系统剪贴板，并检查像素、底色、尺寸、排版和粘贴。导出最长边限制 16384 像素，总面积限制 6400 万像素；超过限制会提示分批复制。

Markdown 使用固定版本 Marked 18.1.1（GFM + breaks）解析，DOMPurify 3.4.17 清理 HTML；两者及类型文件约 2 MB，随离线环境保存。源码沿用文本 YAML 的 `content`，不新增项目格式或编辑器框架。`Shared/Markdown.ts` 还负责识别本地图片引用，防止保存和清理误删仅被 Markdown 使用的纹理。源码编辑沿用原位 textarea，保留输入法、原生文字复制和撤销。

`/api/markdown-image` 是按标签页与当前项目隔离的只读接口，支持项目目录内图片、公网 HTTP/HTTPS 和内嵌图片。相对文件不得越出项目目录或经过符号链接；公网下载逐次验证重定向和 DNS，禁止本机与内网地址。图片限制为 20 MB / 6400 万像素，统一转换为 PNG，缓存于当前页面并用于画布和快照。远程图片加载不阻塞保存；不持久化远程缓存，不支持 SVG。Markdown 浏览器测试覆盖 GFM、中文编辑与保存、图片、HTML 清理、链接操作，以及画布和 PNG 的像素对照。

Playwright 报告放在 `Runtime/PlaywrightReport/`，失败附件放在 `Runtime/TestResults/`；仅失败时保留截图和 trace。启动日志见 `Runtime/Logs/Launcher.log`、`Runtime/Logs/Server.log`，依赖安装日志为 `Runtime/Logs/Install.log`。根目录 `Start.cmd -Check` 仅检查并按需构建，不打开浏览器。

`Dependencies/Pnpm.cmd demo` 仅用于从捆绑素材创建缺失的 `Project/Demo/Demo.hbr`，已有该文件时会拒绝覆盖；它不是启动步骤。此命令复用 esbuild 在 `Runtime/` 编译生成器并通过本地 Node 执行，无需额外的 TypeScript 运行器。

项目自有文件、函数、变量及本地导入名称使用 PascalCase。`Code/Resource/` 下所有子目录和文件主体名称也必须使用 PascalCase，由 `check:naming` 递归检查。资源目录仅保留当前应用或开发脚本实际使用的素材；旧版应用图标、音效、捆绑字体和 Whisper 引擎已移除。工具要求的配置文件名、外部 API、YAML/HTTP 字段和自动生成的项目资源名保留其格式。

箭头使用原生 SVG，不新增依赖。`Shared/Arrows.ts` 共享折线路径、四向 handle、端点连接和箭头形状，画布与 PNG 导出使用相同计算。选中图片/文本后显示屏幕尺寸固定的外侧连接 handle；拖拽创建和端点重连均显示目标 handle，并用屏幕距离吸附到边的中点（offset 0.5），高亮当前目标。绑定保留旧有边缘 offset，路径按端口方向转折，包围框包含完整折线。箭头属于可选中对象，路径坐标相对其包围框保存，端点可引用图片/文本 ID 与边缘位置；移动目标时重算路径，组缩放后重新计算描边边距。第 4 版 `.hbr` 内联保存 `arrows`，没有箭头时仍写第 3 版。齿轮素材来自用户提供的 PNG，沿用 CSS alpha 蒙版显示白色，创建入口使用项目内 SVG。专项测试覆盖四向拖出、跨方向连接、缩放下吸附、取消、绑定、撤销、复制后的 ID 重映射、格式校验、保存重开及不透明 PNG 的虚线像素。

## 来源与许可

归档的 [Citadel](https://github.com/kannibalk1w1/Citadel) 来源版本为 `0.4.0`，提交 `be207e612a7e07ae78d26635e94d0e67169c8c6e`。相关材料保留在 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses/](licenses/)。
