# HybridRef 开发说明

使用方式、快捷键和项目格式见[仓库 README](../../README.md)。当前应用为 React/TypeScript 浏览器前端与本地 Node.js HTTP 服务。

## 目录与依赖

| 目录 | 用途 |
| --- | --- |
| `Source/Renderer/` | 画布交互、几何计算、文件窗口和浏览器接口 |
| `Source/Server/` | HTTP 服务、图片缓存、导入与项目存储 |
| `Source/Shared/` | 文档、图片和接口类型 |
| `Scripts/` | 启动、构建、命名检查和示例生成脚本 |
| `E2E/` | 浏览器集成测试 |
| `Output/` | Web 与服务端构建产物 |
| `Runtime/` | 本机运行状态、日志及测试产物，不进入 Git |
| `../Resource/` | 捆绑图标、字体等素材 |
| `reference/` | 归档的 Citadel 与 Electron 实现，不参与当前构建或测试 |

运行时依赖 React、sharp、yaml 和 bmp-js；构建使用 Vite、esbuild，测试使用 Vitest 和 Playwright。Node.js 需要 22+，pnpm 版本由 [package.json](package.json) 的 `packageManager` 固定。

## 开发与验证

以下命令均在 `Code/Module/` 中执行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 强制构建后打开浏览器；`pnpm start` 仅在产物缺失或源码过期时构建。两者均通过 `Scripts/Launch.cjs` 启动本地服务，可复用同一构建版本的服务。

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | PascalCase 命名检查与 TypeScript 检查 |
| `pnpm test:run` | 运行单元测试和 HTTP 集成测试 |
| `pnpm build` | 构建 `Output/Web/` 和 `Output/Server/` |
| `pnpm e2e` | 先构建，再运行 Playwright 浏览器测试 |
| `pnpm exec playwright test` | 使用现有构建运行浏览器测试 |

浏览器测试使用已安装的 Microsoft Edge（`msedge`），项目与图片放在临时目录，不依赖或修改仓库中的 Demo。开发调试也应使用独立项目，保留用户正在编辑的画板。

Playwright 报告放在 `Runtime/PlaywrightReport/`，失败附件放在 `Runtime/TestResults/`；仅失败时保留截图和 trace。启动日志见 `Runtime/Logs/Launcher.log`、`Runtime/Logs/Server.log`，依赖安装日志为 `Runtime/Logs/Install.log`。根目录 `Start.cmd -Check` 仅检查并按需构建，不打开浏览器。

`pnpm demo` 仅用于从捆绑素材创建缺失的 `Project/Demo/Demo.hbr`，已有该文件时会拒绝覆盖；它不是启动步骤。

项目自有文件、函数、变量及本地导入名称使用 PascalCase。工具要求的配置文件名、外部 API、YAML/HTTP 字段和自动生成的资源名保留其格式。

## 来源与许可

归档的 [Citadel](https://github.com/kannibalk1w1/Citadel) 来源版本为 `0.4.0`，提交 `be207e612a7e07ae78d26635e94d0e67169c8c6e`。相关材料保留在 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [licenses/](licenses/)。
