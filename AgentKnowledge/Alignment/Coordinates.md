# 坐标与边界

元素的位置尺寸使用画板世界坐标；x 向右，y 向下，可为负，宽高必须为正。`x/y` 是矩形左上角。不要把截图上的屏幕像素直接写进 config。

```text
left = x                         right = x + width
top = y                          bottom = y + height
centerX = x + width / 2           centerY = y + height / 2
screenX = worldX * viewport.zoom + viewport.x
screenY = worldY * viewport.zoom + viewport.y
worldX = (screenX - viewport.x) / viewport.zoom
worldY = (screenY - viewport.y) / viewport.zoom
```

上述 screen 坐标相对画布左上角，不包含工具栏与窗口偏移。布局计算与缩放无关。viewport 改变只改变观看方式。

多个元素的联合边界：L=min(left)，T=min(top)，R=max(right)，B=max(bottom)。联合宽高为 R−L、B−T，中心为 `(L+R)/2, (T+B)/2`。

图片与文本按矩形计算。连线的矩形是包含完整路径与描边留白的外接框；绑定连线的位置由目标决定，优先移动目标，而不是强行对齐连线外接框。
