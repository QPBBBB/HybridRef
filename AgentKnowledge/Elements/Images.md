# 图片

`image create --project <文件> --source <本地图片> [--id <ID>] [--x ... --y ... --width ... --height ...]` 创建图片。也可用 `--input` 读取 [Image.yaml](Examples/Image.yaml)。输入文件里的 source 相对该输入文件，命令行 source 相对当前工作目录。

图片经过与应用相同的导入流程，转为压缩 PNG；动画或多页内容只取第一帧/页。保留图片内容分辨率，画布 `width/height` 单独控制显示大小。

- 创建默认左上角 `(0,0)`，默认显示尺寸等于导入尺寸。
- 创建只给宽或高时，另一维保持原图比例；同时给宽高时使用指定比例。
- `image update --project <文件> --id <ID> --source <新图片>` 替换内容，保留 ID 和当前布局。
- 修改已有图片的某一个尺寸时，只更改该字段；等比缩放由 agent 按 [尺寸计算](../Alignment/Sizing.md) 同时给出宽高。
- `element update` 或 `image update` 都可以改位置与尺寸。

更新图片会产生正确哈希的新 PNG/config 配对；共享旧 PNG 的其他实例继续保留旧内容。示例 [Walkthrough.ps1](Examples/Walkthrough.ps1) 使用两张本地 SVG 图形验证 PNG 导入与替换，运行不需要联网。

PNG 没有 YAML 内容文件，布局 YAML 见 [资源结构](ResourceFormat.md)。当前图片元素无额外可调颜色、透明度、裁剪等样式字段，未知参数会报错。
