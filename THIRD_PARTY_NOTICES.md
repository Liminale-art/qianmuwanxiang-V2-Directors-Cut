# Third-Party Notices

千幕万象 V2 随插件分发以下第三方资源。对应许可仅适用于各自的第三方文件，不改变千幕原创代码与素材所采用的 PolyForm Noncommercial License 1.0.0。

## noble-hashes

`@noble/hashes 2.4.0` 的 BLAKE3 ESM 依赖子集，源文件未修改。

- 上游：https://github.com/paulmillr/noble-hashes/tree/663c2aeeffc308ac0cded59bd32f7c212adacfc2
- 许可：MIT，Copyright (c) 2022 Paul Miller。
- 完整许可随包保留于 `vendor/noble-hashes-2.4.0/LICENSE`。
- 固定版本、上游归档完整性及各文件摘要见 `vendor/noble-hashes-2.4.0/VENDOR.json`。
- 这些文件不需要运行时下载或额外安装；上游声明的 Node 环境要求为 `>=20.19.0`。BLAKE3 不在其 2022 年独立审计范围内，不宣称该算法实现已通过独立审计。

## Iconsax

Icons by [Iconsax](https://iconsax.io/). Copyright Iconsax. Free License (proprietary), not MIT.

千幕将选用的免费图形作为功能性界面资源嵌入 `qianmu-icon-renderer.js`，不分发独立 SVG 图标包，不提供再许可或独立图标提取用途。图标著作权属于 Iconsax，不受千幕原创代码的 PolyForm Noncommercial 许可覆盖。

- 官方来源：https://app.iconsax.io/api/mcp （2026-10-01 至 2026-10-02 取得的免费接口子集）
- 接口文档：https://docs.iconsax.io/mcp/ai-integration
- 使用规则：https://docs.iconsax.io/license-and-terms/license
- 完整条款：https://docs.iconsax.io/license-and-terms/usage-manifesto
- 调整：颜色改为随界面继承；Outline 风格使用其对应 Linear 轮廓，以设置 2.5px 描边；Twotone 和指定的 message-notif、record-circle Broken 同样设置 2.5px，Bold 保持原生填充。刷新在 Bold 主题复用线性轮廓；楼层跳转将接口的 align-bottom 垂直翻转，以匹配参考图中左短右长及底部横线（接口的 align-top 不含该横线）。移除冗余的 24×24 裁剪定义，避免同页 SVG ID 冲突。楼层及蜂巢收藏心形、伴读的单线波浪下划线图标为千幕原创轮廓，不属于 Iconsax 或 Lucide 素材；波浪图标固定使用 2.5px 连续圆端线条，三个主题相同。
- 幕后采用 fire-9 烛台系列（不是同名 fire）：线性主题用用户指定的 Broken 四段轮廓并统一 2.5px，Bold/Twotone 使用官方同系列样式。
- 用户指定的 Iconsax SVG 附件按实际轮廓保留：幕外采用 gift13（线性）、gift6（实心）、gift8（双色）的蝴蝶结爱心礼盒，内部同归 gift-9；附件编号不当作官方接口编号。配音采用三份 microphone，专注采用 notification 的 Bold/Twotone，经典复用同一双色轮廓并移除透明度；纸间两个展开别名采用所给 maximize 四角图形。附件只在开发侧保留来源，运行包仍为内联图形，颜色改 currentColor、线性／双色描边统一 2.5px，实心根填充保留。
- 正文台词连续播放／停止采用用户附件 play.svg／stop.svg 的圆润三角及圆角方框，内部单独命名 tts-play／tts-stop，仅供连播按钮使用，三个主题均保留附件的线性形状、统一 2.5px。不替换通用播放／停止、逐条耳机或专注控件。
- 纸间的推演、世界格局与书架导入加号复用线性轮廓，纸间蜂巢原创心形使用填充；这些局部风格例外不改变图形许可或楼层收藏状态含义。
- 开发侧只读取已选的功能子集；运行时无需连接 Iconsax、图标字体或 CDN。若需在其他产品单独复用图形，请直接向 Iconsax 获取相应许可与资源。

## Lucide

Lucide Static `1.39.0` 的少量通用操作图标，保留锚点、收起、单/双勾、图钉、关闭、星标/半星、播放/停止的既有易识别轮廓，并统一至 2.5px；除上述千幕原创图形外，其余中央界面图标现使用上述 Iconsax 子集。

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
