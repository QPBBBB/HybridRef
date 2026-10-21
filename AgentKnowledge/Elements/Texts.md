# 文本

`text create/update --project <文件> --input <JSON/YAML>` 接受外层 `id/x/y/width/height`，以及 `text` 局部字段。创建默认 `(0,0,320,180)`；默认内容“文字”。简单内容可使用 `--content`；多行内容和空字符串请通过输入文件的 content 字段传入，避免 shell 丢失空参数。

CLI 输入示例是 [Text.yaml](Examples/Text.yaml) 与 [TextUpdate.json](Examples/TextUpdate.json)。输入中的 `text` 是内容资源的局部修改；**磁盘 Text YAML 自身没有外层 `text`**，其完整内容如下：

```yaml
format: hybridref-text
formatVersion: 1
content: |-
  # 标题
  支持 **Markdown**。
opacity: 1
font:
  family: SimHei
  size: 24
  weight: 400
  color: '#FFFFFF'
  opacity: 1
background:
  color: '#202020'
  opacity: 1
paragraph:
  align: left
  lineHeight: 1.5
padding: 12
```

| 字段 | 说明 |
| --- | --- |
| `content` | Markdown 源码，支持常用 GFM；不把 HTML 渲染结果写入此字段 |
| `opacity` | 整体不透明度，0–1，应用于文字与背景 |
| `font.family` | 固定 SimHei（黑体），不提供字体切换 |
| `font.size` | 正数字号，世界坐标单位 |
| `font.weight` | 400 或 700 |
| `font.color` / `background.color` | `#RRGGBB` |
| `font.opacity` / `background.opacity` | 兼容旧格式字段，CLI 固定为 1；使用顶层 opacity |
| `paragraph.align` | left / center / right，作用于文字内部，不移动元素 |
| `paragraph.lineHeight` | 正数行高倍数 |
| `padding` | 大于等于 0 的内边距 |

文本框调整不自动缩放字号；高度不足时内容会裁切。布局保存在 `hybridref-text-layout` 配置中。更改正文、颜色、字号等都会改变内容哈希；只改文本框位置或大小不会。具体直接写入流程见 [资源结构](ResourceFormat.md)。
