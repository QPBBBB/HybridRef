# 连线

`line create/update --project <文件> --input <JSON/YAML>` 提供世界坐标端点或对象绑定，工具计算相对坐标和外接框。可运行输入见 [Line.yaml](Examples/Line.yaml)、[LineUpdate.yaml](Examples/LineUpdate.yaml)、[FreeLine.json](Examples/FreeLine.json)。

| CLI 输入字段 | 含义 |
| --- | --- |
| `id` | 创建可省略，修改必填 |
| `start/end: {x,y}` | 世界坐标，非 0–1；创建两端都需要坐标或绑定 |
| `startBinding/endBinding` | `{id, side, offset}`，目标是本项目可用图片/文本 |
| `side` | left / right / top / bottom |
| `offset` | 0–1，默认 0.5；上下边从左到右，左右边从上到下 |
| `axis` | horizontal / vertical，第一主方向；默认结合绑定或端点决定 |
| `bend` | 世界坐标中的折线位置；水平轴为 x，竖直轴为 y；设置后自动开启 manualBend |
| `manualBend` | true 保留手动折线；false 恢复自动路径，不与显式 bend 同时使用 |
| `color` | `#RRGGBB`，默认白色 |
| `thickness` | 1–24，默认 2 |
| `dashed` | 布尔值，默认 false |

局部修改省略的绑定保留；用 `startBinding: null` 或 `endBinding: null` 明确解除。相同端点不能同时传世界坐标和绑定，修改一个绑定端点为自由坐标时必须一起传 null。

自动路径优先在端口方向允许时使用两段 L 形；对齐时为直线，方向不允许则绕行。手动 bend 保留原有绕行规则。绑定端点刷新后随目标位置和尺寸变化；CLI 读取的是文件中保存的布局，浏览器重新解析绑定后的外接框可能不同。需要即时计算绑定位置时按下方公式计算。

绑定连线不能直接修改外接框位置与尺寸；移动目标，或先解除两端绑定。自由连线可通过 `element update` 调整 `x/y/width/height`，工具按新框缩放端点，再重算描边留白，结果框可能略有差异。以返回的 element 为准。一次调用不要同时给外接框与 start/end/bend。

## 磁盘结构

Line YAML 的 `arrow.start/end` 和 `bend` 是相对外接框的 0–1 值，**不同于 CLI 的世界坐标参数**。例如：

```yaml
format: hybridref-line
formatVersion: 1
arrow:
  start: { x: 0.05, y: 0.05 }
  end: { x: 0.95, y: 0.95 }
  axis: vertical
  bend: 0.95
  manualBend: false
  color: '#FFFFFF'
  thickness: 2
  dashed: false
```

配置使用 `hybridref-line-layout`，存储外接框。世界端点为 `frame.x + start.x * frame.width`、`frame.y + start.y * frame.height`。水平 bend 为 `frame.x + bend * frame.width`，竖直 bend 为 `frame.y + bend * frame.height`。

绑定写在 `arrow.startBinding/endBinding` 中，用与 CLI 相同的对象结构；解除时从磁盘 YAML 移除字段，不写 null。上/下端口为 `(target.x + target.width * offset, target.y 或 target.y + target.height)`；左/右端口为 `(target.x 或 target.x + target.width, target.y + target.height * offset)`。

直接编辑连线内容也需要更新哈希和配置文件名；建议用 CLI 负责折线和外接框计算。UI 外侧连接圆点与箭头编辑控件属于编辑界面，不写入资源。
